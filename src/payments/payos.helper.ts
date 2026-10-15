import * as crypto from 'crypto';

export interface PayosPaymentRequestParams {
  amount: number;
  cancelUrl: string;
  description: string;
  orderCode: number;
  returnUrl: string;
}

export function signPaymentRequest(params: PayosPaymentRequestParams, checksumKey: string): string {
  const raw = [
    `amount=${params.amount}`,
    `cancelUrl=${params.cancelUrl}`,
    `description=${params.description}`,
    `orderCode=${params.orderCode}`,
    `returnUrl=${params.returnUrl}`,
  ].join('&');

  return crypto
    .createHmac('sha256', checksumKey)
    .update(raw)
    .digest('hex');
}

export function sortObjDataByKey(object: Record<string, any>): Record<string, any> {
  return Object.keys(object)
    .sort()
    .reduce((obj: Record<string, any>, key: string) => {
      obj[key] = object[key];
      return obj;
    }, {});
}

export function convertObjToQueryStr(object: Record<string, any>): string {
  return Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .map((key) => {
      let value = object[key];
      if (value && Array.isArray(value)) {
        value = JSON.stringify(value.map((item) => sortObjDataByKey(item)));
      }
      if ([null, undefined, 'undefined', 'null'].includes(value)) value = '';
      return `${key}=${value}`;
    })
    .join('&');
}

export function verifyWebhookSignature(data: any, signature: string, checksumKey: string): boolean {
  if (!data || !signature || !checksumKey) return false;
  const sortedData = sortObjDataByKey(data);
  const queryString = convertObjToQueryStr(sortedData);
  const expected = crypto
    .createHmac('sha256', checksumKey)
    .update(queryString)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Deep sort object with optional array sorting (Official PayOS Payout specification)
 * @param obj Object data
 * @param sortArrays Whether to sort arrays or maintain their order
 * @returns Sorted object data
 */
export function deepSortObj(obj: any, sortArrays = false): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    if (sortArrays) {
      return obj
        .map((item) => (typeof item === 'object' && item !== null ? deepSortObj(item, sortArrays) : item))
        .sort((a, b) => {
          if (typeof a !== 'object' && typeof b !== 'object') {
            return String(a).localeCompare(String(b));
          }
          return JSON.stringify(a).localeCompare(JSON.stringify(b));
        });
    }
    return obj.map((item) => (typeof item === 'object' && item !== null ? deepSortObj(item, sortArrays) : item));
  }

  return Object.keys(obj)
    .sort()
    .reduce((acc: Record<string, any>, key: string) => {
      const value = obj[key];
      if (Array.isArray(value)) {
        if (sortArrays) {
          acc[key] = value
            .map((item) => (typeof item === 'object' && item !== null ? deepSortObj(item, sortArrays) : item))
            .sort((a, b) => {
              if (typeof a !== 'object' && typeof b !== 'object') {
                return String(a).localeCompare(String(b));
              }
              return JSON.stringify(a).localeCompare(JSON.stringify(b));
            });
        } else {
          acc[key] = value.map((item) =>
            typeof item === 'object' && item !== null ? deepSortObj(item, sortArrays) : item,
          );
        }
      } else if (typeof value === 'object' && value !== null) {
        acc[key] = deepSortObj(value, sortArrays);
      } else {
        acc[key] = value;
      }
      return acc;
    }, {});
}

export interface PayosPayoutRequestParams {
  amount: number;
  category?: string[];
  description: string;
  referenceId: string;
  toAccountNumber: string;
  toBin: string;
}

export interface PayosBatchPayoutRequestParams {
  category?: string[];
  payouts: Array<{
    amount: number;
    description: string;
    referenceId: string;
    toAccountNumber: string;
    toBin: string;
  }>;
  referenceId: string;
  validateDestination?: boolean;
}

/**
 * Builds encoded query string for PayOS Payout signature according to PayOS specification:
 * key1=encodeURI(value1)&key2=encodeURI(value2)...
 */
export function buildPayoutQueryString(data: Record<string, any>): string {
  const sortedData = deepSortObj(data, false);
  return Object.keys(sortedData)
    .map((key) => {
      let value = sortedData[key];
      if (Array.isArray(value)) {
        value = JSON.stringify(value);
      } else if (typeof value === 'object' && value !== null) {
        value = JSON.stringify(value);
      }
      if (value === null || value === undefined) {
        value = '';
      }
      return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
    })
    .join('&');
}

/**
 * Signs payout request data with HMAC-SHA256 according to PayOS payout rules.
 * Separate from payment request signing as required by PayOS.
 */
export function signPayoutRequest(params: Record<string, any>, checksumKey: string): string {
  const queryString = buildPayoutQueryString(params);
  return crypto
    .createHmac('sha256', checksumKey)
    .update(queryString)
    .digest('hex');
}

/**
 * Verifies payout webhook or response signature from PayOS.
 */
export function verifyPayoutSignature(data: any, signature: string, checksumKey: string): boolean {
  if (!data || !signature || !checksumKey) return false;
  const expected = signPayoutRequest(data, checksumKey);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
