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

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;
        message = resObj.message || message;
        errorCode = resObj.code || resObj.errorCode || resObj.error || `HTTP_${status}`;
        if (Array.isArray(resObj.message)) {
          errors = resObj.message;
          message = resObj.message[0] || message;
        } else if (resObj.errors) {
          errors = resObj.errors;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled Exception at ${request.method} ${request.url}: ${exception.message}`, exception.stack);
      
      // Protect sensitive database/server errors in production
      if (process.env.NODE_ENV === 'production') {
        message = 'Đã có lỗi xảy ra. Vui lòng liên hệ quản trị viên hoặc thử lại sau.';
      } else {
        message = exception.message;
      }
    }

    response.status(status).json({
      success: false,
      message,
      errorCode,
      code: errorCode,
      ...(errors ? { errors } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
