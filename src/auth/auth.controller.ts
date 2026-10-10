import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Request,
  Inject,
  HttpCode,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
  ResendVerificationDto,
  RefreshTokenDto,
  GoogleLoginDto,
} from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @UseGuards(AuthRateLimitGuard)
  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.authService.register(body);
  }

  @UseGuards(AuthRateLimitGuard)
  @HttpCode(200)
  @Post('google-login')
  googleLogin(@Body() body: GoogleLoginDto, @Request() req: any) {
    const ip =
      req.headers['x-forwarded-for']?.toString()?.split(',')[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent']?.toString();
    return this.authService.googleLogin(body.token, ip, userAgent);
  }

  @UseGuards(AuthRateLimitGuard)
  @HttpCode(200)
  @Post('login')
  login(@Body() body: LoginDto, @Request() req: any) {
    const ip =
      req.headers['x-forwarded-for']?.toString()?.split(',')[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent']?.toString();
    return this.authService.login(body, ip, userAgent);
  }

  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() body: RefreshTokenDto, @Request() req: any) {
    const ip =
      req.headers['x-forwarded-for']?.toString()?.split(',')[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent']?.toString();
    return this.authService.refresh(body.refreshToken, ip, userAgent);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @Post('logout')
  async logout(@Request() req: any, @Body() body: { refreshToken?: string }) {
    const authHeader = req.headers['authorization']?.toString();
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7).trim() : undefined;
    const userId = req.user?.id || req.user?.userId;
    return this.authService.logout(userId, body?.refreshToken, accessToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: any) {
    return this.authService.getMe(req.user.id || req.user.userId);
  }

  @UseGuards(AuthRateLimitGuard)
  @Get('check-email')
  checkEmail(@Query('email') email: string) {
    return this.authService.checkEmail(email || '');
  }

  @UseGuards(AuthRateLimitGuard)
  @Get('check-username')
  checkUsername(@Query('username') username: string) {
    return this.authService.checkUsername(username || '');
  }

  @UseGuards(AuthRateLimitGuard)
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body);
  }

  @UseGuards(AuthRateLimitGuard)
  @HttpCode(200)
  @Post('reset-password')
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body);
  }

  @UseGuards(AuthRateLimitGuard)
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@Body() body: VerifyEmailDto) {
    return this.authService.verifyEmail(body);
  }

  @UseGuards(AuthRateLimitGuard)
  @HttpCode(200)
  @Post('resend-verification')
  resendVerification(@Body() body: ResendVerificationDto) {
    return this.authService.resendVerification(body);
  }
}
