/**
 * Resolves a Squarespace site member's identity from the `siteUserId` that
 * the course pages expose client-side (the `SiteUserInfo` cookie). That id is
 * the same one the Squarespace Profiles API uses, so a single GET returns the
 * member's email + name.
 *
 * Needs a Squarespace Developer API key with the **Profiles** (read) scope,
 * in SQUARESPACE_API_KEY.
 */

const API_BASE = process.env.SQUARESPACE_API_BASE || 'https://api.squarespace.com/1.0';
const API_KEY = process.env.SQUARESPACE_API_KEY || '';
const USER_AGENT = 'bhagavatham-self-paced-course/1.0';

/** 24-char hex object id, the shape Squarespace uses for member/profile ids. */
export function isPlausibleSiteUserId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value.trim());
}

/**
 * @returns {Promise<{ siteUserId, email, firstName, lastName } | null>}
 *   null when the id doesn't match a profile on this site.
 * @throws on a transport / auth / unexpected-status failure.
 */
export async function fetchMemberProfile(siteUserId) {
  if (!API_KEY) throw new Error('SQUARESPACE_API_KEY is not configured.');
  if (!isPlausibleSiteUserId(siteUserId)) return null;

  const response = await fetch(`${API_BASE}/profiles/${encodeURIComponent(siteUserId)}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': USER_AGENT
    },
    signal: AbortSignal.timeout(10_000)
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Squarespace Profiles API ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  // GET /profiles/{id} returns { profiles: [ { ... } ] }.
  const profile = Array.isArray(payload?.profiles) ? payload.profiles[0] : payload;
  if (!profile?.id) return null;

  return {
    siteUserId: String(profile.id),
    email: String(profile.email || '').trim().toLowerCase(),
    firstName: String(profile.firstName || '').trim(),
    lastName: String(profile.lastName || '').trim()
  };
}
