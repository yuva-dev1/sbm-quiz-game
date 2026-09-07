/**
 * Google Apps Script web app backing the Srimad Bhagavatam Self-Paced Course
 * quiz sheet — Members / Weeks / Attempts tabs.
 *
 * Standalone project (not bound to the Sheet) — opens the Sheet by id from
 * the SHEET_ID script property, so the script's lifecycle is independent of
 * the spreadsheet.
 *
 * Deploy: script.google.com > New project, paste this in, set the script
 * properties below, run authorize() once, then Deploy > New deployment >
 * Web app ("Execute as: Me", "Who has access: Anyone"). On later edits use
 * Deploy > Manage deployments > edit > Version: New version so the /exec URL
 * stays stable.
 *
 * Script Properties (Project Settings > Script Properties):
 *   SHEET_ID  — id of the target Google Sheet (from its URL). Required.
 *   API_KEY   — shared secret, matches SELF_PACED_SHEETS_ENDPOINT.apiKey.
 *
 * Tabs are created automatically the first time they're needed.
 *
 *   Members      : SiteUserId, Email, FirstName, LastName, FirstSeenAt
 *                  (identity cached from the Squarespace Profiles API by the app server)
 *   Weeks        : WeekNumber, Title, Status, QuizJSON, ResponsesOpen, OpensAt, ClosesAt,
 *                  UpdatedAt, LiveVersion
 *                  (QuizJSON is always a copy of the live version's questions, so
 *                  reads/grading never need the QuizVersions tab)
 *   Attempts     : AttemptId, SiteUserId, Email, Name, WeekNumber, SubmittedAt,
 *                  CorrectCount, TotalQuestions, Percentage, AnswersJSON, QuizVersion
 *   QuizVersions : WeekNumber, Version, Label, QuizJSON, CreatedAt
 *                  (append-only history — one row per saved edit of a week's quiz)
 */

const MEMBERS_HEADERS = ['SiteUserId', 'Email', 'FirstName', 'LastName', 'FirstSeenAt'];
const WEEKS_HEADERS = ['WeekNumber', 'Title', 'Status', 'QuizJSON', 'ResponsesOpen', 'OpensAt', 'ClosesAt', 'UpdatedAt', 'LiveVersion'];
const ATTEMPTS_HEADERS = ['AttemptId', 'SiteUserId', 'Email', 'Name', 'WeekNumber', 'SubmittedAt', 'CorrectCount', 'TotalQuestions', 'Percentage', 'AnswersJSON', 'QuizVersion'];
const QUIZ_VERSIONS_HEADERS = ['WeekNumber', 'Version', 'Label', 'QuizJSON', 'CreatedAt'];

/** Run once from the editor after pasting + setting SHEET_ID, to grant the
 *  Spreadsheet scope and create the three tabs. */
function authorize() {
  getOrCreateSheet('Members', MEMBERS_HEADERS);
  getOrCreateSheet('Weeks', WEEKS_HEADERS);
  getOrCreateSheet('Attempts', ATTEMPTS_HEADERS);
  getOrCreateSheet('QuizVersions', QUIZ_VERSIONS_HEADERS);
  ensureColumn(weeksSheet(), 'LiveVersion');
  ensureColumn(attemptsSheet(), 'QuizVersion');
}

/**
 * One-time migration: give every week that already has a quiz a "Version 1"
 * row in QuizVersions and point LiveVersion at it. Safe to run more than once —
 * it skips weeks that already have version rows. Run from the editor.
 */
function backfillVersions() {
  getOrCreateSheet('QuizVersions', QUIZ_VERSIONS_HEADERS);
  ensureColumn(weeksSheet(), 'LiveVersion');
  ensureColumn(attemptsSheet(), 'QuizVersion');

  var sheet = weeksSheet();
  var rows = getDataRows(sheet);
  var report = [];
  for (var i = 0; i < rows.length; i++) {
    var week = weekRowToObject(rows[i]);
    var rowIndex = i + 2;
    var existing = listVersionsFor(week.weekNumber);
    if (existing.length > 0) { report.push('week ' + week.weekNumber + ': already has ' + existing.length + ' version(s)'); continue; }
    if (!week.quiz || week.quiz.length === 0) { report.push('week ' + week.weekNumber + ': no quiz, skipped'); continue; }
    var createdAt = week.updatedAt || new Date().toISOString();
    appendVersionRow(week.weekNumber, 1, 'Initial', JSON.stringify(week.quiz), createdAt);
    sheet.getRange(rowIndex, weeksCol('LiveVersion')).setValue(1);
    report.push('week ' + week.weekNumber + ': created Version 1');
  }
  Logger.log(report.join('\n'));
  return report;
}

