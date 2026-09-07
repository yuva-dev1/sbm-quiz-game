import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createHostCookie, clearHostCookie, readHost, requireHost } from './session.js';
import {
  getMember,
  upsertMember,
  listWeeksForHost,
  upsertWeek,
  setWeekStatus,
  getWeek,
  saveAttempt,
  listAttempts,
  listAllAttempts
} from './sheetsClient.js';
import { fetchMemberProfile, isPlausibleSiteUserId } from './squarespace.js';
import { gradeQuiz } from './grading.js';
import { describeWindowState, isAcceptingResponses } from './schedule.js';
import { normalizeGeneratedQuestions, toStudentQuestion } from './generatedQuestions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

const SESSION_SECRET = process.env.SELF_PACED_SESSION_SECRET || '';
const HOST_PASSCODE = process.env.HOST_PASSCODE || '';
const GENERATE_QUIZ_API_KEY = process.env.GENERATE_QUIZ_API_KEY || '';
// The Kahoot app's own /generate-quiz endpoint — see that repo's
// src/app/generate-quiz/route.ts for the request/response contract.
const UPSTREAM_QUIZ_URL =
  process.env.UPSTREAM_QUIZ_URL ||
  'https://sbm-quiz-game-876193044983.us-central1.run.app/generate-quiz';

// Generous outer safety net for a proxied generation; a little under the
// Cloud Run request timeout (see cloudbuild.yaml) so this fires first with a
// clean error rather than the connection being cut.
const GENERATE_TIMEOUT_MS = 570_000;

if (!SESSION_SECRET) console.warn('SELF_PACED_SESSION_SECRET is not set — the host cookie will not be secure.');
if (!HOST_PASSCODE) console.warn('HOST_PASSCODE is not set — the host area will be inaccessible.');
if (!process.env.SELF_PACED_SHEETS_ENDPOINT) console.warn('SELF_PACED_SHEETS_ENDPOINT is not set — weeks, members, and scores will fail.');
if (!GENERATE_QUIZ_API_KEY) console.warn('GENERATE_QUIZ_API_KEY is not set — quiz generation will fail.');
if (!process.env.SQUARESPACE_API_KEY) console.warn('SQUARESPACE_API_KEY is not set — student identity resolution will fail.');

const app = express();
app.use(express.json({ limit: '512kb' }));

function badRequest(res, message) {
  res.status(400).json({ error: message });
}

/** Sheet week row -> in-memory week with Date fields and parsed JSON. */
function hydrateWeek(row) {
  return {
    weekNumber: Number(row.weekNumber),
    title: String(row.title || ''),
    status: row.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
    quiz: Array.isArray(row.quiz) ? row.quiz : [],
    responsesOpen: Boolean(row.responsesOpen),
    opensAt: row.opensAt ? new Date(row.opensAt) : null,
    closesAt: row.closesAt ? new Date(row.closesAt) : null,
    updatedAt: row.updatedAt || null
  };
}

/**
 * Resolves a Squarespace `siteUserId` (from the course page's SiteUserInfo
 * cookie) to { siteUserId, email, firstName, lastName }. Reads the Members
 * sheet first; on a miss, calls the Squarespace Profiles API and caches the
 * result. Returns null when the id doesn't match a member of the course site.
 * Throws only on a transport / auth failure the caller should surface as 502.
 */
async function resolveMember(siteUserId) {
  if (!isPlausibleSiteUserId(siteUserId)) return null;

  const cached = await getMember(siteUserId).catch(() => ({ ok: false }));
  if (cached.ok && cached.member && cached.member.email) return cached.member;

  const profile = await fetchMemberProfile(siteUserId);
  if (!profile) return null;

  await upsertMember({
    siteUserId: profile.siteUserId,
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    firstSeenAt: new Date().toISOString()
  }).catch((error) => console.error('upsertMember failed:', error));

  return profile;
}

// --------------------------------------------------------------------- Host auth

app.post('/api/host/login', (req, res) => {
  const passcode = String(req.body?.passcode || '');
  if (!HOST_PASSCODE) {
    res.status(500).json({ error: 'The host area is not configured.' });
    return;
  }
  const a = Buffer.from(passcode);
  const b = Buffer.from(HOST_PASSCODE);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Incorrect passcode.' });
    return;
  }
  res.setHeader('Set-Cookie', createHostCookie(SESSION_SECRET));
  res.status(200).json({ ok: true });
});

