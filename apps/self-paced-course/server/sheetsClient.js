/**
 * Talks to the Google Apps Script web app that backs this app's Sheet
 * (Members / Weeks / Attempts tabs). URL + shared apiKey come from the single
 * JSON secret SELF_PACED_SHEETS_ENDPOINT, mirroring how apps/self-study
 * handles SELF_STUDY_SHEETS_ENDPOINT.
 *
 * Apps Script web apps always answer with HTTP 200 — errors come back as
 * { ok: false, error } in the body — so every call here reads `ok` rather
 * than trusting response.ok.
 */

let cachedEndpoint = null;

function getEndpoint() {
  if (cachedEndpoint) return cachedEndpoint;
  const raw = process.env.SELF_PACED_SHEETS_ENDPOINT;
  if (!raw) throw new Error('SELF_PACED_SHEETS_ENDPOINT is not configured.');
  const parsed = JSON.parse(raw);
  if (!parsed.url || !parsed.apiKey) throw new Error('SELF_PACED_SHEETS_ENDPOINT is missing url or apiKey.');
  cachedEndpoint = parsed;
  return cachedEndpoint;
}

async function callSheetsScript(body) {
  const { url, apiKey } = getEndpoint();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, apiKey }),
    signal: AbortSignal.timeout(15_000)
  });
  return response
    .json()
    .catch(() => ({ ok: false, error: 'The course sheet returned an invalid response.' }));
}

// ---- Members (identity cached from the Squarespace Profiles API) ----

/** @returns { ok, member: { siteUserId, email, firstName, lastName } | null } */
export async function getMember(siteUserId) {
  return callSheetsScript({ action: 'getMember', siteUserId });
}

export async function upsertMember(member) {
  return callSheetsScript({ action: 'upsertMember', member });
}

// ---- Weeks ----

/** All weeks incl. drafts and correctChoices — host only. */
export async function listWeeksForHost() {
  return callSheetsScript({ action: 'listWeeks', includeUnpublished: true });
}

export async function upsertWeek(week) {
  return callSheetsScript({ action: 'upsertWeek', week });
}

export async function setWeekStatus(weekNumber, patch) {
  return callSheetsScript({ action: 'setWeekStatus', weekNumber, patch });
}

/** One week with its full QuizJSON (correctChoices included) — server-side grading. */
export async function getWeek(weekNumber) {
  return callSheetsScript({ action: 'getWeek', weekNumber });
}

// ---- Attempts ----

export async function saveAttempt(attempt) {
  return callSheetsScript({ action: 'saveAttempt', attempt });
}

/** This member's attempts. */
export async function listAttempts(siteUserId) {
  return callSheetsScript({ action: 'listAttempts', siteUserId });
}

/** Every attempt across all members — host scores dashboard. */
export async function listAllAttempts() {
  return callSheetsScript({ action: 'listAllAttempts' });
}

/** Remove one attempt row by AttemptId — host maintenance only. */
export async function deleteAttempt(attemptId) {
  return callSheetsScript({ action: 'deleteAttempt', attemptId });
}

// ---- Quiz versions (append-only history of each week's saved quizzes) ----

/** @returns { ok, liveVersion, versions: [{ version, label, createdAt, isLive }] } */
export async function listQuizVersions(weekNumber) {
  return callSheetsScript({ action: 'listQuizVersions', weekNumber });
}

/** @returns { ok, version: { version, label, createdAt, quiz } } */
export async function getQuizVersion(weekNumber, version) {
  return callSheetsScript({ action: 'getQuizVersion', weekNumber, version });
}

/** Point the week's live quiz back at an older version. */
export async function restoreQuizVersion(weekNumber, version) {
  return callSheetsScript({ action: 'restoreQuizVersion', weekNumber, version });
}

/** Rename a version (e.g. "the one we kept"). */
export async function labelQuizVersion(weekNumber, version, label) {
  return callSheetsScript({ action: 'labelQuizVersion', weekNumber, version, label });
}