/** Append `name` as a new header column on `sheet` if it isn't there yet. */
function ensureColumn(sheet, name) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf(name) !== -1) return;
  sheet.getRange(1, lastCol + 1).setValue(name);
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
    case 'getMember':
      return handleGetMember(body);
    case 'upsertMember':
      return handleUpsertMember(body);
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
    case 'deleteAttempt':
      return handleDeleteAttempt(body);
    case 'listQuizVersions':
      return handleListQuizVersions(body);
    case 'getQuizVersion':
      return handleGetQuizVersion(body);
    case 'restoreQuizVersion':
      return handleRestoreQuizVersion(body);
    case 'labelQuizVersion':
      return handleLabelQuizVersion(body);
    default:
      return jsonResponse({ ok: false, error: 'Unknown action: ' + body.action });
  }
}

// ---------------------------------------------------------------------- Members

function membersSheet() {
  return getOrCreateSheet('Members', MEMBERS_HEADERS);
}

function membersCol(name) {
  return MEMBERS_HEADERS.indexOf(name) + 1;
}

function handleGetMember(body) {
  var sid = String(body.siteUserId || '').trim();
  if (!sid) return jsonResponse({ ok: true, member: null });
  var sheet = membersSheet();
  var row = findRowByValue(sheet, membersCol('SiteUserId'), sid);
  if (row === -1) return jsonResponse({ ok: true, member: null });
  var values = sheet.getRange(row, 1, 1, MEMBERS_HEADERS.length).getValues()[0];
  return jsonResponse({
    ok: true,
    member: {
      siteUserId: String(values[membersCol('SiteUserId') - 1]),
      email: String(values[membersCol('Email') - 1] || ''),
      firstName: String(values[membersCol('FirstName') - 1] || ''),
      lastName: String(values[membersCol('LastName') - 1] || '')
    }
  });
}

