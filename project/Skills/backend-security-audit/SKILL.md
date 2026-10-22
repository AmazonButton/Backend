---
name: backend-security-audit
description: >-
  Use this skill to audit backend source code against the Security-by-Design Checklist and OWASP API Security Top 10.
  It provides automated review steps, test suites using Supertest to verify authentication, authorization,
  SQL injection immunity, mass assignment protection, rate limiting, and error leakage.
---

# Backend Security Audit & Testing Runbook

This skill is executed during Code Reviews, PR validations, and pre-deployment checks to guarantee that all security invariants are preserved.

---

## 1. Automated Security Review Checklist

Reviewers and agents must verify each file against this checklist:

### A. Authentication & Tokens
- [ ] No plaintext passwords stored or compared via `===`.
- [ ] Password hashes use `argon2id` or `bcrypt` (work factor >= 12).
- [ ] JWT tokens have expiration (`exp`) set.
- [ ] Failed login returns generic `401 Unauthorized` message (no email enumeration).
- [ ] No `password_hash`, `refresh_token`, or reset tokens returned in API responses.

### B. Access Control & Authorization (BOLA / BFLA)
- [ ] Every protected route has the `authenticate` middleware attached.
- [ ] Administrative routes enforce `requireRoles(['ADMIN'])`.
- [ ] Endpoints updating or fetching resources by ID check resource ownership (`resource.user_id === req.user.id`).
- [ ] Frontend role checking is NOT trusted as the authorization layer.

### C. Input Validation & Mass Assignment
- [ ] All request properties (`body`, `query`, `params`) validated with schema validator before reaching controller.
- [ ] No `req.body` directly dumped into SQL or ORM update calls. Allowed update fields are explicitly whitelisted.

### D. SQL Injection & Database
- [ ] Zero SQL string concatenation or template literal interpolation into query strings.
- [ ] All variables passed via parameter placeholders (`$1, $2`).
- [ ] Dynamic sort columns validated against a hard-coded whitelist.
- [ ] Application connects via a least-privilege PostgreSQL user.

### E. Rate Limiting & Resource Consumption
- [ ] Authentication endpoints (`/login`, `/register`, `/forgot-password`, `/otp`) have rate limiting enabled (max 5-10 req/min).
- [ ] Pagination parameters are capped: `pageSize = Math.min(requested, 100)`.
- [ ] JSON body parsing capped at 10kb.

### F. Error Handling & Secrets
- [ ] Central error middleware catches errors and suppresses stack traces when `NODE_ENV === 'production'`.
- [ ] Winston/Pino logger masks sensitive fields (`password`, `token`, `authorization`, `creditCard`).
- [ ] `.env` is listed in `.gitignore` and no secrets exist in Git history.

---

## 2. Supertest Security Test Suite Template (`tests/security.test.js`)

Add automated security regression tests to CI/CD:

```javascript
import request from 'supertest';
import { app } from '../src/app.js';
import { pool } from '../src/config/database.js';

describe('Security Regression Suite', () => {
  afterAll(async () => {
    await pool.end();
  });

  // 1. Test BOLA / IDOR Protection
  test('BOLA: User A cannot modify User B resource', async () => {
    const userAToken = 'Bearer <USER_A_TOKEN>';
    const userBResourceId = '999';

    const res = await request(app)
      .put(`/api/posts/${userBResourceId}`)
      .set('Authorization', userAToken)
      .send({ title: 'Hacked Title' });

    expect([403, 404]).toContain(res.statusCode);
  });

  // 2. Test SQL Injection Immunity
  test('SQLi: Attempting SQL injection in login returns 401 without syntax error', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: "' OR 1=1 --",
        password: 'password123'
      });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  // 3. Test Mass Assignment Prevention
  test('Mass Assignment: Normal user cannot elevate role via profile update', async () => {
    const userToken = 'Bearer <USER_TOKEN>';

    const res = await request(app)
      .patch('/api/users/profile')
      .set('Authorization', userToken)
      .send({
        username: 'new_name',
        role: 'ADMIN', // Malicious attempt to elevate role
        is_admin: true
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.role).not.toBe('ADMIN');
  });

  // 4. Test Error Leakage in Production
  test('Fail-Secure: Server error does not leak stack trace or SQL query', async () => {
    process.env.NODE_ENV = 'production';

    const res = await request(app)
      .get('/api/trigger-test-error')
      .send();

    expect(res.statusCode).toBe(500);
    expect(res.body.stack).toBeUndefined();
    expect(res.body.sql).toBeUndefined();
    expect(res.body.message).toBe('Internal server error');
  });
});
```

---

## 3. Dependency & Git Security Checks

Run the following commands before every release:

```bash
# 1. Check vulnerabilities in installed packages
npm audit

# 2. Fix automatically fixable issues
npm audit fix

# 3. Check for any accidentally tracked secret files
git status
git ls-files | grep -E "\.env$|\.pem$|\.key$"
```
