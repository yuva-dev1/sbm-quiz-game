import crypto from 'node:crypto';

/**
 * Two independent signed cookies:
 *   - sp_student : payload is the student's email (their identity everywhere)
 *   - sp_host    : payload is the literal "host" (shared-passcode gate)
 *
 * Same `payload.expiresAt.hmac` shape and timing-safe verify as
 * apps/self-study/server/session.js and the Kahoot app's hostAuth cookie,
 * scoped to this app's SELF_PACED_SESSION_SECRET.
 */

const STUDENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HOST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STUDENT_COOKIE = 'sp_student';
const HOST_COOKIE = 'sp_host';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function buildCookie(name, payloadValue, secret, maxAgeMs) {
  const expiresAt = Date.now() + maxAgeMs;
  const payload = `${payloadValue}.${expiresAt}`;
  const value = `${payload}.${sign(payload, secret)}`;
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

function clearCookie(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    const rawValue = part.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = decodeURIComponent(rawValue);
  }
  return cookies;
}

/** Returns the signed payload string, or null if the cookie is missing/invalid/expired. */
function readSignedCookie(req, name, secret) {
  if (!secret) return null;
  const value = parseCookies(req.headers.cookie)[name];
  if (!value) return null;

  const lastDot = value.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  const separatorIndex = payload.lastIndexOf('.');
  if (separatorIndex === -1) return null;
  const payloadValue = payload.slice(0, separatorIndex);
  const expiresAtRaw = payload.slice(separatorIndex + 1);
  if (!payloadValue || !expiresAtRaw || !signature) return null;

  const expected = sign(payload, secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }
  if (Date.now() > Number(expiresAtRaw)) return null;
  return payloadValue;
}

export function createStudentCookie(email, secret) {
  return buildCookie(STUDENT_COOKIE, email, secret, STUDENT_MAX_AGE_MS);
}

export function createHostCookie(secret) {
  return buildCookie(HOST_COOKIE, 'host', secret, HOST_MAX_AGE_MS);
}

export function clearStudentCookie() {
  return clearCookie(STUDENT_COOKIE);
}

export function clearHostCookie() {
  return clearCookie(HOST_COOKIE);
}

/** Authenticated student email, or null. */
export function readStudent(req, secret) {
  return readSignedCookie(req, STUDENT_COOKIE, secret);
}

/** True when a valid host cookie is present. A student cookie never satisfies this. */
export function readHost(req, secret) {
  return readSignedCookie(req, HOST_COOKIE, secret) === 'host';
}

export function requireStudent(secret) {
  return (req, res, next) => {
    const email = readStudent(req, secret);
    if (!email) {
      res.status(401).json({ error: 'Please log in to continue.' });
      return;
    }
    req.email = email;
    next();
  };
}

export function requireHost(secret) {
  return (req, res, next) => {
    if (!readHost(req, secret)) {
      res.status(401).json({ error: 'Host sign-in required.' });
      return;
    }
    next();
  };
}
