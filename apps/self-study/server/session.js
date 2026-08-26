import crypto from 'node:crypto';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'self_study_session';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/** regNo.expiresAt.hmac — same shape as this repo's own hostAuth cookie, just scoped to this app's secret. */
export function createSessionCookie(regNo, secret) {
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${regNo}.${expiresAt}`;
  const signature = sign(payload, secret);
  const value = `${payload}.${signature}`;
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/** Returns the authenticated regNo, or null if there's no valid session. */
export function readSession(req, secret) {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[COOKIE_NAME];
  if (!value) return null;

  const lastDot = value.lastIndexOf('.');
  const payload = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  const [regNo, expiresAtRaw] = payload.split('.');
  if (!regNo || !expiresAtRaw || !signature) return null;

  const expectedSignature = sign(payload, secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }

  if (Date.now() > Number(expiresAtRaw)) return null;
  return regNo;
}

export function requireSession(secret) {
  return (req, res, next) => {
    const regNo = readSession(req, secret);
    if (!regNo) {
      res.status(401).json({ error: 'Please log in to continue.' });
      return;
    }
    req.regNo = regNo;
    next();
  };
}
