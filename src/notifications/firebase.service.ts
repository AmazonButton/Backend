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
    const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './secrets/firebase-service-account.json';
    const resolvedPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(process.cwd(), configuredPath);

    const isProduction = process.env.NODE_ENV === 'production';

    try {
      // 1. Prioritize Pure Environment Variables (12-Factor Cloud Standard)
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
      const privateKey = rawPrivateKey ? rawPrivateKey.replace(/\\n/g, '\n') : undefined;

      if (projectId && clientEmail && privateKey) {
        const appName = 'SOB_FIREBASE_APP';
        const existingApp = admin.apps.find((app) => app?.name === appName) || admin.apps[0];
        if (existingApp) {
          this.firebaseApp = existingApp;
        } else {
          this.firebaseApp = admin.initializeApp(
            {
              credential: admin.credential.cert({
                projectId,
                clientEmail,
                privateKey,
              }),
            },
            appName,
          );
        }
        this.logger.log(`[FirebaseAdmin] Successfully initialized Firebase Admin SDK from environment variables for project: ${projectId}`);
        return;
      }

      // 2. Fallback: Service Account JSON file path if configured
      if (fs.existsSync(resolvedPath)) {
        const fileContent = fs.readFileSync(resolvedPath, 'utf8').trim();
        if (fileContent.startsWith('{') && fileContent.includes('private_key')) {
          const serviceAccount = JSON.parse(fileContent);

          const appName = 'SOB_FIREBASE_APP';
          const existingApp = admin.apps.find((app) => app?.name === appName) || admin.apps[0];
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

      // Production Guard: Khong cho phep am tham chuyen sang Mock Mode o moi truong Production
      if (isProduction) {
        const fatalMsg = `[FirebaseAdmin FATAL] Service account credentials not found or invalid at "${resolvedPath}" in PRODUCTION environment! Failing fast.`;
        this.logger.error(fatalMsg);
        throw new Error(fatalMsg);
      }

      this.logger.warn(
        `[FirebaseAdmin] Service account file not found or invalid at ${resolvedPath}. Running in NODE_ENV=${process.env.NODE_ENV || 'development'}. FCM will operate in graceful simulation/mock mode.`,
      );
      this.isMockMode = true;
    } catch (err: any) {
      if (isProduction) {
        throw err;
      }
      this.logger.error(`[FirebaseAdmin] Error initializing Firebase Admin: ${err.message}`, err.stack);
      this.isMockMode = true;
    }
  }

  get isInitialized(): boolean {
    return this.firebaseApp !== null && !this.isMockMode;
  }

  get isMock(): boolean {
    return this.isMockMode;
  }

  /**
   * Gui multicast push notification toi danh sach tokens.
   * Tu dong phan loai token thanh cong va token loi/khong hop le de he thong tu dong don dep.
   * Hardened: Tu dong phan chia thanh cac batch toi da 500 token theo chuan Firebase Admin Multicast.
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

    // Chia batch toi da 500 token (Gioi han ky thuat cua FCM Multicast)
    const BATCH_SIZE = 500;
    const batches: string[][] = [];
    for (let i = 0; i < uniqueTokens.length; i += BATCH_SIZE) {
      batches.push(uniqueTokens.slice(i, i + BATCH_SIZE));
    }

    const aggregatedSuccess: string[] = [];
    const aggregatedInvalid: string[] = [];
    let aggregatedFailureCount = 0;

    for (const batch of batches) {
      if (!this.firebaseApp || this.isMockMode) {
        this.logger.debug(
          `[FirebaseAdmin Mock] Simulated push to batch of ${batch.length} tokens: Title="${title}", Body="${body}"`,
        );
        for (const token of batch) {
          if (token.startsWith('expired_') || token.startsWith('invalid_') || token.includes('NOT_REGISTERED')) {
            aggregatedInvalid.push(token);
            aggregatedFailureCount++;
          } else {
            aggregatedSuccess.push(token);
          }
        }
      } else {
        try {
          const messaging = this.firebaseApp.messaging();
          const message: admin.messaging.MulticastMessage = {
            tokens: batch,
            notification: {
              title,
              body,
            },
            data: data || {},
          };

          const response = await messaging.sendEachForMulticast(message);
          const invalidErrorCodes = [
            'messaging/invalid-registration-token',
            'messaging/registration-token-not-registered',
            'messaging/invalid-argument',
          ];

          response.responses.forEach((resp, idx) => {
            const token = batch[idx];
            if (resp.success) {
              aggregatedSuccess.push(token);
            } else {
              const errorCode = resp.error?.code || '';
              if (invalidErrorCodes.includes(errorCode)) {
                aggregatedInvalid.push(token);
              }
            }
          });

          aggregatedFailureCount += response.failureCount;
        } catch (err: any) {
          this.logger.error(`[FirebaseAdmin] Exception during sendEachForMulticast batch: ${err.message}`, err.stack);
          aggregatedFailureCount += batch.length;
        }
      }
    }

    if (this.firebaseApp && !this.isMockMode) {
      this.logger.log(
        `[FirebaseAdmin] Batched Multicast sent. Total: ${uniqueTokens.length}, Batches: ${batches.length}, Success: ${aggregatedSuccess.length}, Invalid: ${aggregatedInvalid.length}`,
      );
    }

    return {
      successTokens: aggregatedSuccess,
      invalidTokens: aggregatedInvalid,
      failureCount: aggregatedFailureCount,
    };
  }
}
