---
name: advanced-auth-and-webhooks
description: >-
  Use this skill when implementing secure Forgot/Reset Password flows (SHA-256 hashed tokens, anti-timing enumeration defenses)
  or integrating third-party Webhooks (Stripe, VNPay, GitHub) with raw body HMAC-SHA256 signature verification.
---

# Advanced Authentication & Webhook Signature Verification

This skill covers critical real-world edge cases in identity recovery and third-party event ingestion.

---

## 1. Secure Forgot & Reset Password Flow

### A. Vulnerability Defense Rules
1. **Never store raw reset tokens in the database**: If the database is compromised, an attacker can use active tokens to take over accounts. Store the **SHA-256 hash** of the token instead.
2. **Prevent Account Enumeration via Timing Attacks**: Always return the exact same HTTP 200 message regardless of whether the email exists.
3. **Single-Use Enforcement**: Immediately invalidate the reset token upon successful password update.

### B. Request Password Reset (`auth.service.js`)
```javascript
import crypto from 'crypto';
import { pool } from '../config/database.js';
import { emailQueue } from '../queues/email.queue.js';

export const requestPasswordReset = async (email) => {
  const userRes = await pool.query(
    'SELECT id, email FROM users WHERE email = $1 AND is_active = true',
    [email.toLowerCase()]
  );

  if (userRes.rows.length > 0) {
    const user = userRes.rows[0];

    // 1. Generate unguessable 32-byte raw token (sent ONLY to user email)
    const rawToken = crypto.randomBytes(32).toString('hex');

    // 2. Hash token with SHA-256 before storing in database
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-minute validity

    await pool.query(
      `UPDATE users 
       SET password_reset_token = $1, password_reset_expires_at = $2 
       WHERE id = $3`,
      [tokenHash, expiresAt, user.id]
    );

    // 3. Queue password reset email asynchronously
    await emailQueue.add('send-password-reset', {
      email: user.email,
      resetToken: rawToken
    });
  }

  // Anti-Enumeration: Always respond with identical message and status code
  return {
    message: 'If that email address is in our database, we have sent a password reset link.'
  };
};
```

### C. Reset Password with Token (`auth.service.js`)
```javascript
import crypto from 'crypto';
import argon2 from 'argon2';
import { pool } from '../config/database.js';
import { AppError } from '../utils/apiError.js';

export const resetPassword = async (rawToken, newPassword) => {
  // Hash the incoming raw token to compare against the stored hash
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const userRes = await pool.query(
    `SELECT id FROM users 
     WHERE password_reset_token = $1 
       AND password_reset_expires_at > NOW() 
       AND is_active = true`,
    [tokenHash]
  );

  if (userRes.rows.length === 0) {
    throw new AppError('Password reset token is invalid or has expired', 400);
  }

  const user = userRes.rows[0];
  const newPasswordHash = await argon2.hash(newPassword);

  // Update password and invalidate the reset token immediately
  await pool.query(
    `UPDATE users 
     SET password_hash = $1, 
         password_reset_token = NULL, 
         password_reset_expires_at = NULL,
         updated_at = NOW() 
     WHERE id = $2`,
    [newPasswordHash, user.id]
  );

  return { message: 'Password has been reset successfully' };
};
```

---

## 2. Webhook Security & Raw Body HMAC Verification

### A. The `express.json()` Trap
Standard `express.json()` parses the request body into a JavaScript object. Re-stringifying this object modifies whitespace and key order, causing HMAC signature verification to fail!
Capture the raw byte buffer at the middleware level:

```javascript
// src/app.js
app.use(express.json({
  limit: '10kb',
  verify: (req, res, buf) => {
    // Retain original raw bytes for webhook signature checks
    if (req.originalUrl.startsWith('/api/v1/webhooks')) {
      req.rawBody = buf;
    }
  }
}));
```

### B. Timing-Safe HMAC-SHA256 Verification Middleware (`src/middlewares/webhookVerify.js`)
```javascript
import crypto from 'crypto';
import { AppError } from '../utils/apiError.js';
import { env } from '../config/env.js';

export const verifyWebhookSignature = (secretKey) => {
  return (req, res, next) => {
    const signatureHeader = req.headers['x-signature'] || req.headers['stripe-signature'];
    const timestamp = req.headers['x-timestamp'];

    if (!signatureHeader || !req.rawBody) {
      return next(new AppError('Missing webhook signature or payload', 400));
    }

    // 1. Replay attack defense: Reject timestamps older than 5 minutes
    if (timestamp && Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60 * 1000) {
      return next(new AppError('Webhook timestamp out of acceptable tolerance window', 400));
    }

    // 2. Compute expected HMAC
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(req.rawBody)
      .digest('hex');

    // 3. Timing-safe comparison to prevent side-channel timing attacks
    const sigBuffer = Buffer.from(signatureHeader, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return next(new AppError('Invalid webhook signature verification', 401));
    }

    next();
  };
};
```