function handleUpsertMember(body) {
  var m = body.member || {};
  var sid = String(m.siteUserId || '').trim();
  if (!sid) return jsonResponse({ ok: false, error: 'siteUserId is required.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = membersSheet();
    var row = findRowByValue(sheet, membersCol('SiteUserId'), sid);
    if (row === -1) {
      var newRow = [];
      newRow[membersCol('SiteUserId') - 1] = sid;
      newRow[membersCol('Email') - 1] = String(m.email || '');
      newRow[membersCol('FirstName') - 1] = String(m.firstName || '');
      newRow[membersCol('LastName') - 1] = String(m.lastName || '');
      newRow[membersCol('FirstSeenAt') - 1] = String(m.firstSeenAt || new Date().toISOString());
      sheet.appendRow(newRow);
    } else {
      sheet.getRange(row, membersCol('Email')).setValue(String(m.email || ''));
      sheet.getRange(row, membersCol('FirstName')).setValue(String(m.firstName || ''));
      sheet.getRange(row, membersCol('LastName')).setValue(String(m.lastName || ''));
    }
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
  var liveVersionCol = weeksCol('LiveVersion');
  return {
    weekNumber: Number(values[weeksCol('WeekNumber') - 1]),
    title: String(values[weeksCol('Title') - 1] || ''),
    status: String(values[weeksCol('Status') - 1] || 'DRAFT'),
    quiz: safeParseJson(values[weeksCol('QuizJSON') - 1], []),
    responsesOpen:
      values[weeksCol('ResponsesOpen') - 1] === true ||
      String(values[weeksCol('ResponsesOpen') - 1]).toLowerCase() === 'true',
    opensAt: values[weeksCol('OpensAt') - 1] ? String(values[weeksCol('OpensAt') - 1]) : null,
    closesAt: values[weeksCol('ClosesAt') - 1] ? String(values[weeksCol('ClosesAt') - 1]) : null,
    updatedAt: values[weeksCol('UpdatedAt') - 1] ? String(values[weeksCol('UpdatedAt') - 1]) : null,
    liveVersion: liveVersionCol > 0 && values[liveVersionCol - 1] ? Number(values[liveVersionCol - 1]) : 0
  };
}

function handleListWeeks(body) {
  var includeUnpublished = body.includeUnpublished === true;
  var rows = getDataRows(weeksSheet());
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
  if (!title) return jsonResponse({ ok: false, error: 'A quiz title is required.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getOrCreateSheet('QuizVersions', QUIZ_VERSIONS_HEADERS);
    ensureColumn(weeksSheet(), 'LiveVersion');
    var sheet = weeksSheet();
    var row = findRowByValue(sheet, weeksCol('WeekNumber'), String(weekNumber));
    var now = new Date().toISOString();
    var quizJson = JSON.stringify(week.quiz || []);
    var opensAt = week.opensAt ? String(week.opensAt) : '';
    var closesAt = week.closesAt ? String(week.closesAt) : '';
    var hasQuestions = Array.isArray(week.quiz) && week.quiz.length > 0;

    if (row === -1) {
      var newRow = [];
      newRow[weeksCol('WeekNumber') - 1] = weekNumber;
      newRow[weeksCol('Title') - 1] = title;
      newRow[weeksCol('Status') - 1] = 'DRAFT';
      newRow[weeksCol('QuizJSON') - 1] = quizJson;
      newRow[weeksCol('ResponsesOpen') - 1] = false;
      newRow[weeksCol('OpensAt') - 1] = opensAt;
      newRow[weeksCol('ClosesAt') - 1] = closesAt;
      newRow[weeksCol('UpdatedAt') - 1] = now;
      newRow[weeksCol('LiveVersion') - 1] = hasQuestions ? 1 : '';
      sheet.appendRow(newRow);
      if (hasQuestions) appendVersionRow(weekNumber, 1, '', quizJson, now);
    } else {
      var currentJson = String(sheet.getRange(row, weeksCol('QuizJSON')).getValue() || '[]');
      // A new version is cut only when the QUESTIONS change — renaming the quiz
      // or moving its open/close dates doesn't spawn one.
      if (hasQuestions && quizJson !== currentJson) {
        var nextVersion = nextVersionNumber(weekNumber);
        appendVersionRow(weekNumber, nextVersion, '', quizJson, now);
        sheet.getRange(row, weeksCol('LiveVersion')).setValue(nextVersion);
      }
      sheet.getRange(row, weeksCol('Title')).setValue(title);
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
  var sid = String(a.siteUserId || '').trim();
  if (!sid) return jsonResponse({ ok: false, error: 'siteUserId is required.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureColumn(attemptsSheet(), 'QuizVersion');
    attemptsSheet().appendRow([
      String(a.id || Utilities.getUuid()),
      sid,
      String(a.email || ''),
      String(a.name || ''),
      Number(a.weekNumber || 0),
      String(a.submittedAt || new Date().toISOString()),
      Number(a.correctCount || 0),
      Number(a.totalQuestions || 0),
      Number(a.percentage || 0),
      JSON.stringify(a.answers || []),
      a.quizVersion ? Number(a.quizVersion) : ''
    ]);
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function attemptRowToObject(row) {
  return {
    id: row[0],
    siteUserId: row[1],
    email: row[2],
    name: row[3],
    weekNumber: Number(row[4]),
    submittedAt: row[5],
    correctCount: Number(row[6]),
    totalQuestions: Number(row[7]),
    percentage: Number(row[8]),
    answers: safeParseJson(row[9], []),
    quizVersion: row[10] ? Number(row[10]) : null
  };
}

function handleListAttempts(body) {
  var sid = String(body.siteUserId || '').trim();
  var rows = getDataRows(attemptsSheet());
  var attempts = rows
    .filter(function (row) { return String(row[1]).trim() === sid; })
    .map(attemptRowToObject);
  return jsonResponse({ ok: true, attempts: attempts });
}

function handleListAllAttempts() {
  var rows = getDataRows(attemptsSheet());
  return jsonResponse({ ok: true, attempts: rows.map(attemptRowToObject) });
}

/** Remove one attempt row by its AttemptId (host maintenance — deleting a
 *  bogus or test attempt). Every real attempt is otherwise kept forever. */
function handleDeleteAttempt(body) {
  var id = String(body.attemptId || '').trim();
  if (!id) return jsonResponse({ ok: false, error: 'attemptId is required.' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = attemptsSheet();
    var row = findRowByValue(sheet, 1, id); // AttemptId is column 1
    if (row === -1) return jsonResponse({ ok: false, error: 'No such attempt.' });
    sheet.deleteRow(row);
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------ QuizVersions

function quizVersionsSheet() {
  return getOrCreateSheet('QuizVersions', QUIZ_VERSIONS_HEADERS);
}

/** Raw QuizVersions rows for one week, oldest first: {version, label, quizJson, createdAt}. */
function listVersionsFor(weekNumber) {
  var rows = getDataRows(quizVersionsSheet());
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i][0]) !== Number(weekNumber)) continue;
    out.push({
      version: Number(rows[i][1]),
      label: String(rows[i][2] || ''),
      quizJson: String(rows[i][3] || '[]'),
      createdAt: String(rows[i][4] || '')
    });
  }
  out.sort(function (a, b) { return a.version - b.version; });
  return out;
}

function nextVersionNumber(weekNumber) {
  var versions = listVersionsFor(weekNumber);
  var max = 0;
  for (var i = 0; i < versions.length; i++) if (versions[i].version > max) max = versions[i].version;
  return max + 1;
}

function appendVersionRow(weekNumber, version, label, quizJson, createdAt) {
  quizVersionsSheet().appendRow([
    Number(weekNumber),
    Number(version),
    String(label || ''),
    String(quizJson || '[]'),
    String(createdAt || new Date().toISOString())
  ]);
}

function findVersionRow(weekNumber, version) {
  var sheet = quizVersionsSheet();
  var rows = getDataRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i][0]) === Number(weekNumber) && Number(rows[i][1]) === Number(version)) {
      return i + 2; // +2: header row + 1-indexed
    }
  }
  return -1;
}

function handleListQuizVersions(body) {
  var weekNumber = Number(body.weekNumber);
  var sheet = weeksSheet();
  var weekRow = findRowByValue(sheet, weeksCol('WeekNumber'), String(weekNumber));
  var liveVersion = 0;
  if (weekRow !== -1) {
    var v = sheet.getRange(weekRow, weeksCol('LiveVersion')).getValue();
    liveVersion = v ? Number(v) : 0;
  }
  var versions = listVersionsFor(weekNumber).map(function (r) {
    return { version: r.version, label: r.label, createdAt: r.createdAt, isLive: r.version === liveVersion };
  });
  return jsonResponse({ ok: true, liveVersion: liveVersion, versions: versions });
}

function handleGetQuizVersion(body) {
  var weekNumber = Number(body.weekNumber);
  var version = Number(body.version);
  var match = null;
  var all = listVersionsFor(weekNumber);
  for (var i = 0; i < all.length; i++) if (all[i].version === version) match = all[i];
  if (!match) return jsonResponse({ ok: false, error: 'No such version.' });
  return jsonResponse({
    ok: true,
    version: { version: match.version, label: match.label, createdAt: match.createdAt, quiz: safeParseJson(match.quizJson, []) }
  });
}

/** Point a week's live quiz back at an older version (a "restore"). Copies that
 *  version's questions into Weeks.QuizJSON and updates LiveVersion; no new
 *  version row is cut. */
function handleRestoreQuizVersion(body) {
  var weekNumber = Number(body.weekNumber);
  var version = Number(body.version);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureColumn(weeksSheet(), 'LiveVersion');
    var target = null;
    var all = listVersionsFor(weekNumber);
    for (var i = 0; i < all.length; i++) if (all[i].version === version) target = all[i];
    if (!target) return jsonResponse({ ok: false, error: 'No such version.' });

    var sheet = weeksSheet();
    var row = findRowByValue(sheet, weeksCol('WeekNumber'), String(weekNumber));
    if (row === -1) return jsonResponse({ ok: false, error: 'No such week.' });

    sheet.getRange(row, weeksCol('QuizJSON')).setValue(target.quizJson);
    sheet.getRange(row, weeksCol('LiveVersion')).setValue(version);
    sheet.getRange(row, weeksCol('UpdatedAt')).setValue(new Date().toISOString());
    return jsonResponse({ ok: true, liveVersion: version });
  } finally {
    lock.releaseLock();
  }
}

function handleLabelQuizVersion(body) {
  var weekNumber = Number(body.weekNumber);
  var version = Number(body.version);
  var label = String(body.label || '').slice(0, 120);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowIndex = findVersionRow(weekNumber, version);
    if (rowIndex === -1) return jsonResponse({ ok: false, error: 'No such version.' });
    quizVersionsSheet().getRange(rowIndex, 3).setValue(label); // Label is column 3
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

// --------------------------------------------------------------------- Helpers

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
    if (String(values[i][0]).trim() === String(value).trim()) {
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