app.post('/api/host/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearHostCookie());
  res.status(204).end();
});

app.get('/api/host/session', (req, res) => {
  res.json({ authenticated: readHost(req, SESSION_SECRET) });
});

// ------------------------------------------------ Quiz (Squarespace-embedded)

app.get('/api/q/:n', async (req, res) => {
  const weekNumber = Number(req.params.n);
  if (!Number.isInteger(weekNumber) || weekNumber < 1) return badRequest(res, 'Unknown quiz.');

  // Host preview: signed-in host opening /q/:n?preview=1 — no member, works on
  // a draft/closed quiz, nothing is saved.
  const preview = req.query.preview === '1' && readHost(req, SESSION_SECRET);

  let member = null;
  if (!preview) {
    const sid = String(req.query.sid || '').trim();
    if (!sid) {
      res.status(401).json({ error: 'Open this quiz from the course page so we know who you are.' });
      return;
    }
    try {
      member = await resolveMember(sid);
    } catch (error) {
      console.error('resolveMember error:', error);
      res.status(502).json({ error: 'Could not verify your course sign-in. Please try again.' });
      return;
    }
    if (!member) {
      res.status(403).json({ error: 'We could not find your course account. Make sure you are signed in to the course site.' });
      return;
    }
  }

  try {
    const result = await getWeek(weekNumber);
    if (!result.ok || !result.week) {
      res.status(404).json({ error: preview ? 'No quiz saved for this week yet.' : 'This quiz is not available yet.' });
      return;
    }
    const week = hydrateWeek(result.week);
    if (!preview && (week.status !== 'PUBLISHED' || week.quiz.length === 0)) {
      res.status(404).json({ error: 'This quiz is not available yet.' });
      return;
    }

    let bestPercentage = null;
    if (!preview) {
      const history = await listAttempts(member.siteUserId).catch(() => ({ ok: false }));
      const forWeek = (history.ok ? history.attempts || [] : []).filter((a) => Number(a.weekNumber) === weekNumber);
      bestPercentage = forWeek.length ? Math.max(...forWeek.map((a) => Number(a.percentage) || 0)) : null;
    }

    res.json({
      firstName: member ? member.firstName || '' : '',
      bestPercentage,
      preview,
      week: {
        weekNumber: week.weekNumber,
        title: week.title,
        windowState: describeWindowState(week),
        open: preview ? true : isAcceptingResponses(week),
        questions: week.quiz.map(toStudentQuestion)
      }
    });
  } catch (error) {
    console.error('load quiz error:', error);
    res.status(502).json({ error: 'Could not load the quiz right now. Please try again.' });
  }
});

app.post('/api/q/:n/submit', async (req, res) => {
  const weekNumber = Number(req.params.n);
  if (!Number.isInteger(weekNumber) || weekNumber < 1) return badRequest(res, 'Unknown quiz.');

  const preview = req.body?.preview === true && readHost(req, SESSION_SECRET);

  let member = null;
  if (!preview) {
    const sid = String(req.body?.sid || '').trim();
    if (!sid) {
      res.status(401).json({ error: 'Open this quiz from the course page.' });
      return;
    }
    try {
      member = await resolveMember(sid);
    } catch (error) {
      console.error('resolveMember error:', error);
      res.status(502).json({ error: 'Could not verify your course sign-in. Please try again.' });
      return;
    }
    if (!member) {
      res.status(403).json({ error: 'We could not find your course account.' });
      return;
    }
  }

  const selectedRaw = req.body?.selected;
  const selectedByQuestionId = {};
  if (selectedRaw && typeof selectedRaw === 'object') {
    for (const [questionId, choices] of Object.entries(selectedRaw)) {
      selectedByQuestionId[questionId] = Array.isArray(choices)
        ? choices.filter((c) => typeof c === 'string')
        : [];
    }
  }

  try {
    const result = await getWeek(weekNumber);
    if (!result.ok || !result.week) {
      res.status(404).json({ error: 'This quiz is not available.' });
      return;
    }
    const week = hydrateWeek(result.week);
    if (!preview && !isAcceptingResponses(week)) {
      res.status(403).json({ error: 'This quiz is not currently accepting responses.' });
      return;
    }
    if (week.quiz.length === 0) {
      res.status(409).json({ error: 'This quiz has no questions yet.' });
      return;
    }

    const graded = gradeQuiz(week.quiz, selectedByQuestionId);
    const attempt = {
      id: crypto.randomUUID(),
      siteUserId: member ? member.siteUserId : 'preview',
      email: member ? member.email : '',
      name: member ? `${member.firstName} ${member.lastName}`.trim() : 'Preview',
      weekNumber,
      submittedAt: new Date().toISOString(),
      correctCount: graded.correctCount,
      totalQuestions: graded.totalQuestions,
      percentage: graded.percentage,
      answers: graded.answers
    };

    if (preview) {
      res.status(200).json({ attempt: { ...attempt, preview: true } });
      return;
    }

    const saved = await saveAttempt(attempt);
    if (!saved.ok) {
      res.status(502).json({ error: saved.error || 'Could not save this attempt.' });
      return;
    }
    res.status(201).json({ attempt });
  } catch (error) {
    console.error('submit quiz error:', error);
    res.status(502).json({ error: 'Could not save your quiz right now. Please try again.' });
  }
});

