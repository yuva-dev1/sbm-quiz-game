/**
 * Google Apps Script web app backing the Srimad Bhagavatam Self-Paced Course
 * sheet (Users / Weeks / Attempts tabs).
 *
 * Standalone project (not bound to the Sheet) — it opens the Sheet by id from
 * the SHEET_ID script property, so the script's lifecycle is independent of
 * the spreadsheet.
 *
 * Deploy: script.google.com > New project, paste this in, set the script
 * properties below, run authorize() once to grant the mail + external-request
 * scopes, then Deploy > New deployment > Web app ("Execute as: Me",
 * "Who has access: Anyone"). Copy the /exec URL. On later edits use
 * Deploy > Manage deployments > edit > Version: New version so the URL is kept
 * stable.
 *
 * Script Properties (Project Settings > Script Properties):
 *   SHEET_ID      — id of the target Google Sheet (from its URL). Required.
 *   API_KEY       — shared secret, matches SELF_PACED_SHEETS_ENDPOINT.apiKey.
 *   APP_URL       — public URL of the self-paced course app, used to build
 *                   password-reset links, e.g. https://<subdomain>
 *   LOGO_URL      — (optional) image URL for the GOD logo in the email footer.
 *   CONTACT_EMAIL — (optional) "Questions?" line in the email footer.
 *
 * Sends a branded welcome email on registration and a one-time reset link on
 * a password-reset request. Both are best-effort — a mail failure never fails
 * the underlying request.
 *
 * Tabs are created automatically the first time they're needed.
 */

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// `Name` stays as the combined "First Last" for the welcome email, the
// Attempts denorm, and the host scores grid; FirstName/LastName are the
// separately-captured fields. Adding a column requires the Users tab to be
// recreated (getOrCreateSheet only writes headers on first creation).
const USERS_HEADERS = ['FirstName', 'LastName', 'Name', 'Email', 'PasswordHash', 'CreatedAt', 'ResetTokenHash', 'ResetTokenExpiresAt'];
const WEEKS_HEADERS = ['WeekNumber', 'Title', 'Summary', 'Status', 'LessonsJSON', 'QuizJSON', 'ResponsesOpen', 'OpensAt', 'ClosesAt', 'UpdatedAt'];
const ATTEMPTS_HEADERS = ['AttemptId', 'Email', 'Name', 'WeekNumber', 'SubmittedAt', 'CorrectCount', 'TotalQuestions', 'Percentage', 'AnswersJSON'];

const BRAND_INDIGO = '#2E3192';
const BRAND_INK = '#20255D';
const BRAND_GOLD = '#99610B';
const DEFAULT_LOGO_URL = 'https://godivinity.org/wp-content/uploads/2018/05/GOD-LOGO-1024x617.jpg';

/** Run once from the editor after pasting + setting SHEET_ID, to surface the
 *  OAuth consent for the Spreadsheet, MailApp (send email) and UrlFetchApp
 *  (fetch logo) scopes. Also creates the three tabs up front. */
function authorize() {
  getOrCreateSheet('Users', USERS_HEADERS);
  getOrCreateSheet('Weeks', WEEKS_HEADERS);
  getOrCreateSheet('Attempts', ATTEMPTS_HEADERS);
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch(DEFAULT_LOGO_URL, { muteHttpExceptions: true });
}

function doPost(e) {
  try {
    return handleRequest(e);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Server error: ' + err.message });
  }
}

function handleRequest(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' });
  }

  var expectedKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expectedKey || body.apiKey !== expectedKey) {
    return jsonResponse({ ok: false, error: 'Unauthorized.' });
  }

  switch (body.action) {
    case 'register':
      return handleRegister(body);
    case 'login':
      return handleLogin(body);
    case 'requestPasswordReset':
      return handleRequestPasswordReset(body);
    case 'resetPassword':
      return handleResetPassword(body);
    case 'listWeeks':
      return handleListWeeks(body);
    case 'upsertWeek':
      return handleUpsertWeek(body);
    case 'setWeekStatus':
      return handleSetWeekStatus(body);
    case 'getWeek':
      return handleGetWeek(body);
    case 'saveAttempt':
      return handleSaveAttempt(body);
    case 'listAttempts':
      return handleListAttempts(body);
    case 'listAllAttempts':
      return handleListAllAttempts();
    default:
      return jsonResponse({ ok: false, error: 'Unknown action: ' + body.action });
  }
}

