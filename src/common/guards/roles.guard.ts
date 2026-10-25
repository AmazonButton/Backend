import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new ForbiddenException('Yêu cầu đăng nhập để truy cập tài nguyên này');
    }

    if (user.role === 'SUPER_ADMIN' || user.role === 'SYSTEM_ADMIN' || requiredRoles.includes(user.role)) {
      return true;
    }

    throw new ForbiddenException(
      `Bạn không có quyền thực hiện hành động này. Vai trò yêu cầu: ${requiredRoles.join(', ')}`,
    );
  }
}
