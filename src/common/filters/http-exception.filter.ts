import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Đã có lỗi nội bộ xảy ra trên máy chủ';
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let errors: any = undefined;
    let data: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;
        message = resObj.message || message;
        errorCode = resObj.code || resObj.errorCode || resObj.error || `HTTP_${status}`;
        if (resObj.data !== undefined) {
          data = resObj.data;
        }
        if (Array.isArray(resObj.message)) {
          errors = resObj.message;
          message = resObj.message[0] || message;
        } else if (resObj.errors) {
          errors = resObj.errors;
        }
      }
    } else if (exception instanceof Error) {
      const errAny = exception as any;
      if (errAny.name === 'ZodError' || Array.isArray(errAny.issues)) {
        status = HttpStatus.BAD_REQUEST;
        message = 'Dữ liệu đầu vào không hợp lệ';
        errorCode = 'VALIDATION_ERROR';
        errors = errAny.issues?.map((i: any) => ({
          field: Array.isArray(i.path) ? i.path.join('.') : String(i.path),
          message: i.message,
        })) || [];
        if (errors.length > 0 && errors[0].message) {
          message = errors[0].message;
        }
      } else if (
        errAny.status === 413 ||
        errAny.statusCode === 413 ||
        errAny.type === 'entity.too.large' ||
        errAny.name === 'PayloadTooLargeError' ||
        exception.message?.toLowerCase().includes('entity too large') ||
        exception.message?.toLowerCase().includes('payload too large')
      ) {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message = 'Kích thước dữ liệu gửi lên vượt quá giới hạn cho phép (Payload Too Large: tối đa 10kb)';
        errorCode = 'PAYLOAD_TOO_LARGE';
      } else if (
        exception instanceof SyntaxError &&
        typeof exception.message === 'string' &&
        /Cannot convert .* to a BigInt/i.test(exception.message)
      ) {
        status = HttpStatus.BAD_REQUEST;
        errorCode = 'INVALID_ID_FORMAT';
        message = 'Định dạng mã định danh (ID) không hợp lệ';
      } else {
        const isPrismaKnownError = errAny.name === 'PrismaClientKnownRequestError' || typeof errAny.code === 'string' && /^P\d{4}$/.test(errAny.code);
        if (isPrismaKnownError) {
          if (errAny.code === 'P2002') {
            status = HttpStatus.CONFLICT;
            errorCode = 'DUPLICATE_RESOURCE';
            message = 'Dữ liệu bị trùng lặp với bản ghi đã tồn tại';
          } else if (errAny.code === 'P2003') {
            status = HttpStatus.CONFLICT;
            errorCode = 'RESOURCE_IN_USE';
            message = 'Không thể thao tác do dữ liệu đang được tham chiếu bởi bản ghi khác';
          } else if (errAny.code === 'P2025') {
            status = HttpStatus.NOT_FOUND;
            errorCode = 'NOT_FOUND';
            message = 'Bản ghi không tồn tại';
          } else if (errAny.code === 'P2000' || errAny.code === 'P2020') {
            status = HttpStatus.BAD_REQUEST;
            errorCode = 'VALUE_OUT_OF_RANGE';
            message = 'Giá trị đầu vào vượt quá giới hạn độ dài hoặc phạm vi cho phép';
          }
        }

        if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
          const isPrismaError =
            errAny.name?.includes('Prisma') ||
            exception.constructor?.name?.includes('Prisma') ||
            (typeof exception.message === 'string' &&
              (exception.message.includes('prisma') ||
                exception.message.includes('The column') ||
                exception.message.includes('does not exist in the current database')));

          this.logger.error(`Unhandled Exception at ${request.method} ${request.url}: ${exception.message}`, exception.stack);

          // Security-by-Design Rule 9: Never leak internal database schema, queries, or server filesystem paths
          if (isPrismaError) {
            status = HttpStatus.INTERNAL_SERVER_ERROR;
            errorCode = 'DATABASE_ERROR';
            message = request.url.includes('bank-accounts')
              ? 'Chưa thể tải trạng thái xác minh ngân hàng. Vui lòng thử lại sau.'
              : 'Đã có lỗi xảy ra khi truy vấn dữ liệu. Vui lòng thử lại sau.';
          } else if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
            message = 'Đã có lỗi xảy ra. Vui lòng liên hệ quản trị viên hoặc thử lại sau.';
          } else {
            // In development, strip any internal file paths like /opt/render/... to prevent PII/system leak
            message = exception.message
              ? exception.message.replace(/\/opt\/render\/[^\s:]+/g, '[server-path]')
              : 'Lỗi hệ thống máy chủ';
          }
        }
      }
    }

    // Defense-in-depth: never leak third-party API keys in error messages or paths
    const safeMessage =
      typeof message === 'string'
        ? message.replace(/([?&]api_key=)[^&\s]+/gi, '$1[REDACTED]')
        : 'Đã có lỗi nội bộ xảy ra trên máy chủ';

    response.status(status).json({
      success: false,
      message: safeMessage,
      errorCode,
      code: errorCode,
      ...(data !== undefined ? { data } : {}),
      ...(errors ? { errors } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
