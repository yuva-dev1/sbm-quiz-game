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
 *   API_KEY       — shared secret, matches SELF_STUDY_SHEETS_ENDPOINT.apiKey (unchanged).
 *   APP_URL       — public URL of the self-study app, used to build reset links,
 *                   e.g. https://bhagavatham-self-study-876193044983.us-central1.run.app
 *   LOGO_URL      — (optional) image URL for the GOD logo in the email footer.
 *                   Defaults to DEFAULT_LOGO_URL below.
 *   CONTACT_EMAIL — (optional) shown as a "Questions?" line in the email footer.
 *
 * Sends two branded HTML emails via MailApp: a welcome on successful
 * registration, and a one-time link on a password-reset request. Both are
 * best-effort — a mail failure never fails the underlying request.
 *
 * After pasting, run authorize() once from the editor to grant the mail +
 * external-request scopes (MailApp, UrlFetchApp), then redeploy.
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

// Email theme — pulled from the self-study app's own brand tokens.
const BRAND_INDIGO = '#2E3192';
const BRAND_INK = '#20255D';
const BRAND_GOLD = '#99610B';
const DEFAULT_LOGO_URL = 'https://godivinity.org/wp-content/uploads/2018/05/GOD-LOGO-1024x617.jpg';

/** Run once from the editor after pasting, to surface the OAuth consent screen
 *  for the MailApp (send email) and UrlFetchApp (fetch logo) scopes. */
