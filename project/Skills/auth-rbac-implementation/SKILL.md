---
name: auth-rbac-implementation
description: >-
  Use this skill when implementing user registration, login, logout, JWT authentication, Refresh Token rotation,
  Role-Based Access Control (RBAC), or Object-Level Ownership authorization (BOLA/IDOR protection) in Node.js.
---

# Authentication & RBAC Implementation Runbook

This skill guides the implementation of secure identity, access management, and resource ownership control in a Node.js & PostgreSQL backend.

---

## 1. Password Hashing (Argon2 / Bcrypt)

Never store plaintext passwords or roll custom hash functions. Use `argon2` or `bcrypt` with work factor >= 12.

```javascript
import argon2 from 'argon2';

export const hashPassword = async (plainPassword) => {
  return await argon2.hash(plainPassword, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16, // 64 MB
    timeCost: 3,
    parallelism: 1
  });
};

export const verifyPassword = async (storedHash, plainPassword) => {
  try {
    return await argon2.verify(storedHash, plainPassword);
  } catch (error) {
    return false;
  }
};
```

---

## 2. Token Management & Rotation

- **Access Token**: Short lifespan (`15m`), contains minimal payload (`{ id, role }`), signed with `JWT_SECRET`.
- **Refresh Token**: Longer lifespan (`7d`), stored hashed in PostgreSQL table `refresh_tokens`, signed with `REFRESH_TOKEN_SECRET`.

```javascript
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const generateTokens = (user) => {
  const payload = { sub: user.id, role: user.role };
  
  const accessToken = jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN || '15m'
  });

  const refreshToken = jwt.sign(payload, env.REFRESH_TOKEN_SECRET, {
    expiresIn: '7d'
  });

  return { accessToken, refreshToken };
};
```

### Cookie Strategy (Recommended for Web Clients)
Avoid storing tokens in `localStorage` due to XSS vulnerability risks. Send Refresh Tokens via `HttpOnly` cookies:

```javascript
export const sendAuthCookies = (res, refreshToken) => {
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
};
```

---

## 3. Authentication Middleware (`src/middlewares/auth.js`)

Verifies the signature and checks that the user account is still active:

```javascript
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../utils/apiError.js';

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authentication required. Missing Bearer token.', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.JWT_SECRET);

    // Attach user payload to request
    req.user = {
      id: decoded.sub,
      role: decoded.role
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError('Token has expired', 401));
    }
    return next(new AppError('Invalid authentication token', 401));
  }
};
```

---

## 4. Role-Based Access Control (RBAC) Middleware

Protects endpoints based on authorized roles:

```javascript
import { AppError } from '../utils/apiError.js';

export const requireRoles = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Unauthorized: User unauthenticated', 401));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError('Forbidden: Insufficient permissions', 403));
    }

    next();
  };
};
```

---

## 5. Object-Level Ownership Guard (Preventing BOLA / IDOR)

A common security vulnerability (OWASP API1: BOLA) happens when user `10` modifies `/api/records/25` belonging to user `20`.
Always verify that the record owner matches `req.user.id` or that the user has an `ADMIN` override:

```javascript
import { AppError } from '../utils/apiError.js';

export const verifyOwnership = (getResourceByIdFn, idParam = 'id', ownerField = 'user_id') => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[idParam];
      const resource = await getResourceByIdFn(resourceId);

      if (!resource) {
        return next(new AppError('Resource not found', 404));
      }

      // Admins bypass ownership checks
      if (req.user.role === 'ADMIN') {
        req.resource = resource;
        return next();
      }

      // Check ownership
      if (String(resource[ownerField]) !== String(req.user.id)) {
        return next(new AppError('Forbidden: You do not own this resource', 403));
      }

      req.resource = resource;
      next();
    } catch (error) {
      next(error);
    }
  };
};
```

---

## 6. Output Sanitization (DTO Layer)

Strip out sensitive properties before responding:

```javascript
export const toUserResponseDTO = (user) => {
  const { password_hash, refresh_token_hash, reset_token, ...safeUser } = user;
  return safeUser;
};
```
