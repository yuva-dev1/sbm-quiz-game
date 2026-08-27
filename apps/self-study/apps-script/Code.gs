/**
 * Google Apps Script web app backing the Bhagavatam Self Study accounts sheet.
 *
 * Deploy: Extensions > Apps Script (bound to the target Sheet), paste this in,
 * then Deploy > Manage deployments > edit the existing deployment > Version:
 * New version > Deploy. Keeps the same /exec URL — please use "New version"
 * on the existing deployment rather than creating a fresh deployment, so the
 * URL doesn't change.
 *
 * Script Properties (Project Settings > Script Properties):
 *   API_KEY   — shared secret, matches SELF_STUDY_SHEETS_ENDPOINT.apiKey (unchanged).
 *   APP_URL   — public URL of the self-study app, used to build reset links,
 *               e.g. https://bhagavatham-self-study-876193044983.us-central1.run.app
 *
 * After pasting, run authorize() once from the editor to grant the new mail
 * scope (MailApp), then redeploy.
 *
 * Sheet tabs are created automatically the first time they're needed:
 * Users, QuizAttempts, FlashcardSets. The Users tab must be recreated with the
 * new columns — delete the existing Users tab before the first request (it only
 * holds disposable test accounts) and the script rebuilds it.
 */

const REG_NO_LENGTH = 5;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERS_HEADERS = ['RegNo', 'Email', 'PasswordHash', 'CreatedAt', 'ResetTokenHash', 'ResetTokenExpiresAt'];

/** Run once from the editor after pasting, to authorize the MailApp scope. */
function authorize() {
  MailApp.getRemainingDailyQuota();
}

function doPost(e) {
  try {
    return handleRequest(e);
  } catch (err) {
    return jsonResponse({ ok: false, error: `Server error: ${err.message}` });
  }
}

function handleRequest(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' });
  }

  const expectedKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expectedKey || body.apiKey !== expectedKey) {
    return jsonResponse({ ok: false, error: 'Unauthorized.' });
  }

  const regNo = String(body.regNo || '').trim().toUpperCase();
  if (regNo.length !== REG_NO_LENGTH) {
    return jsonResponse({ ok: false, error: `Registration number must be exactly ${REG_NO_LENGTH} characters.` });
  }

  switch (body.action) {
    case 'login':
      return handleLogin(regNo);
    case 'requestPasswordReset':
      return handleRequestPasswordReset(regNo, body);
    case 'resetPassword':
      return handleResetPassword(regNo, body);
    case 'saveQuizAttempt':
      return handleSaveQuizAttempt(regNo, body.attempt || {});
    case 'listQuizAttempts':
      return handleListQuizAttempts(regNo);
    case 'saveFlashcardSet':
      return handleSaveFlashcardSet(regNo, body.set || {});
    case 'listFlashcardSets':
      return handleListFlashcardSets(regNo);
    default:
      return handleRegister(regNo, body);
  }
}

// ---- Accounts ----

function usersSheet() {
  return getOrCreateSheet('Users', USERS_HEADERS);
}

/** 1-based column index for a Users header name. */
function usersCol(name) {
  return USERS_HEADERS.indexOf(name) + 1;
}

