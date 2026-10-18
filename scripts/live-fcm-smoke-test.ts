import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('================================================================================');
  console.log('🔥 LIVE FIREBASE CLOUD MESSAGING (FCM) SMOKE TEST');
  console.log('================================================================================\n');

  const targetToken = process.argv[2];
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './secrets/firebase-service-account.json';
  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌ File Service Account khong ton tai tai: ${resolvedPath}`);
    console.log('\nHuong dan thiet lap:');
    console.log('1. Truy cap Firebase Console -> Project Settings -> Service accounts -> Firebase Admin SDK');
    console.log('2. Nhan "Generate new private key" va tai file JSON ve.');
    console.log(`3. Dat file vao thu muc: ${resolvedPath}`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(resolvedPath, 'utf8').trim();
  let serviceAccount: any;
  try {
    serviceAccount = JSON.parse(fileContent);
  } catch (err: any) {
    console.error('❌ File Service Account khong dung dinh dang JSON hop le:', err.message);
    process.exit(1);
  }

  const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  }, 'SMOKE_TEST_APP');

  console.log(`✔ Da khoi tao Firebase Admin SDK thanh cong cho Project ID: ${serviceAccount.project_id || 'Unknown'}`);

  if (!targetToken) {
    console.log('\n[INFO] Khong co FCM Token nao duoc truyen vao tu dong lenh.');
    console.log('Cach dung de test thuc te voi thiet bi Android:');
    console.log('  npx tsx scripts/live-fcm-smoke-test.ts <FCM_REGISTRATION_TOKEN>\n');
    process.exit(0);
  }

  console.log(`\nDang gui live notification toi device token: ${targetToken.substring(0, 15)}... (len=${targetToken.length})`);

  try {
    const messaging = app.messaging();
    const message: admin.messaging.Message = {
      token: targetToken.trim(),
      notification: {
        title: 'Thong bao Smart Order Button (Live Test)',
        body: `Xac nhan ket noi Firebase FCM thanh cong vao luc ${new Date().toLocaleTimeString()}!`,
      },
      data: {
        type: 'SMOKE_TEST',
        timestamp: Date.now().toString(),
      },
    };

    const messageId = await messaging.send(message);
    console.log(`\n🎉 [SUCCESS] Live FCM Push Notification da gui thanh cong!`);
    console.log(`Message ID: ${messageId}`);
  } catch (err: any) {
    console.error(`\n❌ [FAILED] Gui thong bao that bai: ${err.message}`);
    if (err.code) {
      console.error(`Error Code: ${err.code}`);
    }
    process.exit(1);
  }
}

main();