// ---------------------------------------------------------------------- Accounts

function usersSheet() {
  return getOrCreateSheet('Users', USERS_HEADERS);
}

function usersCol(name) {
  return USERS_HEADERS.indexOf(name) + 1;
}

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function handleRegister(body) {
  var firstName = String(body.firstName || '').trim();
  var lastName = String(body.lastName || '').trim();
  var name = (firstName + ' ' + lastName).trim();
  var email = normEmail(body.email);
  var passwordHash = String(body.passwordHash || '');
  if (!firstName || !lastName) return jsonResponse({ ok: false, error: 'First and last name are required.' });
  if (!EMAIL_PATTERN.test(email)) return jsonResponse({ ok: false, error: 'A valid email address is required.' });
  if (!passwordHash) return jsonResponse({ ok: false, error: 'Missing passwordHash.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = usersSheet();
    if (findRowByValue(sheet, usersCol('Email'), email.toUpperCase()) !== -1) {
      return jsonResponse({ ok: false, error: 'An account with this email address already exists.' });
    }
    var row = [];
    row[usersCol('FirstName') - 1] = firstName;
    row[usersCol('LastName') - 1] = lastName;
    row[usersCol('Name') - 1] = name;
    row[usersCol('Email') - 1] = email;
    row[usersCol('PasswordHash') - 1] = passwordHash;
    row[usersCol('CreatedAt') - 1] = new Date().toISOString();
    row[usersCol('ResetTokenHash') - 1] = '';
    row[usersCol('ResetTokenExpiresAt') - 1] = '';
    sheet.appendRow(row);

    try {
      sendWelcomeEmail(email, name);
    } catch (err) {
      console.error('welcome email failed for ' + email + ': ' + err.message);
    }
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function handleLogin(body) {
  var email = normEmail(body.email);
  var sheet = usersSheet();
  var row = findRowByValue(sheet, usersCol('Email'), email.toUpperCase());
  if (row === -1) return jsonResponse({ ok: false, error: 'No account with this email address.' });
  return jsonResponse({
    ok: true,
    passwordHash: String(sheet.getRange(row, usersCol('PasswordHash')).getValue()),
    name: String(sheet.getRange(row, usersCol('Name')).getValue())
  });
}

function userNameByEmail(email) {
  var sheet = usersSheet();
  var row = findRowByValue(sheet, usersCol('Email'), String(email || '').toUpperCase());
  return row === -1 ? '' : String(sheet.getRange(row, usersCol('Name')).getValue());
}

// ---------------------------------------------------------------- Password reset

function handleRequestPasswordReset(body) {
  var email = normEmail(body.email);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = usersSheet();
    var row = findRowByValue(sheet, usersCol('Email'), email.toUpperCase());
    if (row !== -1 && EMAIL_PATTERN.test(email)) {
      var token = randomToken();
      sheet.getRange(row, usersCol('ResetTokenHash')).setValue(sha256Hex(token));
      sheet.getRange(row, usersCol('ResetTokenExpiresAt')).setValue(Date.now() + RESET_TOKEN_TTL_MS);
      SpreadsheetApp.flush();
      try {
        sendResetEmail(email, token);
      } catch (err) {
        console.error('reset email failed for ' + email + ': ' + err.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
  // Never reveal whether the account matched.
  return jsonResponse({ ok: true });
}

function handleResetPassword(body) {
  var email = normEmail(body.email);
  var token = String(body.token || '');
  var passwordHash = String(body.passwordHash || '');
  if (!token || !passwordHash) return jsonResponse({ ok: false, error: 'Missing reset token or password.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = usersSheet();
    var row = findRowByValue(sheet, usersCol('Email'), email.toUpperCase());
    var invalid = jsonResponse({ ok: false, error: 'This reset link is invalid or has expired. Request a new one.' });
    if (row === -1) return invalid;

    var storedHash = String(sheet.getRange(row, usersCol('ResetTokenHash')).getValue());
    var expiresAt = Number(sheet.getRange(row, usersCol('ResetTokenExpiresAt')).getValue());
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

// ------------------------------------------------------------------------- Weeks

function weeksSheet() {
  return getOrCreateSheet('Weeks', WEEKS_HEADERS);
}

function weeksCol(name) {
  return WEEKS_HEADERS.indexOf(name) + 1;
}

function weekRowToObject(values) {
  return {
    weekNumber: Number(values[weeksCol('WeekNumber') - 1]),
    title: String(values[weeksCol('Title') - 1] || ''),
    summary: String(values[weeksCol('Summary') - 1] || ''),
    status: String(values[weeksCol('Status') - 1] || 'DRAFT'),
    lessons: safeParseJson(values[weeksCol('LessonsJSON') - 1], []),
    quiz: safeParseJson(values[weeksCol('QuizJSON') - 1], []),
    responsesOpen: values[weeksCol('ResponsesOpen') - 1] === true ||
      String(values[weeksCol('ResponsesOpen') - 1]).toLowerCase() === 'true',
    opensAt: values[weeksCol('OpensAt') - 1] ? String(values[weeksCol('OpensAt') - 1]) : null,
    closesAt: values[weeksCol('ClosesAt') - 1] ? String(values[weeksCol('ClosesAt') - 1]) : null,
    updatedAt: values[weeksCol('UpdatedAt') - 1] ? String(values[weeksCol('UpdatedAt') - 1]) : null
  };
}

function handleListWeeks(body) {
  var includeUnpublished = body.includeUnpublished === true;
  var sheet = weeksSheet();
  var rows = getDataRows(sheet);
  var weeks = rows
    .map(weekRowToObject)
    .filter(function (w) { return includeUnpublished || w.status === 'PUBLISHED'; });
  return jsonResponse({ ok: true, weeks: weeks });
}

function handleGetWeek(body) {
  var weekNumber = Number(body.weekNumber);
  var sheet = weeksSheet();
  var row = findRowByValue(sheet, weeksCol('WeekNumber'), String(weekNumber));
  if (row === -1) return jsonResponse({ ok: true, week: null });
  var values = sheet.getRange(row, 1, 1, WEEKS_HEADERS.length).getValues()[0];
  return jsonResponse({ ok: true, week: weekRowToObject(values) });
}

function handleUpsertWeek(body) {
  var week = body.week || {};
  var weekNumber = Number(week.weekNumber);
  if (!weekNumber || weekNumber < 1) return jsonResponse({ ok: false, error: 'A positive week number is required.' });
  var title = String(week.title || '').trim();
  if (!title) return jsonResponse({ ok: false, error: 'A week title is required.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = weeksSheet();
    var row = findRowByValue(sheet, weeksCol('WeekNumber'), String(weekNumber));
    var now = new Date().toISOString();
    var lessonsJson = JSON.stringify(week.lessons || []);
    var quizJson = JSON.stringify(week.quiz || []);
    var opensAt = week.opensAt ? String(week.opensAt) : '';
    var closesAt = week.closesAt ? String(week.closesAt) : '';

    if (row === -1) {
      var newRow = [];
      newRow[weeksCol('WeekNumber') - 1] = weekNumber;
      newRow[weeksCol('Title') - 1] = title;
      newRow[weeksCol('Summary') - 1] = String(week.summary || '');
      newRow[weeksCol('Status') - 1] = 'DRAFT';
      newRow[weeksCol('LessonsJSON') - 1] = lessonsJson;
      newRow[weeksCol('QuizJSON') - 1] = quizJson;
      newRow[weeksCol('ResponsesOpen') - 1] = false;
      newRow[weeksCol('OpensAt') - 1] = opensAt;
      newRow[weeksCol('ClosesAt') - 1] = closesAt;
      newRow[weeksCol('UpdatedAt') - 1] = now;
      sheet.appendRow(newRow);
    } else {
      sheet.getRange(row, weeksCol('Title')).setValue(title);
      sheet.getRange(row, weeksCol('Summary')).setValue(String(week.summary || ''));
      sheet.getRange(row, weeksCol('LessonsJSON')).setValue(lessonsJson);
      sheet.getRange(row, weeksCol('QuizJSON')).setValue(quizJson);
      sheet.getRange(row, weeksCol('OpensAt')).setValue(opensAt);
      sheet.getRange(row, weeksCol('ClosesAt')).setValue(closesAt);
      sheet.getRange(row, weeksCol('UpdatedAt')).setValue(now);
    }
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function handleSetWeekStatus(body) {
  var weekNumber = Number(body.weekNumber);
  var patch = body.patch || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = weeksSheet();
    var row = findRowByValue(sheet, weeksCol('WeekNumber'), String(weekNumber));
    if (row === -1) return jsonResponse({ ok: false, error: 'No such week.' });
    if (patch.status === 'PUBLISHED' || patch.status === 'DRAFT') {
      sheet.getRange(row, weeksCol('Status')).setValue(patch.status);
    }
    if (typeof patch.responsesOpen === 'boolean') {
      sheet.getRange(row, weeksCol('ResponsesOpen')).setValue(patch.responsesOpen);
    }
    sheet.getRange(row, weeksCol('UpdatedAt')).setValue(new Date().toISOString());
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------- Attempts

function attemptsSheet() {
  return getOrCreateSheet('Attempts', ATTEMPTS_HEADERS);
}

function handleSaveAttempt(body) {
  var a = body.attempt || {};
  var email = normEmail(a.email);
  if (!EMAIL_PATTERN.test(email)) return jsonResponse({ ok: false, error: 'A valid email is required.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = attemptsSheet();
    sheet.appendRow([
      String(a.id || Utilities.getUuid()),
      email,
      userNameByEmail(email),
      Number(a.weekNumber || 0),
      String(a.submittedAt || new Date().toISOString()),
      Number(a.correctCount || 0),
      Number(a.totalQuestions || 0),
      Number(a.percentage || 0),
      JSON.stringify(a.answers || [])
    ]);
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function attemptRowToObject(row) {
  return {
    id: row[0],
    email: row[1],
    name: row[2],
    weekNumber: Number(row[3]),
    submittedAt: row[4],
    correctCount: Number(row[5]),
    totalQuestions: Number(row[6]),
    percentage: Number(row[7]),
    answers: safeParseJson(row[8], [])
  };
}

function handleListAttempts(body) {
  var email = normEmail(body.email);
  var rows = getDataRows(attemptsSheet());
  var attempts = rows
    .filter(function (row) { return String(row[1]).trim().toLowerCase() === email; })
    .map(attemptRowToObject);
  return jsonResponse({ ok: true, attempts: attempts });
}

function handleListAllAttempts() {
  var rows = getDataRows(attemptsSheet());
  return jsonResponse({ ok: true, attempts: rows.map(attemptRowToObject) });
}

// ------------------------------------------------------------------------ Emails

function requireAppUrl_() {
  var appUrl = String(PropertiesService.getScriptProperties().getProperty('APP_URL') || '').replace(/\/+$/, '');
  if (!appUrl) throw new Error('APP_URL script property is not set.');
  return appUrl;
}

function sendResetEmail(email, token) {
  var appUrl = requireAppUrl_();
  var link = appUrl + '/reset?token=' + encodeURIComponent(token) + '&email=' + encodeURIComponent(email);

  var plainBody =
    'Radhe Radhe,\n\n' +
    'We received a request to reset the password for ' + email +
    ' on the Srimad Bhagavatam Self-Paced Course.\n\n' +
    'Open this link to choose a new password (valid for 1 hour):\n' + link + '\n\n' +
    'If you did not request this, you can safely ignore this email - your password will not change.';

  var linkHtml = escapeHtml_(link);
  var bodyHtml =
    '<p style="margin:0 0 14px;">Radhe Radhe,</p>' +
    '<p style="margin:0 0 24px;">We received a request to reset the password for ' +
      '<strong style="color:' + BRAND_INK + ';">' + escapeHtml_(email) + '</strong>.</p>' +
    ctaButton_(linkHtml, 'Choose a new password') +
    '<p style="margin:0 0 6px;font-size:12px;color:#8a8f98;text-align:center;">' +
      'This link is valid for one hour. If the button doesn\'t work, paste this link into your browser:</p>' +
    '<p style="margin:0 0 6px;font-size:12px;text-align:center;word-break:break-all;">' +
      '<span style="color:' + BRAND_INDIGO + ';">' + linkHtml + '</span></p>' +
    '<div style="margin:24px 0 0;padding:14px 16px;background:#fffdf2;border-left:4px solid ' + BRAND_GOLD + ';' +
      'font-size:13px;color:#5b4a1e;">' +
      'If you did not request this, you can safely ignore this email &mdash; your password will not change.</div>';

  sendBrandedEmail_(email, 'Reset your Self-Paced Course password', 'Reset your password', bodyHtml, plainBody);
}

function sendWelcomeEmail(email, name) {
  var appUrl = String(PropertiesService.getScriptProperties().getProperty('APP_URL') || '').replace(/\/+$/, '');
  var greetingName = name ? (' ' + name) : '';

  var plainBody =
    'Radhe Radhe' + greetingName + ',\n\n' +
    'Welcome to the Srimad Bhagavatam Self-Paced Course. Log in any time with your email and password ' +
    'to watch each week\'s lesson, take that week\'s quiz, and review all of your past attempts.\n\n' +
    (appUrl ? 'Start here: ' + appUrl + '\n\n' : '') +
    'Radhe Radhe';

  var bodyHtml =
    '<p style="margin:0 0 14px;">Radhe Radhe' + escapeHtml_(greetingName) + ',</p>' +
    '<p style="margin:0 0 16px;">Welcome to the <strong style="color:' + BRAND_INK + ';">Srimad Bhagavatam ' +
      'Self-Paced Course</strong>. Log in any time with your email and password to watch each week\'s ' +
      'lesson, take that week\'s quiz, and review all of your past attempts.</p>' +
    (appUrl ? ctaButton_(escapeHtml_(appUrl), 'Open the course') : '');

  sendBrandedEmail_(email, 'Welcome to the Srimad Bhagavatam Self-Paced Course', 'You\'re enrolled', bodyHtml, plainBody);
}

function sendBrandedEmail_(to, subject, title, bodyHtml, plainBody) {
  var logoBlob = getLogoBlob_();
  var options = { to: to, subject: subject, body: plainBody, htmlBody: renderBrandedEmail_(title, bodyHtml, !!logoBlob) };
  if (logoBlob) options.inlineImages = { godLogo: logoBlob };
  MailApp.sendEmail(options);
}

function ctaButton_(href, label) {
  return '<div style="text-align:center;margin:26px 0;">' +
    '<a href="' + href + '" style="display:inline-block;background:' + BRAND_INDIGO + ';color:#ffffff;' +
      'text-decoration:none;font-family:Georgia,serif;font-size:15px;font-weight:600;padding:13px 34px;' +
      'border-radius:8px;">' + label + '</a></div>';
}

function renderBrandedEmail_(title, bodyHtml, hasLogo) {
  var contactEmail = PropertiesService.getScriptProperties().getProperty('CONTACT_EMAIL') || '';
  return '' +
    '<div style="margin:0;padding:24px 12px;background:#f4f2ec;">' +
      '<div style="font-family:Georgia,\'Times New Roman\',serif;max-width:560px;margin:0 auto;background:#ffffff;' +
        'border:2px solid ' + BRAND_INDIGO + ';border-radius:16px;overflow:hidden;">' +
        '<div style="background:' + BRAND_INDIGO + ';padding:26px 30px;text-align:center;color:#ffffff;">' +
          '<h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:.01em;">' + title + '</h1>' +
          '<p style="margin:7px 0 0;font-size:11px;color:#c9cbe8;letter-spacing:.22em;text-transform:uppercase;">' +
            'Srimad Bhagavatam Self-Paced Course</p>' +
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

function getLogoBlob_() {
  try {
    var url = PropertiesService.getScriptProperties().getProperty('LOGO_URL') || DEFAULT_LOGO_URL;
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
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

// --------------------------------------------------------------------- Helpers

function randomToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function sha256Hex(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function targetSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property is not set.');
  return SpreadsheetApp.openById(id);
}

function getOrCreateSheet(name, headers) {
  var ss = targetSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function getDataRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

function findRowByValue(sheet, col, value) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return -1;
  var values = sheet.getRange(1, col, lastRow, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() === String(value).toUpperCase()) {
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
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