function authorize() {
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch(DEFAULT_LOGO_URL, { muteHttpExceptions: true });
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

    // The account is created; a welcome-email failure must not fail registration.
    try {
      sendWelcomeEmail(email, regNo);
    } catch (err) {
      console.error('welcome email failed for ' + regNo + ': ' + err.message);
    }
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
        // Swallow send failures — this endpoint must always answer { ok: true }
        // (a surfaced error would reveal that this regNo + email is real).
        try {
          sendResetEmail(email, regNo, token);
        } catch (err) {
          console.error('reset email failed for ' + regNo + ': ' + err.message);
        }
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

/** Public base URL of the self-study app. A reset email is useless without it
 *  (the link would be host-relative), so a missing value is a hard error rather
 *  than a silently-broken link. */
function requireAppUrl_() {
  const appUrl = String(PropertiesService.getScriptProperties().getProperty('APP_URL') || '').replace(/\/+$/, '');
  if (!appUrl) throw new Error('APP_URL script property is not set.');
  return appUrl;
}

function sendResetEmail(email, regNo, token) {
  const appUrl = requireAppUrl_();
  const link = appUrl + '/?token=' + encodeURIComponent(token) + '&reg=' + encodeURIComponent(regNo);

  const plainBody =
    'Radhe Radhe,\n\n' +
    'We received a request to reset the password for registration number ' + regNo +
    ' on Bhagavatam Self Study.\n\n' +
    'Open this link to choose a new password (valid for 1 hour):\n' + link + '\n\n' +
    'If you did not request this, you can safely ignore this email - your password will not change.';

  // Escape the URL for HTML contexts: its "&reg=" separator is otherwise parsed
  // as the ® named character reference by mail clients, corrupting the link.
  const linkHtml = escapeHtml_(link);

  const bodyHtml =
    '<p style="margin:0 0 14px;">Radhe Radhe,</p>' +
    '<p style="margin:0 0 24px;">We received a request to reset the password for registration number ' +
      '<strong style="color:' + BRAND_INK + ';">' + escapeHtml_(regNo) + '</strong>.</p>' +
    ctaButton_(linkHtml, 'Choose a new password') +
    '<p style="margin:0 0 6px;font-size:12px;color:#8a8f98;text-align:center;">' +
      'This link is valid for one hour. If the button doesn\'t work, paste this link into your browser:</p>' +
    '<p style="margin:0 0 6px;font-size:12px;text-align:center;word-break:break-all;">' +
      '<span style="color:' + BRAND_INDIGO + ';">' + linkHtml + '</span></p>' +
    '<div style="margin:24px 0 0;padding:14px 16px;background:#fffdf2;border-left:4px solid ' + BRAND_GOLD + ';' +
      'font-size:13px;color:#5b4a1e;">' +
      'If you did not request this, you can safely ignore this email &mdash; your password will not change.</div>';

  sendBrandedEmail_(email, 'Reset your Bhagavatam Self Study password', 'Reset your password', bodyHtml, plainBody);
}

function sendWelcomeEmail(email, regNo) {
  const appUrl = String(PropertiesService.getScriptProperties().getProperty('APP_URL') || '').replace(/\/+$/, '');

  const plainBody =
    'Radhe Radhe,\n\n' +
    'Thank you for registering for Bhagavatam Self Study. Your registration number is ' + regNo +
    ' - keep it handy, it is how you log in.\n\n' +
    'Bhagavatam Self Study is a personal companion for the Srimad Bhagavatam certification course. ' +
    'Pick a week and the topics you want to revisit, and it builds a quiz or a set of flashcards drawn ' +
    'straight from the course notes, so what you practice always matches what was taught. Work through ' +
    'them at your own pace; your quiz history and saved flashcard sets stay with your account for review.\n\n' +
    'Recalling the material for yourself is one of the most effective ways to retain it. Short, regular ' +
    'quizzes and flashcard reviews on each week\'s teachings help them settle in, and you can focus on ' +
    'whichever topics you find hardest.\n\n' +
    (appUrl ? 'Start here: ' + appUrl + '\n\n' : '') +
    'Radhe Radhe';

  const bodyHtml =
    '<p style="margin:0 0 14px;">Radhe Radhe,</p>' +
    '<p style="margin:0 0 20px;">Thank you for registering for <strong style="color:' + BRAND_INK + ';">' +
      'Bhagavatam Self Study</strong>. Your registration number is ' +
      '<strong style="color:' + BRAND_INK + ';">' + escapeHtml_(regNo) + '</strong> &mdash; keep it handy, ' +
      'it is how you log in.</p>' +
    '<p style="margin:0 0 16px;">Bhagavatam Self Study is a personal companion for the Srimad Bhagavatam ' +
      'certification course. Pick a week and the topics you want to revisit, and it builds a quiz or a set ' +
      'of flashcards drawn straight from the course notes &mdash; so what you practice always matches what ' +
      'was taught. Work through them at your own pace; your quiz history and saved flashcard sets stay with ' +
      'your account for review.</p>' +
    '<p style="margin:0 0 8px;">Recalling the material for yourself is one of the most effective ways to ' +
      'retain it. Short, regular quizzes and flashcard reviews on each week\'s teachings help them settle ' +
      'in, and you can focus on whichever topics you find hardest.</p>' +
    (appUrl ? ctaButton_(appUrl, 'Start studying') : '');

  sendBrandedEmail_(email, 'Welcome to Bhagavatam Self Study', 'Registration confirmed', bodyHtml, plainBody);
}

// ---- Email chrome (shared by every branded email) ----

/** Fetches the logo, wraps bodyHtml in the branded card, and sends. */
function sendBrandedEmail_(to, subject, title, bodyHtml, plainBody) {
  const logoBlob = getLogoBlob_();
  const options = {
    to: to,
    subject: subject,
    body: plainBody,
    htmlBody: renderBrandedEmail_(title, bodyHtml, !!logoBlob)
  };
  if (logoBlob) options.inlineImages = { godLogo: logoBlob };
  MailApp.sendEmail(options);
}

/** `href` must already be HTML-attribute-safe (see sendResetEmail's linkHtml). */
function ctaButton_(href, label) {
  return '<div style="text-align:center;margin:26px 0;">' +
    '<a href="' + href + '" style="display:inline-block;background:' + BRAND_INDIGO + ';color:#ffffff;' +
      'text-decoration:none;font-family:Georgia,serif;font-size:15px;font-weight:600;padding:13px 34px;' +
      'border-radius:8px;">' + label + '</a>' +
  '</div>';
}

function renderBrandedEmail_(title, bodyHtml, hasLogo) {
  const contactEmail = PropertiesService.getScriptProperties().getProperty('CONTACT_EMAIL') || '';
  return '' +
    '<div style="margin:0;padding:24px 12px;background:#f4f2ec;">' +
      '<div style="font-family:Georgia,\'Times New Roman\',serif;max-width:560px;margin:0 auto;background:#ffffff;' +
        'border:2px solid ' + BRAND_INDIGO + ';border-radius:16px;overflow:hidden;">' +

        '<div style="background:' + BRAND_INDIGO + ';padding:26px 30px;text-align:center;color:#ffffff;">' +
          '<h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:.01em;">' + title + '</h1>' +
          '<p style="margin:7px 0 0;font-size:11px;color:#c9cbe8;letter-spacing:.22em;text-transform:uppercase;">' +
            'Bhagavatam Self Study</p>' +
        '</div>' +

        '<div style="padding:32px 34px;color:#2c3e50;font-size:15px;line-height:1.65;">' +
          bodyHtml +
          '<div style="margin-top:30px;border-top:1px solid #ecebe3;padding-top:22px;text-align:center;">' +
            (contactEmail
              ? '<p style="margin:0 0 12px;font-size:13px;color:#8a8f98;">Questions? ' +
                  '<a href="mailto:' + contactEmail + '" style="color:' + BRAND_INDIGO + ';text-decoration:none;">' +
                  escapeHtml_(contactEmail) + '</a></p>'
              : '') +
            '<p style="margin:0 0 12px;font-size:13px;font-weight:bold;color:' + BRAND_GOLD + ';">' +
              'Global Organization of Divinity</p>' +
            (hasLogo
              ? '<img src="cid:godLogo" width="130" alt="Global Organization of Divinity" style="display:inline-block;">'
              : '') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
}

/** Fetches the GOD logo for the email footer. Returns null (and the email
 *  still sends, just without the image) if the fetch fails. */
function getLogoBlob_() {
  try {
    const url = PropertiesService.getScriptProperties().getProperty('LOGO_URL') || DEFAULT_LOGO_URL;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return null;
    return res.getBlob().setName('godLogo');
  } catch (err) {
    return null;
  }
}

function escapeHtml_(value) {
  return String(value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
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
