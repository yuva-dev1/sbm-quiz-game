/**
 * Talks to the Google Apps Script web app that backs this app's Sheet
 * (Users / Weeks / Attempts tabs). URL + shared apiKey come from the single
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

// ---- Accounts ----

export async function createAccount(firstName, lastName, email, passwordHash) {
  return callSheetsScript({ action: 'register', firstName, lastName, email, passwordHash });
}

export async function findAccount(email) {
  return callSheetsScript({ action: 'login', email });
}

export async function requestPasswordReset(email) {
  return callSheetsScript({ action: 'requestPasswordReset', email });
}

export async function resetPassword(email, token, passwordHash) {
  return callSheetsScript({ action: 'resetPassword', email, token, passwordHash });
}

// ---- Weeks ----

/** All weeks incl. drafts and correctChoices — host only. */
export async function listWeeksForHost() {
  return callSheetsScript({ action: 'listWeeks', includeUnpublished: true });
}

/** Published weeks only — the student-facing course. */
export async function listPublishedWeeks() {
  return callSheetsScript({ action: 'listWeeks', includeUnpublished: false });
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

export async function listAttempts(email) {
  return callSheetsScript({ action: 'listAttempts', email });
}

/** Every attempt across all students — host scores dashboard. */
export async function listAllAttempts() {
  return callSheetsScript({ action: 'listAllAttempts' });
}
