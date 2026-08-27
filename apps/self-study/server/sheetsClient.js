/**
 * Talks to the Google Apps Script web app that backs the Users sheet.
 * The script's URL + shared apiKey are read from SELF_STUDY_SHEETS_ENDPOINT
 * (a single JSON secret, mirroring how GENERATE_QUIZ_API_KEY is handled) so
 * the credential never has to be split across two env vars.
 *
 * Apps Script web apps always answer doPost with HTTP 200 — errors come back
 * as { ok: false, error } in the body, not a 4xx/5xx status, so every call
 * here reads `ok` rather than trusting response.ok.
 */

let cachedEndpoint = null;

function getEndpoint() {
  if (cachedEndpoint) return cachedEndpoint;
  const raw = process.env.SELF_STUDY_SHEETS_ENDPOINT;
  if (!raw) throw new Error('SELF_STUDY_SHEETS_ENDPOINT is not configured.');
  const parsed = JSON.parse(raw);
  if (!parsed.url || !parsed.apiKey) throw new Error('SELF_STUDY_SHEETS_ENDPOINT is missing url or apiKey.');
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
  const payload = await response.json().catch(() => ({ ok: false, error: 'The accounts sheet returned an invalid response.' }));
  return payload;
}

export async function createAccount(regNo, passwordHash, email) {
  return callSheetsScript({ action: 'register', regNo, email, passwordHash });
}

export async function findAccount(regNo) {
  return callSheetsScript({ action: 'login', regNo });
}

export async function requestPasswordReset(regNo, email) {
  return callSheetsScript({ action: 'requestPasswordReset', regNo, email });
}

export async function resetPassword(regNo, token, passwordHash) {
  return callSheetsScript({ action: 'resetPassword', regNo, token, passwordHash });
}

export async function saveQuizAttempt(regNo, attempt) {
  return callSheetsScript({ action: 'saveQuizAttempt', regNo, attempt });
}

export async function listQuizAttempts(regNo) {
  return callSheetsScript({ action: 'listQuizAttempts', regNo });
}

export async function saveFlashcardSet(regNo, set) {
  return callSheetsScript({ action: 'saveFlashcardSet', regNo, set });
}

export async function listFlashcardSets(regNo) {
  return callSheetsScript({ action: 'listFlashcardSets', regNo });
}
