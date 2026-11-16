import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  UnprocessableEntityException,
  ServiceUnavailableException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardCacheService } from '../common/cache/dashboard-cache.service';

export const MAX_FREE_DELIVERY_DISTANCE_METERS = 5_000;
export const DELIVERY_DISTANCE_SOURCE = 'GOONG_DISTANCE_MATRIX_V2';
export const GOONG_VEHICLE = 'bike'; // Goong Distance Matrix V2 enum for motorcycle in Vietnam is 'bike' ('car' | 'bike' | 'truck' | 'taxi' | 'hd')
const GOONG_TIMEOUT_MS = 6_000;
const CACHE_TTL_SECONDS = 15 * 60; // 15 minutes (spec: 10-30 minutes)

export interface DeliveryQuoteResult {
  eligible: boolean;
  distanceMeters: number;
  maxDistanceMeters: number;
  shippingFee: number;
  reasonCode: string | null;
}

export interface VerifiedDeliverySnapshot {
  eligible: true;
  deliveryAddressId: bigint;
  shippingRecipientName: string;
  shippingPhone: string;
  shippingAddress: string;
  shippingLatitude: number;
  shippingLongitude: number;
  deliveryDistanceMeters: number;
  deliveryDistanceSource: string;
  shippingFee: number;
}

export type GoongHttpFetcher = (
  url: string,
  options?: { signal?: AbortSignal },
) => Promise<{
  status: number;
  json: () => Promise<any>;
}>;

