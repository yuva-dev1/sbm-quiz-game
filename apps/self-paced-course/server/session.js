import crypto from 'node:crypto';

/**
 * One signed cookie, `sp_host` — payload is the literal "host", the
 * shared-passcode gate for the /host area. Same `payload.expiresAt.hmac`
 * shape and timing-safe verify as the Kahoot app's hostAuth cookie, scoped
 * to this app's SELF_PACED_SESSION_SECRET.
 *
 * Students have no cookie here — their identity comes from the Squarespace
 * member session (see server/squarespace.js), passed in as a `sid` param.
 */

const HOST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HOST_COOKIE = 'sp_host';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
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

export function createHostCookie(secret) {
  const expiresAt = Date.now() + HOST_MAX_AGE_MS;
  const payload = `host.${expiresAt}`;
  const value = `${payload}.${sign(payload, secret)}`;
  return `${HOST_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(HOST_MAX_AGE_MS / 1000)}`;
}

export function clearHostCookie() {
  return clearCookie(HOST_COOKIE);
}

/** True when a valid host cookie is present. */
export function readHost(req, secret) {
  if (!secret) return false;
  const value = parseCookies(req.headers.cookie)[HOST_COOKIE];
  if (!value) return false;

  const lastDot = value.lastIndexOf('.');
  if (lastDot === -1) return false;
  const payload = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  const [role, expiresAtRaw] = payload.split('.');
  if (role !== 'host' || !expiresAtRaw || !signature) return false;

  const expected = sign(payload, secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
    return false;
  }
  return Date.now() <= Number(expiresAtRaw);
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
