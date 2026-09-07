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
 *   Members  : SiteUserId, Email, FirstName, LastName, FirstSeenAt
 *              (identity cached from the Squarespace Profiles API by the app server)
 *   Weeks    : WeekNumber, Title, Status, QuizJSON, ResponsesOpen, OpensAt, ClosesAt, UpdatedAt
 *   Attempts : AttemptId, SiteUserId, Email, Name, WeekNumber, SubmittedAt,
 *              CorrectCount, TotalQuestions, Percentage, AnswersJSON
 */

const MEMBERS_HEADERS = ['SiteUserId', 'Email', 'FirstName', 'LastName', 'FirstSeenAt'];
const WEEKS_HEADERS = ['WeekNumber', 'Title', 'Status', 'QuizJSON', 'ResponsesOpen', 'OpensAt', 'ClosesAt', 'UpdatedAt'];
const ATTEMPTS_HEADERS = ['AttemptId', 'SiteUserId', 'Email', 'Name', 'WeekNumber', 'SubmittedAt', 'CorrectCount', 'TotalQuestions', 'Percentage', 'AnswersJSON'];

/** Run once from the editor after pasting + setting SHEET_ID, to grant the
 *  Spreadsheet scope and create the three tabs. */
function authorize() {
  getOrCreateSheet('Members', MEMBERS_HEADERS);
  getOrCreateSheet('Weeks', WEEKS_HEADERS);
  getOrCreateSheet('Attempts', ATTEMPTS_HEADERS);
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
    updatedAt: values[weeksCol('UpdatedAt') - 1] ? String(values[weeksCol('UpdatedAt') - 1]) : null
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
    var sheet = weeksSheet();
    var row = findRowByValue(sheet, weeksCol('WeekNumber'), String(weekNumber));
    var now = new Date().toISOString();
    var quizJson = JSON.stringify(week.quiz || []);
    var opensAt = week.opensAt ? String(week.opensAt) : '';
    var closesAt = week.closesAt ? String(week.closesAt) : '';

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
      sheet.appendRow(newRow);
    } else {
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
    siteUserId: row[1],
    email: row[2],
    name: row[3],
    weekNumber: Number(row[4]),
    submittedAt: row[5],
    correctCount: Number(row[6]),
    totalQuestions: Number(row[7]),
    percentage: Number(row[8]),
    answers: safeParseJson(row[9], [])
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
