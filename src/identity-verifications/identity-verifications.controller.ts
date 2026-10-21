import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { IdentityVerificationsService } from './identity-verifications.service';
import { SessionQueryDto } from './dto/session-query.dto';

@Controller('identity-verifications')
export class IdentityVerificationsController {
  constructor(private readonly service: IdentityVerificationsService) {}

  /**
   * POST /api/v1/identity-verifications/sessions
   * Creates a new Didit verification session for the authenticated user
   */
  @Post('sessions')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createSession(@Req() req: any) {
    const userId = BigInt(req.user.id);
    const session = await this.service.createSession(userId);

    return {
      success: true,
      message: 'Phiên xác minh danh tính đã được tạo thành công',
      data: session,
    };
  }

  /**
   * GET /api/v1/identity-verifications/sessions/:sessionId
   * Retrieves status and details of a session (BOLA protected)
   */
  @Get('sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  async getSession(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Req() req: any,
  ) {
    const session = await this.service.getSession(BigInt(sessionId), req.user);

    return {
      success: true,
      message: 'Lấy thông tin phiên xác minh thành công',
      data: session,
    };
  }

  /**
   * GET /api/v1/identity-verifications/sessions/:sessionId/decision
   * Server-to-server fallback querying Didit decision API
   */
  @Get('sessions/:sessionId/decision')
  @UseGuards(JwtAuthGuard)
  async getDecision(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Req() req: any,
  ) {
    const result = await this.service.getDecision(BigInt(sessionId), req.user);

    return {
      success: true,
      message: 'Lấy kết quả đối chiếu Didit thành công',
      data: result,
    };
  }

  /**
   * GET /api/v1/identity-verifications/sessions?page=1&pageSize=20
   * Lists verification sessions with pagination (user scoped, admin sees all)
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(
    @Req() req: any,
    @Query() query: SessionQueryDto,
  ) {
    const result = await this.service.listSessions(
      req.user,
      query.page || 1,
      query.pageSize || 20,
    );

    return {
      success: true,
      message: 'Lấy danh sách phiên xác minh thành công',
      data: result.data,
      pagination: result.pagination,
    };
  }

  /**
   * DELETE /api/v1/identity-verifications/sessions/:sessionId
   * Safe delete session: calls Didit delete first, then soft-deletes locally (Admin only)
   */
  @Delete('sessions/:sessionId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  async deleteSession(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Req() req: any,
  ) {
    const result = await this.service.deleteSession(BigInt(sessionId), req.user);

    return {
      success: true,
      message: result.message,
      data: null,
    };
  }
}
