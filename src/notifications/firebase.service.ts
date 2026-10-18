import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

export interface SendPushResult {
  successTokens: string[];
  invalidTokens: string[];
  failureCount: number;
}

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private firebaseApp: admin.app.App | null = null;
  private isMockMode = false;

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    try {
      const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './secrets/firebase-service-account.json';
      const resolvedPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);

      if (fs.existsSync(resolvedPath)) {
        const fileContent = fs.readFileSync(resolvedPath, 'utf8').trim();
        if (fileContent.startsWith('{') && fileContent.includes('private_key')) {
          const serviceAccount = JSON.parse(fileContent);
          
          // Avoid re-initialization error if already created
          const appName = 'SOB_FIREBASE_APP';
          const existingApp = admin.apps.find((app) => app?.name === appName);
          if (existingApp) {
            this.firebaseApp = existingApp;
          } else {
            this.firebaseApp = admin.initializeApp(
              {
                credential: admin.credential.cert(serviceAccount),
              },
              appName,
            );
          }
          this.logger.log(`[FirebaseAdmin] Successfully initialized Firebase Admin SDK from ${resolvedPath}`);
          return;
        }
      }

      this.logger.warn(
        `[FirebaseAdmin] Service account file not found or invalid at ${resolvedPath}. FCM Push Notifications will operate in graceful fallback / simulation mode.`,
      );
      this.isMockMode = true;
    } catch (err: any) {
      this.logger.error(`[FirebaseAdmin] Error initializing Firebase Admin: ${err.message}`, err.stack);
      this.isMockMode = true;
    }
  }

  get isInitialized(): boolean {
    return this.firebaseApp !== null && !this.isMockMode;
  }

  /**
   * Gui multicast push notification toi danh sach tokens.
   * Tu dong phan loai token thanh cong va token loi/khong hop le de he thong tu dong don dep.
   */
  async sendMulticast(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<SendPushResult> {
    if (!tokens || tokens.length === 0) {
      return { successTokens: [], invalidTokens: [], failureCount: 0 };
    }

    const uniqueTokens = Array.from(new Set(tokens.filter((t) => typeof t === 'string' && t.trim().length > 0)));
    if (uniqueTokens.length === 0) {
      return { successTokens: [], invalidTokens: [], failureCount: 0 };
    }

    // Neu dang chay trong che do fallback / mock
    if (!this.firebaseApp || this.isMockMode) {
      this.logger.debug(
        `[FirebaseAdmin Mock] Simulated push to ${uniqueTokens.length} tokens: Title="${title}", Body="${body}"`,
      );
      const invalidTokens: string[] = [];
      const successTokens: string[] = [];

      for (const token of uniqueTokens) {
        if (token.startsWith('expired_') || token.startsWith('invalid_') || token.includes('NOT_REGISTERED')) {
          invalidTokens.push(token);
        } else {
          successTokens.push(token);
        }
      }

      return {
        successTokens,
        invalidTokens,
        failureCount: invalidTokens.length,
      };
    }

    try {
      const messaging = this.firebaseApp.messaging();
      const message: admin.messaging.MulticastMessage = {
        tokens: uniqueTokens,
        notification: {
          title,
          body,
        },
        data: data || {},
      };

      const response = await messaging.sendEachForMulticast(message);
      const successTokens: string[] = [];
      const invalidTokens: string[] = [];

      const invalidErrorCodes = [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered',
        'messaging/invalid-argument',
      ];

      response.responses.forEach((resp, idx) => {
        const token = uniqueTokens[idx];
        if (resp.success) {
          successTokens.push(token);
        } else {
          const errorCode = resp.error?.code || '';
          if (invalidErrorCodes.includes(errorCode)) {
            invalidTokens.push(token);
          }
        }
      });

      this.logger.log(
        `[FirebaseAdmin] Multicast sent. Total: ${uniqueTokens.length}, Success: ${successTokens.length}, Invalid: ${invalidTokens.length}`,
      );

      return {
        successTokens,
        invalidTokens,
        failureCount: response.failureCount,
      };
    } catch (err: any) {
      this.logger.error(`[FirebaseAdmin] Exception during sendEachForMulticast: ${err.message}`, err.stack);
      return {
        successTokens: [],
        invalidTokens: [],
        failureCount: uniqueTokens.length,
      };
    }
  }
}
