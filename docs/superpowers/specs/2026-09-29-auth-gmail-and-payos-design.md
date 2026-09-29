# Specification: Auth Gmail Account Management & PayOS Payment Gateway

## 1. Overview
Full account lifecycle with Gmail OTP verification and PayOS Payment Gateway API v2 integration with HMAC-SHA256 signature verification.

## 2. Modules
- MailModule (nodemailer with graceful Dev Fallback)
- AuthModule (Register, Verify Email OTP, Forgot Password OTP, Reset Password)
- PaymentsModule (PayOS create-link, webhook, transaction status)
