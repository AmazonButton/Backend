import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Auth } from 'firebase-admin/auth';
import { FIREBASE_ADMIN } from './firebase-admin.provider';
import { AuthRepository } from './auth.repository';

export interface PhoneVerificationResult {
  phoneNumber: string;
  firebaseUid: string;
  verifiedAt: Date;
}

@Injectable()
export class FirebasePhoneService {
  private readonly logger = new Logger(FirebasePhoneService.name);

  constructor(
    @Inject(FIREBASE_ADMIN)
    private readonly firebaseAuth: Auth,
    @Inject(AuthRepository)
    private readonly authRepo: AuthRepository,
  ) {}

  async verifyPhoneToken(firebaseIdToken: string, userId: bigint): Promise<PhoneVerificationResult> {
    if (!firebaseIdToken || typeof firebaseIdToken !== 'string' || !firebaseIdToken.trim()) {
      throw new BadRequestException('Firebase ID token is required');
    }

    let decodedToken: any;

    try {
      // Security Check: verifyIdToken(..., true) verifies signature and checks if token is revoked
      decodedToken = await this.firebaseAuth.verifyIdToken(firebaseIdToken.trim(), true);
    } catch (err: any) {
      // Security Invariant: Never log raw tokens or sensitive credential traces
      this.logger.warn(`Firebase token verification failed: ${err?.message || 'Invalid or revoked token'}`);
      throw new UnauthorizedException('Invalid Firebase ID token');
    }

    // Security Check: Verify provider is strictly 'phone'
    const provider = decodedToken.firebase?.sign_in_provider;
    if (provider !== 'phone') {
      throw new UnauthorizedException('Token is not from Firebase phone authentication');
    }

    // Security Check: Extract trusted phone number directly from decoded token
    const phoneNumber = decodedToken.phone_number;
    if (!phoneNumber) {
      throw new UnauthorizedException('Firebase token does not contain a phone number');
    }

    // Security Check: Verify project ID matches if configured on backend
    const expectedProjectId = process.env.FIREBASE_PROJECT_ID;
    if (
      expectedProjectId &&
      decodedToken.aud !== expectedProjectId &&
      decodedToken.firebase?.project_id !== expectedProjectId
    ) {
      throw new UnauthorizedException('Firebase token project mismatch');
    }

    const firebaseUid = decodedToken.uid;
    const verifiedAt = new Date();

    // Check if this Firebase UID is already linked to another account
    const existingUserWithUid = await this.authRepo.findByFirebaseUid(firebaseUid);
    if (existingUserWithUid && existingUserWithUid.userId !== userId) {
      throw new ConflictException('Số điện thoại này đã được liên kết với một tài khoản khác');
    }

    // Update user in PostgreSQL database via Repository with concurrency / race-condition safety
    try {
      await this.authRepo.updatePhoneVerification(
        userId,
        phoneNumber,
        firebaseUid,
        verifiedAt,
      );
    } catch (error: any) {
      if (
        error?.code === 'P2002' ||
        error?.message?.includes('uq_users_firebase_uid') ||
        error?.message?.includes('Unique constraint failed')
      ) {
        throw new ConflictException(
          'Số điện thoại hoặc tài khoản Firebase này đã được liên kết với một tài khoản khác trong hệ thống.',
        );
      }
      throw error;
    }

    return {
      phoneNumber,
      firebaseUid,
      verifiedAt,
    };
  }
}
