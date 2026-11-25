import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { parsePositivePostgresBigInt } from '../common/utils/validation.util';
import { IdentityVerificationsService } from './identity-verifications.service';
import { SessionQueryDto } from './dto/session-query.dto';
import { ReviewKycSessionDto } from './dto/review-kyc-session.dto';
import { RevokeUserKycDto } from './dto/revoke-user-kyc.dto';

@Controller('identity-verifications')
export class IdentityVerificationsController {
  constructor(
    @Inject(IdentityVerificationsService)
    private readonly service: IdentityVerificationsService,
  ) { }

  private parseRequiredId(raw: unknown, fieldLabel: string): bigint {
    const parsed = parsePositivePostgresBigInt(raw);
    if (parsed === null) {
      throw new BadRequestException(`${fieldLabel} không hợp lệ (phải là số nguyên dương BIGINT)`);
    }
    return parsed;
  }

  /**
   * POST /api/v1/identity-verifications/sessions
   * Creates a new Didit verification session for the authenticated user
   */
  @Post('sessions')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createSession(@Req() req: any) {
    const userId = this.parseRequiredId(req.user?.id, 'userId');
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
    @Param('sessionId') sessionIdRaw: string,
    @Req() req: any,
  ) {
    const sessionId = this.parseRequiredId(sessionIdRaw, 'sessionId');
    const session = await this.service.getSession(sessionId, req.user);

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
    @Param('sessionId') sessionIdRaw: string,
    @Req() req: any,
  ) {
    const sessionId = this.parseRequiredId(sessionIdRaw, 'sessionId');
    const result = await this.service.getDecision(sessionId, req.user);

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
   * POST /api/v1/identity-verifications/sessions/:sessionId/review
   * Admin manual review endpoint for IN_REVIEW sessions (NAME_MISMATCH / explicit DECLINE)
   */
  @Post('sessions/:sessionId/review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @HttpCode(HttpStatus.OK)
  async reviewSession(
    @Param('sessionId') sessionIdRaw: string,
    @Body() dto: ReviewKycSessionDto,
    @Req() req: any,
  ) {
    const sessionId = this.parseRequiredId(sessionIdRaw, 'sessionId');
    const result = await this.service.reviewSession(sessionId, req.user, dto);

    return {
      success: true,
      message: 'Cập nhật kết quả xét duyệt phiên KYC thành công',
      data: result,
    };
  }

  /**
   * POST /api/v1/identity-verifications/users/:userId/revoke
   * Audited admin revocation for dispute / account transfer resolution (releases unique CCCD hash)
   */
  @Post('users/:userId/revoke')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @HttpCode(HttpStatus.OK)
  async revokeUserIdentity(
    @Param('userId') userIdRaw: string,
    @Body() dto: RevokeUserKycDto,
    @Req() req: any,
  ) {
    const targetUserId = this.parseRequiredId(userIdRaw, 'userId');
    const result = await this.service.revokeUserIdentity(targetUserId, req.user, dto);

    return {
      success: true,
      message: 'Thu hồi trạng thái định danh tài khoản thành công',
      data: result,
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
    @Param('sessionId') sessionIdRaw: string,
    @Req() req: any,
  ) {
    const sessionId = this.parseRequiredId(sessionIdRaw, 'sessionId');
    const result = await this.service.deleteSession(sessionId, req.user);

    return {
      success: true,
      message: result.message,
      data: null,
    };
  }
}
