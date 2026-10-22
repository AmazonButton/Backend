import { Provider, Logger } from '@nestjs/common';
import { cert, getApps, initializeApp, App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import * as fs from 'fs';
import * as path from 'path';

export const FIREBASE_ADMIN = 'FIREBASE_ADMIN';

export const FirebaseAdminProvider: Provider = {
  provide: FIREBASE_ADMIN,
  useFactory: () => {
    const logger = new Logger('FirebaseAdminProvider');

    // 1. Reuse existing Firebase App if already initialized in runtime
    if (getApps().length > 0) {
      const existingApp = getApps()[0];
      logger.log(`[FirebaseAdmin] Reusing existing Firebase app instance: ${existingApp?.name}`);
      return getAuth(existingApp as App);
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
    const privateKey = rawPrivateKey ? rawPrivateKey.replace(/\\n/g, '\n') : undefined;

    // 2. Initialize using Environment Variables (Recommended for Production / Cloud)
    if (projectId && clientEmail && privateKey) {
      const app = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      logger.log(`[FirebaseAdmin] Successfully initialized Firebase Admin SDK from environment variables for project: ${projectId}`);
      return getAuth(app);
    }

    // 3. Fallback: Initialize using Service Account JSON file path if specified
    const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (configuredPath) {
      const resolvedPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);

      if (fs.existsSync(resolvedPath)) {
        try {
          const fileContent = fs.readFileSync(resolvedPath, 'utf8').trim();
          if (fileContent.startsWith('{') && fileContent.includes('private_key')) {
            const serviceAccount = JSON.parse(fileContent);
            const app = initializeApp({
              credential: cert(serviceAccount),
            });
            logger.log(`[FirebaseAdmin] Successfully initialized Firebase Admin SDK from path: ${resolvedPath}`);
            return getAuth(app);
          }
        } catch (err: any) {
          logger.error(`[FirebaseAdmin] Failed to read or parse service account file at ${resolvedPath}: ${err.message}`);
        }
      }
    }

    // 4. Production guard: In production, fail fast if credentials are not configured
    if (process.env.NODE_ENV === 'production') {
      const fatalMsg = '[FirebaseAdmin FATAL] No valid Firebase credentials found in environment (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY or FIREBASE_SERVICE_ACCOUNT_PATH) in PRODUCTION!';
      logger.error(fatalMsg);
      throw new Error(fatalMsg);
    }

    // 5. Development/Test fallback: return a safe mock object so local servers or test suites do not crash
    logger.warn('[FirebaseAdmin] No Firebase credentials detected in development environment. Phone Auth endpoints will require valid credentials or mock injection.');
    return {
      verifyIdToken: async () => {
        throw new Error('Firebase credentials not configured in local environment.');
      },
    } as any;
  },
};