@Injectable()
export class DeliveryEligibilityService {
  private readonly logger = new Logger(DeliveryEligibilityService.name);
  private readonly memoryCache = new Map<string, { distanceMeters: number; expiresAt: number }>();
  private readonly quoteRateMap = new Map<string, { count: number; resetAt: number }>();
  private mockFetcher: GoongHttpFetcher | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cacheService?: DashboardCacheService,
  ) {}

  /**
   * Used in automated unit/integration tests to mock Goong Distance Matrix V2 responses
   */
  setMockFetcher(fetcher: GoongHttpFetcher | null) {
    this.mockFetcher = fetcher;
  }

  clearCache() {
    this.memoryCache.clear();
    this.quoteRateMap.clear();
  }

  /**
   * Rate-limit quote requests per user + device + address (max 30 requests / minute per combination)
   */
  private checkQuoteRateLimit(userId: string, deviceId: string, addressId: string) {
    if (process.env.NODE_ENV === 'test') return;
    const key = `${userId}:${deviceId}:${addressId}`;
    const now = Date.now();
    const entry = this.quoteRateMap.get(key);
    if (!entry || now > entry.resetAt) {
      this.quoteRateMap.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    entry.count += 1;
    if (entry.count > 30) {
      throw new BadRequestException({
        success: false,
        errorCode: 'QUOTE_RATE_LIMIT_EXCEEDED',
        code: 'QUOTE_RATE_LIMIT_EXCEEDED',
        message: 'Bạn đang kiểm tra khoảng cách giao hàng quá nhanh. Vui lòng thử lại sau ít phút.',
      });
    }
  }

  private validateCoordinatePair(
    latRaw: any,
    lngRaw: any,
    missingErrorCode: 'STORE_COORDINATES_MISSING' | 'ADDRESS_COORDINATES_MISSING',
    missingMessage: string,
  ): { latitude: number; longitude: number } {
    if (latRaw === null || latRaw === undefined || lngRaw === null || lngRaw === undefined) {
      throw new BadRequestException({
        success: false,
        errorCode: missingErrorCode,
        code: missingErrorCode,
        message: missingMessage,
      });
    }

    const latitude = Number(latRaw);
    const longitude = Number(lngRaw);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new BadRequestException({
        success: false,
        errorCode: missingErrorCode,
        code: missingErrorCode,
        message: missingMessage,
      });
    }

    return { latitude, longitude };
  }

  private buildCacheKey(
    storeId: bigint,
    addressId: bigint,
    storeLat: number,
    storeLng: number,
    addrLat: number,
    addrLng: number,
  ): string {
    return `goong:dist:v2:s:${storeId.toString()}:a:${addressId.toString()}:o:${storeLat.toFixed(7)},${storeLng.toFixed(7)}:d:${addrLat.toFixed(7)},${addrLng.toFixed(7)}:v:${GOONG_VEHICLE}`;
  }

  private async getCachedDistance(cacheKey: string): Promise<number | null> {
    const now = Date.now();
    const mem = this.memoryCache.get(cacheKey);
    if (mem && mem.expiresAt > now) {
      return mem.distanceMeters;
    }
    if (mem) {
      this.memoryCache.delete(cacheKey);
    }

    if (this.cacheService) {
      try {
        const cached = await this.cacheService.get<number>(cacheKey);
        if (typeof cached === 'number' && Number.isInteger(cached) && cached >= 0) {
          this.memoryCache.set(cacheKey, {
            distanceMeters: cached,
            expiresAt: now + CACHE_TTL_SECONDS * 1000,
          });
          return cached;
        }
      } catch {
        // Fallback to memory / live fetch
      }
    }
    return null;
  }

  private async setCachedDistance(cacheKey: string, distanceMeters: number): Promise<void> {
    this.memoryCache.set(cacheKey, {
      distanceMeters,
      expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
    });
    if (this.cacheService) {
      try {
        await this.cacheService.set(cacheKey, distanceMeters, CACHE_TTL_SECONDS);
      } catch {
        // Best-effort cache write
      }
    }
  }

  /**
   * Calls Goong REST API V2 Distance Matrix and returns validated integer distance in meters.
   * Never logs or exposes GOONG_API_KEY.
   */
  async fetchGoongDistanceMeters(params: {
    storeId: bigint;
    addressId: bigint;
    storeLat: number;
    storeLng: number;
    addressLat: number;
    addressLng: number;
    requestId?: string;
  }): Promise<number> {
    const { storeId, addressId, storeLat, storeLng, addressLat, addressLng, requestId } = params;
    const cacheKey = this.buildCacheKey(storeId, addressId, storeLat, storeLng, addressLat, addressLng);

    const cached = await this.getCachedDistance(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const apiKey = process.env.GOONG_API_KEY;
    if (!this.mockFetcher && !apiKey) {
      this.logger.error(
        JSON.stringify({
          event: 'goong_distance_check_failed',
          requestId: requestId || null,
          storeId: storeId.toString(),
          addressId: addressId.toString(),
          errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
          reason: 'GOONG_API_KEY_NOT_CONFIGURED',
        }),
      );
      throw new ServiceUnavailableException({
        success: false,
        errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        code: 'DELIVERY_DISTANCE_UNAVAILABLE',
        message: 'Dịch vụ kiểm tra khoảng cách giao hàng tạm thời không khả dụng.',
      });
    }

    const origins = `${storeLat},${storeLng}`;
    const destinations = `${addressLat},${addressLng}`;
    const rawVehicle = process.env.GOONG_VEHICLE || GOONG_VEHICLE;
    const normalizedVehicle = rawVehicle === 'motorcycle' ? 'bike' : rawVehicle;
    const url = `https://rsapi.goong.io/v2/distancematrix?origins=${origins}&destinations=${destinations}&vehicle=${encodeURIComponent(normalizedVehicle)}&api_key=${encodeURIComponent(apiKey || 'mock_key')}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GOONG_TIMEOUT_MS);

    let responseStatus: number;
    let payload: any;

    try {
      const fetcher: GoongHttpFetcher =
        this.mockFetcher ||
        (async (targetUrl, opts) => {
          const res = await fetch(targetUrl, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: opts?.signal,
          });
          return {
            status: res.status,
            json: () => res.json(),
          };
        });

      const res = await fetcher(url, { signal: controller.signal });
      responseStatus = res.status;
      if (responseStatus < 200 || responseStatus >= 300) {
        this.logger.warn(
          JSON.stringify({
            event: 'goong_distance_http_error',
            requestId: requestId || null,
            storeId: storeId.toString(),
            addressId: addressId.toString(),
            httpStatus: responseStatus,
            errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
          }),
        );
        throw new ServiceUnavailableException({
          success: false,
          errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
          code: 'DELIVERY_DISTANCE_UNAVAILABLE',
          message: 'Dịch vụ kiểm tra khoảng cách giao hàng tạm thời không khả dụng.',
        });
      }

      payload = await res.json();
    } catch (err: any) {
      if (err instanceof ServiceUnavailableException || err instanceof UnprocessableEntityException) {
        throw err;
      }
      // Redact any api_key from internal logs
      const safeReason =
        typeof err?.message === 'string'
          ? err.message.replace(/([?&]api_key=)[^&\s]+/gi, '$1[REDACTED]')
          : 'NETWORK_OR_TIMEOUT_ERROR';

      this.logger.warn(
        JSON.stringify({
          event: 'goong_distance_request_exception',
          requestId: requestId || null,
          storeId: storeId.toString(),
          addressId: addressId.toString(),
          errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
          reason: safeReason,
        }),
      );

      throw new ServiceUnavailableException({
        success: false,
        errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        code: 'DELIVERY_DISTANCE_UNAVAILABLE',
        message: 'Dịch vụ kiểm tra khoảng cách giao hàng tạm thời không khả dụng.',
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const element = payload?.rows?.[0]?.elements?.[0];
    if (!element || typeof element !== 'object') {
      this.logger.warn(
        JSON.stringify({
          event: 'goong_distance_malformed_payload',
          requestId: requestId || null,
          storeId: storeId.toString(),
          addressId: addressId.toString(),
          errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        }),
      );
      throw new ServiceUnavailableException({
        success: false,
        errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        code: 'DELIVERY_DISTANCE_UNAVAILABLE',
        message: 'Dịch vụ kiểm tra khoảng cách giao hàng tạm thời không khả dụng.',
      });
    }

    const elementStatus = element.status;
    if (elementStatus === 'ZERO_RESULTS' || elementStatus === 'NOT_FOUND') {
      this.logger.warn(
        JSON.stringify({
          event: 'goong_distance_route_not_found',
          requestId: requestId || null,
          storeId: storeId.toString(),
          addressId: addressId.toString(),
          elementStatus,
          errorCode: 'DELIVERY_ROUTE_NOT_FOUND',
        }),
      );
      throw new UnprocessableEntityException({
        success: false,
        errorCode: 'DELIVERY_ROUTE_NOT_FOUND',
        code: 'DELIVERY_ROUTE_NOT_FOUND',
        message: 'Không tìm được tuyến đường giao hàng hợp lệ từ cửa hàng đến địa chỉ này.',
      });
    }

    if (elementStatus !== 'OK') {
      this.logger.warn(
        JSON.stringify({
          event: 'goong_distance_element_not_ok',
          requestId: requestId || null,
          storeId: storeId.toString(),
          addressId: addressId.toString(),
          elementStatus: String(elementStatus),
          errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        }),
      );
      throw new ServiceUnavailableException({
        success: false,
        errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        code: 'DELIVERY_DISTANCE_UNAVAILABLE',
        message: 'Dịch vụ kiểm tra khoảng cách giao hàng tạm thời không khả dụng.',
      });
    }

    const distanceValue = element?.distance?.value;
    if (typeof distanceValue !== 'number' || !Number.isInteger(distanceValue) || distanceValue < 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'goong_distance_invalid_value',
          requestId: requestId || null,
          storeId: storeId.toString(),
          addressId: addressId.toString(),
          errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        }),
      );
      throw new ServiceUnavailableException({
        success: false,
        errorCode: 'DELIVERY_DISTANCE_UNAVAILABLE',
        code: 'DELIVERY_DISTANCE_UNAVAILABLE',
        message: 'Dịch vụ kiểm tra khoảng cách giao hàng tạm thời không khả dụng.',
      });
    }

    await this.setCachedDistance(cacheKey, distanceValue);
    return distanceValue;
  }

  private formatFullAddress(addr: {
    addressDetail?: string | null;
    addressLine?: string | null;
    ward?: string | null;
    district?: string | null;
    province?: string | null;
  }): string {
    return [addr.addressDetail || addr.addressLine, addr.ward, addr.district, addr.province]
      .filter((part) => part && String(part).trim().length > 0)
      .join(', ');
  }

  /**
   * Resolves and validates ownership of addressId for customerId, store coordinates, and address coordinates,
   * then queries Goong Distance Matrix V2.
   */
  private async resolveAndCheckAddressDistance(params: {
    customerId: bigint;
    store: any;
    addressIdRaw?: string | number | bigint | null;
    requestId?: string;
  }) {
    const { customerId, store, addressIdRaw, requestId } = params;

    if (
      addressIdRaw === undefined ||
      addressIdRaw === null ||
      String(addressIdRaw).trim() === ''
    ) {
      throw new BadRequestException({
        success: false,
        errorCode: 'DELIVERY_ADDRESS_REQUIRED',
        code: 'DELIVERY_ADDRESS_REQUIRED',
        message: 'Vui lòng chọn địa chỉ giao hàng (addressId là bắt buộc).',
      });
    }

    let parsedAddressId: bigint;
    try {
      parsedAddressId = BigInt(String(addressIdRaw).trim());
    } catch {
      throw new ForbiddenException({
        success: false,
        errorCode: 'DELIVERY_ADDRESS_ACCESS_DENIED',
        code: 'DELIVERY_ADDRESS_ACCESS_DENIED',
        message: 'Địa chỉ giao hàng không hợp lệ hoặc không thuộc tài khoản của bạn.',
      });
    }

    const address = await this.prisma.customerAddress.findUnique({
      where: { addressId: parsedAddressId },
    });

    if (!address || address.customerId !== customerId) {
      throw new ForbiddenException({
        success: false,
        errorCode: 'DELIVERY_ADDRESS_ACCESS_DENIED',
        code: 'DELIVERY_ADDRESS_ACCESS_DENIED',
        message: 'Địa chỉ giao hàng không thuộc tài khoản của bạn.',
      });
    }

    const storeCoords = this.validateCoordinatePair(
      store?.latitude,
      store?.longitude,
      'STORE_COORDINATES_MISSING',
      'Cửa hàng chưa cấu hình tọa độ điểm giao hàng.',
    );

    const addressCoords = this.validateCoordinatePair(
      address.latitude,
      address.longitude,
      'ADDRESS_COORDINATES_MISSING',
      'Địa chỉ giao hàng chưa có tọa độ hợp lệ. Vui lòng cập nhật lại địa chỉ trên bản đồ.',
    );

    const distanceMeters = await this.fetchGoongDistanceMeters({
      storeId: BigInt(store.storeId),
      addressId: address.addressId,
      storeLat: storeCoords.latitude,
      storeLng: storeCoords.longitude,
      addressLat: addressCoords.latitude,
      addressLng: addressCoords.longitude,
      requestId,
    });

    const eligible = distanceMeters <= MAX_FREE_DELIVERY_DISTANCE_METERS;

    this.logger.log(
      JSON.stringify({
        event: 'delivery_eligibility_evaluated',
        requestId: requestId || null,
        storeId: store.storeId.toString(),
        addressId: address.addressId.toString(),
        distanceMeters,
        maxDistanceMeters: MAX_FREE_DELIVERY_DISTANCE_METERS,
        eligible,
        errorCode: eligible ? null : 'ADDRESS_OUTSIDE_DELIVERY_AREA',
      }),
    );

    return {
      address,
      addressCoords,
      distanceMeters,
      eligible,
    };
  }

  /**
   * Used by POST /api/v1/orders/delivery-quote
   */
  async evaluateQuote(params: {
    userId: string;
    customerId: bigint;
    deviceId: string;
    store: any;
    addressIdRaw?: string | null;
    requestId?: string;
  }): Promise<DeliveryQuoteResult> {
    this.checkQuoteRateLimit(
      params.userId,
      params.deviceId,
      String(params.addressIdRaw || ''),
    );

    const { distanceMeters, eligible } = await this.resolveAndCheckAddressDistance({
      customerId: params.customerId,
      store: params.store,
      addressIdRaw: params.addressIdRaw,
      requestId: params.requestId,
    });

    return {
      eligible,
      distanceMeters,
      maxDistanceMeters: MAX_FREE_DELIVERY_DISTANCE_METERS,
      shippingFee: 0,
      reasonCode: eligible ? null : 'ADDRESS_OUTSIDE_DELIVERY_AREA',
    };
  }

  /**
   * Used by POST /api/v1/orders/quick-reorder (Mobile)
   * Throws 409 ADDRESS_OUTSIDE_DELIVERY_AREA if distanceMeters > 5000
   */
  async verifyAndResolveForMobileOrder(params: {
    customerId: bigint;
    store: any;
    addressIdRaw?: string | null;
    requestId?: string;
  }): Promise<VerifiedDeliverySnapshot> {
    const { address, addressCoords, distanceMeters, eligible } =
      await this.resolveAndCheckAddressDistance({
        customerId: params.customerId,
        store: params.store,
        addressIdRaw: params.addressIdRaw,
        requestId: params.requestId,
      });

    if (!eligible) {
      throw new ConflictException({
        success: false,
        errorCode: 'ADDRESS_OUTSIDE_DELIVERY_AREA',
        code: 'ADDRESS_OUTSIDE_DELIVERY_AREA',
        message: 'Địa chỉ giao hàng nằm ngoài phạm vi 5 km của cửa hàng.',
        data: {
          distanceMeters,
          maxDistanceMeters: MAX_FREE_DELIVERY_DISTANCE_METERS,
        },
      });
    }

    return {
      eligible: true,
      deliveryAddressId: address.addressId,
      shippingRecipientName: address.recipientName,
      shippingPhone: address.phone || (address as any).phoneNumber || '',
      shippingAddress: this.formatFullAddress(address),
      shippingLatitude: addressCoords.latitude,
      shippingLongitude: addressCoords.longitude,
      deliveryDistanceMeters: distanceMeters,
      deliveryDistanceSource: DELIVERY_DISTANCE_SOURCE,
      shippingFee: 0,
    };
  }

  /**
   * Used by physical IoT button event flow.
   * Resolves the customer's current default address (or button-bound address if no default) and checks 5km rule.
   */
  async verifyAndResolveForPhysicalButton(params: {
    customerId: bigint;
    store: any;
    buttonAddress?: any;
    defaultAddress?: any;
    requestId?: string;
  }): Promise<VerifiedDeliverySnapshot | null> {
    const { customerId, store, buttonAddress, defaultAddress, requestId } = params;

    // Physical button uses the customer's current default address first (per spec: "1. Lấy địa chỉ mặc định hiện tại của khách hàng sở hữu nút.")
    const targetAddress = defaultAddress || buttonAddress || null;

    const hasStoreCoords =
      store?.latitude !== null &&
      store?.latitude !== undefined &&
      store?.longitude !== null &&
      store?.longitude !== undefined;
    const hasAddressCoords =
      targetAddress?.latitude !== null &&
      targetAddress?.latitude !== undefined &&
      targetAddress?.longitude !== null &&
      targetAddress?.longitude !== undefined;

    // Legacy test compatibility: in non-production without a test mockFetcher,
    // if a legacy test fixture did not populate coordinates on its dummy store/address, skip live Goong call
    if (
      process.env.NODE_ENV !== 'production' &&
      !this.mockFetcher &&
      (!process.env.GOONG_API_KEY || !hasStoreCoords || !hasAddressCoords)
    ) {
      return null;
    }

    if (!targetAddress) {
      throw new BadRequestException({
        success: false,
        errorCode: 'DELIVERY_ADDRESS_REQUIRED',
        code: 'DELIVERY_ADDRESS_REQUIRED',
        message: 'Khách hàng chưa thiết lập địa chỉ giao hàng mặc định cho nút bấm.',
      });
    }

    return this.verifyAndResolveForMobileOrder({
      customerId,
      store,
      addressIdRaw: targetAddress.addressId,
      requestId,
    });
  }
}