function handleRegister(regNo, body) {
  const passwordHash = String(body.passwordHash || '');
  const email = String(body.email || '').trim().toLowerCase();
  if (!passwordHash) {
    return jsonResponse({ ok: false, error: 'Missing passwordHash.' });
  }
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse({ ok: false, error: 'A valid email address is required.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = usersSheet();
    if (findRowByValue(sheet, usersCol('RegNo'), regNo) !== -1) {
      return jsonResponse({ ok: false, error: 'An account with this registration number already exists.' });
    }
    if (findRowByValue(sheet, usersCol('Email'), email.toUpperCase()) !== -1) {
      return jsonResponse({ ok: false, error: 'An account with this email address already exists.' });
    }
    const row = [];
    row[usersCol('RegNo') - 1] = regNo;
    row[usersCol('Email') - 1] = email;
    row[usersCol('PasswordHash') - 1] = passwordHash;
    row[usersCol('CreatedAt') - 1] = new Date().toISOString();
    row[usersCol('ResetTokenHash') - 1] = '';
    row[usersCol('ResetTokenExpiresAt') - 1] = '';
    sheet.appendRow(row);
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function handleLogin(regNo) {
  const sheet = usersSheet();
  const row = findRowByValue(sheet, usersCol('RegNo'), regNo);
  if (row === -1) {
    return jsonResponse({ ok: false, error: 'No account with this registration number.' });
  }
  const passwordHash = sheet.getRange(row, usersCol('PasswordHash')).getValue();
  return jsonResponse({ ok: true, passwordHash: String(passwordHash) });
}

// ---- Password reset ----

function handleRequestPasswordReset(regNo, body) {
  const email = String(body.email || '').trim().toLowerCase();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = usersSheet();
    const row = findRowByValue(sheet, usersCol('RegNo'), regNo);
    if (row !== -1 && EMAIL_PATTERN.test(email)) {
      const rowEmail = String(sheet.getRange(row, usersCol('Email')).getValue()).trim().toLowerCase();
      if (rowEmail && rowEmail === email) {
        const token = randomToken();
        sheet.getRange(row, usersCol('ResetTokenHash')).setValue(sha256Hex(token));
        sheet.getRange(row, usersCol('ResetTokenExpiresAt')).setValue(Date.now() + RESET_TOKEN_TTL_MS);
        SpreadsheetApp.flush();
        sendResetEmail(email, regNo, token);
      }
    }
  } finally {
    lock.releaseLock();
  }

  // Never reveal whether the account / email matched.
  return jsonResponse({ ok: true });
}

function handleResetPassword(regNo, body) {
  const token = String(body.token || '');
  const passwordHash = String(body.passwordHash || '');
  if (!token || !passwordHash) {
    return jsonResponse({ ok: false, error: 'Missing reset token or password.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = usersSheet();
    const row = findRowByValue(sheet, usersCol('RegNo'), regNo);
    const invalid = jsonResponse({ ok: false, error: 'This reset link is invalid or has expired. Request a new one.' });
    if (row === -1) return invalid;

    const storedHash = String(sheet.getRange(row, usersCol('ResetTokenHash')).getValue());
    const expiresAt = Number(sheet.getRange(row, usersCol('ResetTokenExpiresAt')).getValue());
    if (!storedHash || sha256Hex(token) !== storedHash || !expiresAt || Date.now() > expiresAt) {
      return invalid;
    }

    sheet.getRange(row, usersCol('PasswordHash')).setValue(passwordHash);
    sheet.getRange(row, usersCol('ResetTokenHash')).setValue('');
    sheet.getRange(row, usersCol('ResetTokenExpiresAt')).setValue('');
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function randomToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function sha256Hex(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function sendResetEmail(email, regNo, token) {
  const appUrl = String(PropertiesService.getScriptProperties().getProperty('APP_URL') || '').replace(/\/+$/, '');
  const link = appUrl + '/?token=' + encodeURIComponent(token) + '&reg=' + encodeURIComponent(regNo);
  const body =
    'Namaste,\n\n' +
    'We received a request to reset the password for registration number ' + regNo + ' on Bhagavatam Self Study.\n\n' +
    'Open this link to choose a new password (valid for 1 hour):\n' +
    link + '\n\n' +
    'If you did not request this, you can safely ignore this email — your password will not change.\n\n' +
    'Radhe Radhe';
  MailApp.sendEmail({
    to: email,
    subject: 'Reset your Bhagavatam Self Study password',
    body: body
  });
}

// ---- Quiz history ----

function handleSaveQuizAttempt(regNo, attempt) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet('QuizAttempts', ['AttemptId', 'RegNo', 'SubmittedAt', 'ContextLabel', 'WeekIds', 'Topics', 'Difficulty', 'CorrectCount', 'ScoredCount', 'Percentage', 'QuestionsJSON']);
    sheet.appendRow([
      String(attempt.id || Utilities.getUuid()),
      regNo,
      String(attempt.submittedAt || new Date().toISOString()),
      String(attempt.contextLabel || ''),
      JSON.stringify(attempt.weekIds || []),
      JSON.stringify(attempt.topics || []),
      String(attempt.difficulty || ''),
      Number(attempt.correctCount || 0),
      Number(attempt.scoredCount || 0),
      Number(attempt.percentage || 0),
      JSON.stringify(attempt.questions || [])
    ]);
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function handleListQuizAttempts(regNo) {
  const sheet = getOrCreateSheet('QuizAttempts', ['AttemptId', 'RegNo', 'SubmittedAt', 'ContextLabel', 'WeekIds', 'Topics', 'Difficulty', 'CorrectCount', 'ScoredCount', 'Percentage', 'QuestionsJSON']);
  const rows = getDataRows(sheet);
  const attempts = rows
    .filter((row) => String(row[1]).trim().toUpperCase() === regNo)
    .map((row) => ({
      id: row[0],
      submittedAt: row[2],
      contextLabel: row[3],
      weekIds: safeParseJson(row[4], []),
      topics: safeParseJson(row[5], []),
      difficulty: row[6],
      correctCount: row[7],
      scoredCount: row[8],
      percentage: row[9],
      questions: safeParseJson(row[10], [])
    }));
  return jsonResponse({ ok: true, attempts });
}

// ---- Flashcard sets ----

function handleSaveFlashcardSet(regNo, set) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet('FlashcardSets', ['SetId', 'RegNo', 'CreatedAt', 'Label', 'WeekIds', 'Topics', 'CardsJSON']);
    sheet.appendRow([
      String(set.id || Utilities.getUuid()),
      regNo,
      String(set.createdAt || new Date().toISOString()),
      String(set.label || ''),
      JSON.stringify(set.weekIds || []),
      JSON.stringify(set.topics || []),
      JSON.stringify(set.cards || [])
    ]);
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function handleListFlashcardSets(regNo) {
  const sheet = getOrCreateSheet('FlashcardSets', ['SetId', 'RegNo', 'CreatedAt', 'Label', 'WeekIds', 'Topics', 'CardsJSON']);
  const rows = getDataRows(sheet);
  const sets = rows
    .filter((row) => String(row[1]).trim().toUpperCase() === regNo)
    .map((row) => ({
      id: row[0],
      createdAt: row[2],
      label: row[3],
      weekIds: safeParseJson(row[4], []),
      topics: safeParseJson(row[5], []),
      cards: safeParseJson(row[6], [])
    }));
  return jsonResponse({ ok: true, sets });
}

// ---- Shared helpers ----

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function getDataRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

function findRowByValue(sheet, col, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return -1;
  const values = sheet.getRange(1, col, lastRow, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() === value) {
      return i + 1;
    }
  }
  return -1;
}

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