// ------------------------------------------------------------------- Host: weeks

app.get('/api/host/weeks', requireHost(SESSION_SECRET), async (req, res) => {
  try {
    const result = await listWeeksForHost();
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not load weeks.' });
      return;
    }
    const weeks = (result.weeks || []).map(hydrateWeek).sort((a, b) => a.weekNumber - b.weekNumber);
    res.json({
      weeks: weeks.map((week) => ({
        weekNumber: week.weekNumber,
        title: week.title,
        status: week.status,
        quiz: week.quiz,
        responsesOpen: week.responsesOpen,
        opensAt: week.opensAt ? week.opensAt.toISOString() : null,
        closesAt: week.closesAt ? week.closesAt.toISOString() : null,
        updatedAt: week.updatedAt
      }))
    });
  } catch (error) {
    console.error('host list weeks error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

app.post('/api/host/weeks/:n', requireHost(SESSION_SECRET), async (req, res) => {
  const weekNumber = Number(req.params.n);
  if (!Number.isInteger(weekNumber) || weekNumber < 1) return badRequest(res, 'Week number must be a positive integer.');

  const body = req.body || {};
  const title = String(body.title || '').trim();
  if (!title) return badRequest(res, 'A quiz title is required.');

  const quiz = Array.isArray(body.quiz)
    ? body.quiz.map((q) => ({
        id: String(q?.id || crypto.randomUUID()),
        type: q?.type === 'TRUE_FALSE' ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE',
        question: String(q?.question || '').trim(),
        choices: Array.isArray(q?.choices) ? q.choices.map((c) => String(c)) : [],
        correctChoices: Array.isArray(q?.correctChoices) ? q.correctChoices.map((c) => String(c)) : [],
        explanation: String(q?.explanation || '').trim(),
        sourceExcerpt: typeof q?.sourceExcerpt === 'string' ? q.sourceExcerpt : null
      }))
    : [];

  const week = {
    weekNumber,
    title,
    quiz,
    opensAt: body.opensAt ? new Date(body.opensAt).toISOString() : null,
    closesAt: body.closesAt ? new Date(body.closesAt).toISOString() : null
  };

  try {
    const result = await upsertWeek(week);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not save this quiz.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('host upsert week error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

async function setStatus(req, res, patch) {
  const weekNumber = Number(req.params.n);
  if (!Number.isInteger(weekNumber)) return badRequest(res, 'Unknown quiz.');
  try {
    const result = await setWeekStatus(weekNumber, patch);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not update this quiz.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('host set week status error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
}

// Publish makes the quiz embeddable. It does NOT open it for submissions —
// the host flips that separately once it's ready.
app.post('/api/host/weeks/:n/publish', requireHost(SESSION_SECRET), (req, res) =>
  setStatus(req, res, { status: 'PUBLISHED' })
);
app.post('/api/host/weeks/:n/unpublish', requireHost(SESSION_SECRET), (req, res) =>
  setStatus(req, res, { status: 'DRAFT', responsesOpen: false })
);
// Open / close a published quiz for submissions without unpublishing it.
app.post('/api/host/weeks/:n/responses', requireHost(SESSION_SECRET), (req, res) =>
  setStatus(req, res, { responsesOpen: req.body?.open === true })
);

// ------------------------------------------------------------------ Host: scores

/** latest attempt per (siteUserId, weekNumber), grouped by member. */
function summarizeAttempts(attempts) {
  const latest = new Map();
  for (const a of attempts || []) {
    const uid = String(a.siteUserId || a.email || '').toLowerCase();
    if (!uid) continue;
    const key = `${uid}::${Number(a.weekNumber)}`;
    const prev = latest.get(key);
    if (!prev || new Date(a.submittedAt) > new Date(prev.submittedAt)) latest.set(key, a);
  }
  const members = new Map();
  for (const a of latest.values()) {
    const uid = String(a.siteUserId || a.email || '').toLowerCase();
    if (!members.has(uid)) members.set(uid, { name: a.name || '', email: a.email || '', cells: {} });
    members.get(uid).cells[Number(a.weekNumber)] = {
      percentage: Number(a.percentage) || 0,
      correctCount: Number(a.correctCount) || 0,
      totalQuestions: Number(a.totalQuestions) || 0,
      submittedAt: a.submittedAt
    };
  }
  return [...members.values()].sort((x, y) => (x.name || x.email).localeCompare(y.name || y.email));
}

app.get('/api/host/scores', requireHost(SESSION_SECRET), async (req, res) => {
  try {
    const [weeksResult, attemptsResult] = await Promise.all([listWeeksForHost(), listAllAttempts()]);
    if (!weeksResult.ok || !attemptsResult.ok) {
      res.status(502).json({ error: 'Could not load scores.' });
      return;
    }
    const weeks = (weeksResult.weeks || [])
      .map(hydrateWeek)
      .sort((a, b) => a.weekNumber - b.weekNumber)
      .map((w) => ({ weekNumber: w.weekNumber, title: w.title }));
    res.json({ weeks, students: summarizeAttempts(attemptsResult.attempts) });
  } catch (error) {
    console.error('host scores error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

app.get('/api/host/scores.csv', requireHost(SESSION_SECRET), async (req, res) => {
  try {
    const [weeksResult, attemptsResult] = await Promise.all([listWeeksForHost(), listAllAttempts()]);
    if (!weeksResult.ok || !attemptsResult.ok) {
      res.status(502).json({ error: 'Could not load scores.' });
      return;
    }
    const weeks = (weeksResult.weeks || []).map(hydrateWeek).sort((a, b) => a.weekNumber - b.weekNumber);
    const students = summarizeAttempts(attemptsResult.attempts);

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Name', 'Email', ...weeks.map((w) => `Week ${w.weekNumber}`)];
    const rows = students.map((s) => [
      s.name,
      s.email,
      ...weeks.map((w) => (w.weekNumber in s.cells ? `${s.cells[w.weekNumber].percentage}%` : ''))
    ]);

    const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="self-paced-course-scores.csv"');
    res.status(200).send(csv);
  } catch (error) {
    console.error('host scores csv error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

// --------------------------------------------------------- Host: quiz generation

app.post('/api/host/quiz/generate', requireHost(SESSION_SECRET), async (req, res) => {
  if (!GENERATE_QUIZ_API_KEY) {
    res.status(500).json({ error: 'Quiz generation is not configured.' });
    return;
  }

  const wantsStream = (req.headers.accept ?? '').includes('text/event-stream');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    const upstream = await fetch(UPSTREAM_QUIZ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GENERATE_QUIZ_API_KEY}`,
        Accept: wantsStream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify({ ...req.body, mode: 'SELF_PACED' }),
      signal: controller.signal
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentType?.includes('text/event-stream')) {
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    console.error('quiz generation proxy error:', error);
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'The quiz generator took too long to respond.' : 'Could not reach the quiz generator.'
    });
  } finally {
    clearTimeout(timeout);
  }
});

/** Turns a raw /generate-quiz result into this app's stored question shape. */
app.post('/api/host/quiz/normalize', requireHost(SESSION_SECRET), (req, res) => {
  res.json({ questions: normalizeGeneratedQuestions(req.body) });
});

// ----------------------------------------------------------------------- Health

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    sheetsConfigured: Boolean(process.env.SELF_PACED_SHEETS_ENDPOINT),
    sessionConfigured: Boolean(SESSION_SECRET),
    hostConfigured: Boolean(HOST_PASSCODE),
    quizUpstreamConfigured: Boolean(GENERATE_QUIZ_API_KEY),
    squarespaceConfigured: Boolean(process.env.SQUARESPACE_API_KEY)
  });
});

// --------------------------------------------------------------- Static SPA

app.use(express.static(distDir));
app.get('*', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`bhagavatham-self-paced-course listening on ${port}`);
});
