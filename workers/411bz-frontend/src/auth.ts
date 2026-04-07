/**
 * auth.ts — Tenant-scoped authentication for 411bz-frontend.
 *
 * CANONICAL FILE. This is the single source of truth for:
 *   - HMAC-SHA256 token signing and verification (Web Crypto API)
 *   - HttpOnly cookie read/write/clear
 *   - Auth code generation (for magic links and checkout handoff)
 *
 * NAMING: This file is `auth.ts`. It is imported as `from './auth'`.
 *         There is no `tenant-auth.ts`. If you see that name anywhere,
 *         it is stale — delete it and use this file.
 *
 * Token format: base64url(JSON payload).base64url(HMAC-SHA256 signature)
 * Cookie name:  __411bz_token
 */

// ── Constants ──

const COOKIE_NAME = '__411bz_token' as const;
const TOKEN_MAX_BYTES = 4096;
const DEFAULT_TTL_SECONDS = 7 * 24 * 3600; // 7 days
const VALID_ROLES = ['owner', 'admin', 'analyst', 'viewer'] as const;

export type TenantRole = (typeof VALID_ROLES)[number];

// ── Types ──

export interface TokenPayload {
  /** Tenant ID — must match the URL's :tenant_id for access. */
  tid: string;
  /** User ID — references observatory_tenant_users.id. */
  uid: string;
  /** Role — one of owner|admin|analyst|viewer. Enforced at sign and verify. */
  role: TenantRole;
  /** Expiry as Unix timestamp in seconds. */
  exp: number;
}

export type AuthResult =
  | { valid: true; payload: TokenPayload }
  | { valid: false; reason: string };

// ── Base64url (RFC 4648 §5, no padding) ──

function b64urlEncode(data: Uint8Array): string {
  const bin = String.fromCharCode(...data);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  // Add padding back for atob
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
    + '===='.slice(str.length % 4 || 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ── HMAC key import (cached per isolate via WeakMap would be ideal, but
//    Web Crypto importKey is fast enough for cookie-auth volumes) ──

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// ── Token Generation ──

export async function generateToken(
  payload: Omit<TokenPayload, 'exp'>,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  // Enforce role whitelist at signing time — never mint a bad token.
  if (!VALID_ROLES.includes(payload.role as TenantRole)) {
    throw new Error(`generateToken: invalid role "${payload.role}"`);
  }

  const full: TokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(full));
  const payloadB64 = b64urlEncode(jsonBytes);

  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, jsonBytes));

  return `${payloadB64}.${b64urlEncode(sig)}`;
}

// ── Token Verification ──

export async function verifyToken(
  token: string,
  secret: string,
): Promise<AuthResult> {
  if (token.length > TOKEN_MAX_BYTES) {
    return { valid: false, reason: 'token_too_long' };
  }

  const dot = token.indexOf('.');
  if (dot === -1 || token.indexOf('.', dot + 1) !== -1) {
    // Must have exactly one dot.
    return { valid: false, reason: 'malformed_token' };
  }

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = b64urlDecode(payloadB64);
    sigBytes = b64urlDecode(sigB64);
  } catch {
    return { valid: false, reason: 'invalid_encoding' };
  }

  // HMAC verify — constant-time comparison inside Web Crypto.
  const key = await hmacKey(secret);
  if (!(await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes))) {
    return { valid: false, reason: 'invalid_signature' };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

  // Structural validation — every field must exist and be the right type.
  if (
    typeof payload.tid !== 'string' || !payload.tid ||
    typeof payload.uid !== 'string' || !payload.uid ||
    typeof payload.role !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { valid: false, reason: 'missing_fields' };
  }

  if (!VALID_ROLES.includes(payload.role as TenantRole)) {
    return { valid: false, reason: 'invalid_role' };
  }

  // Expiry — strict less-than-or-equal so tokens don't linger an extra second.
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}

// ── Cookie helpers ──

/**
 * Extract the auth token from a Cookie header string.
 * Uses exact cookie-name match to avoid __411bz_token2-style collisions.
 */
export function parseCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`),
  );
  return match ? match[1] : null;
}

/** Returns the Set-Cookie header value to issue a new auth cookie. */
export function setTokenCookie(
  token: string,
  maxAgeSec: number = DEFAULT_TTL_SECONDS,
): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

/** Returns the Set-Cookie header value to clear the auth cookie. */
export function clearTokenCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ── Auth Code Generation ──

/** Generate a cryptographically random auth code (256-bit, base64url). */
export function generateAuthCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}
