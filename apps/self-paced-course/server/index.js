import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bcrypt from 'bcryptjs';
import {
  createStudentCookie,
  clearStudentCookie,
  createHostCookie,
  clearHostCookie,
  readStudent,
  readHost,
  requireStudent,
  requireHost
} from './session.js';
import {
  createAccount,
  findAccount,
  requestPasswordReset,
  resetPassword,
  listWeeksForHost,
  listPublishedWeeks,
  upsertWeek,
  setWeekStatus,
  getWeek,
  saveAttempt,
  listAttempts,
  listAllAttempts
} from './sheetsClient.js';
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

const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 80;
const BCRYPT_ROUNDS = 12;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Per-email cooldown on password-reset requests. Best-effort/in-memory — one
// Cloud Run instance is plenty here (same as apps/self-study).
const FORGOT_COOLDOWN_MS = 60_000;
const forgotLastSent = new Map();
// Generous outer safety net for a proxied generation; a little under the
// Cloud Run request timeout (see cloudbuild.yaml) so this fires first with a
// clean error rather than the connection being cut.
const GENERATE_TIMEOUT_MS = 570_000;

if (!SESSION_SECRET) console.warn('SELF_PACED_SESSION_SECRET is not set — sessions will not be secure.');
if (!HOST_PASSCODE) console.warn('HOST_PASSCODE is not set — the host area will be inaccessible.');
if (!process.env.SELF_PACED_SHEETS_ENDPOINT) console.warn('SELF_PACED_SHEETS_ENDPOINT is not set — accounts, weeks, and scores will fail.');
if (!GENERATE_QUIZ_API_KEY) console.warn('GENERATE_QUIZ_API_KEY is not set — quiz generation will fail.');

// Origins allowed to POST to /api/public/* from a browser (e.g. a sign-up
// form embedded on the Squarespace site). Comma-separated override; the
// default is the course's own domain, www + apex.
const PUBLIC_CORS_ORIGINS = (
  process.env.PUBLIC_CORS_ORIGINS ||
  'https://www.srimadbhagavatamcourse.org,https://srimadbhagavatamcourse.org'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: '512kb' }));

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function badRequest(res, message) {
  res.status(400).json({ error: message });
}

/** CORS + preflight for the public sign-up endpoint. */
function publicCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && PUBLIC_CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * Validate + hash + write a new account to the Users sheet. Shared by the
 * app's own /api/auth/register and the public /api/public/register.
 * Returns { status, body, email?, name? } — never throws for expected
 * validation / duplicate cases; throws only on a sheet/transport failure.
 */
async function registerAccount(input) {
  const firstName = String(input?.firstName || '').trim();
  const lastName = String(input?.lastName || '').trim();
  const email = normalizeEmail(input?.email);
  const password = String(input?.password || '');
  const name = `${firstName} ${lastName}`.trim();

  if (!firstName || !lastName) return { status: 400, body: { error: 'Please enter your first and last name.' } };
  if (firstName.length > MAX_NAME_LENGTH || lastName.length > MAX_NAME_LENGTH) return { status: 400, body: { error: 'That name is too long.' } };
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return { status: 400, body: { error: 'Enter a valid email address.' } };
  if (password.length < MIN_PASSWORD_LENGTH) return { status: 400, body: { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` } };

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await createAccount(firstName, lastName, email, passwordHash);
  if (!result.ok) return { status: 409, body: { error: result.error || 'An account with this email already exists.' } };
  return { status: 201, body: { ok: true }, email, name };
}

/** Sheet week row -> in-memory week with Date fields and parsed JSON. */
function hydrateWeek(row) {
  return {
    weekNumber: Number(row.weekNumber),
    title: String(row.title || ''),
    summary: String(row.summary || ''),
    status: row.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
    lessons: Array.isArray(row.lessons) ? row.lessons : [],
    quiz: Array.isArray(row.quiz) ? row.quiz : [],
    responsesOpen: Boolean(row.responsesOpen),
    opensAt: row.opensAt ? new Date(row.opensAt) : null,
    closesAt: row.closesAt ? new Date(row.closesAt) : null,
    updatedAt: row.updatedAt || null
  };
}

// ------------------------------------------------------------------ Student auth

app.post('/api/auth/register', async (req, res) => {
  try {
    const r = await registerAccount(req.body || {});
    if (r.status !== 201) {
      res.status(r.status).json(r.body);
      return;
    }
    res.setHeader('Set-Cookie', createStudentCookie(r.email, SESSION_SECRET));
    res.status(201).json({ email: r.email, name: r.name });
  } catch (error) {
    console.error('register error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

// Cross-origin sign-up for a form embedded on the Squarespace site. Same
// validation + bcrypt + Users-sheet write as /api/auth/register, but no
// session cookie (it's a cross-site call). The Apps Script still sends the
// welcome email. The person then logs into this app with the same
// email + password.
app.options('/api/public/register', publicCors);
app.post('/api/public/register', publicCors, async (req, res) => {
  try {
    const r = await registerAccount(req.body || {});
    res.status(r.status).json(r.status === 201 ? { ok: true } : r.body);
  } catch (error) {
    console.error('public register error:', error);
    res.status(502).json({ error: 'Could not create your account right now. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!EMAIL_PATTERN.test(email) || !password) return badRequest(res, 'Enter your email and password.');

  try {
    const result = await findAccount(email);
    if (!result.ok || !result.passwordHash || !(await bcrypt.compare(password, result.passwordHash))) {
      res.status(401).json({ error: 'Incorrect email or password.' });
      return;
    }
    res.setHeader('Set-Cookie', createStudentCookie(email, SESSION_SECRET));
    res.status(200).json({ email, name: result.name || '' });
  } catch (error) {
    console.error('login error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearStudentCookie());
  res.status(204).end();
});

app.get('/api/auth/session', async (req, res) => {
  const email = readStudent(req, SESSION_SECRET);
  res.json(email ? { authenticated: true, email } : { authenticated: false });
});

// Always { ok: true } — never reveal whether the email matches an account.
app.post('/api/auth/forgot', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const done = () => res.status(200).json({ ok: true });
  if (!EMAIL_PATTERN.test(email)) return done();

  const now = Date.now();
  if (now - (forgotLastSent.get(email) || 0) < FORGOT_COOLDOWN_MS) return done();
  forgotLastSent.set(email, now);
  if (forgotLastSent.size > 5000) forgotLastSent.clear();

  try {
    await requestPasswordReset(email);
  } catch (error) {
    console.error('forgot-password error:', error);
  }
  done();
});

app.post('/api/auth/reset', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!EMAIL_PATTERN.test(email) || !token) return badRequest(res, 'This reset link is invalid or has expired. Request a new one.');
  if (password.length < MIN_PASSWORD_LENGTH) return badRequest(res, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await resetPassword(email, token, passwordHash);
    if (!result.ok) {
      res.status(400).json({ error: result.error || 'This reset link is invalid or has expired. Request a new one.' });
      return;
    }
    res.setHeader('Set-Cookie', createStudentCookie(email, SESSION_SECRET));
    res.status(200).json({ email });
  } catch (error) {
    console.error('reset-password error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

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

// --------------------------------------------------------------- Student course

app.get('/api/course', requireStudent(SESSION_SECRET), async (req, res) => {
  try {
    const result = await listPublishedWeeks();
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not load the course.' });
      return;
    }
    const weeks = (result.weeks || []).map(hydrateWeek).sort((a, b) => a.weekNumber - b.weekNumber);
    res.json({
      weeks: weeks.map((week) => ({
        weekNumber: week.weekNumber,
        title: week.title,
        summary: week.summary,
        lessons: week.lessons,
        questionCount: week.quiz.length,
        windowState: describeWindowState(week),
        opensAt: week.opensAt ? week.opensAt.toISOString() : null,
        closesAt: week.closesAt ? week.closesAt.toISOString() : null
      }))
    });
  } catch (error) {
    console.error('load course error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

app.get('/api/course/progress', requireStudent(SESSION_SECRET), async (req, res) => {
  try {
    const [weeksResult, attemptsResult] = await Promise.all([listPublishedWeeks(), listAttempts(req.email)]);
    if (!weeksResult.ok || !attemptsResult.ok) {
      res.status(502).json({ error: 'Could not load your progress.' });
      return;
    }
    const total = (weeksResult.weeks || []).length;
    const attemptedWeeks = new Set((attemptsResult.attempts || []).map((a) => Number(a.weekNumber)));
    res.json({ completed: attemptedWeeks.size, total });
  } catch (error) {
    console.error('progress error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

app.get('/api/weeks/:n', requireStudent(SESSION_SECRET), async (req, res) => {
  const weekNumber = Number(req.params.n);
  if (!Number.isInteger(weekNumber)) return badRequest(res, 'Unknown week.');
  try {
    const result = await getWeek(weekNumber);
    if (!result.ok || !result.week) {
      res.status(404).json({ error: 'That week is not available yet.' });
      return;
    }
    const week = hydrateWeek(result.week);
    if (week.status !== 'PUBLISHED') {
      res.status(404).json({ error: 'That week is not available yet.' });
      return;
    }
    res.json({
      weekNumber: week.weekNumber,
      title: week.title,
      summary: week.summary,
      lessons: week.lessons,
      windowState: describeWindowState(week),
      opensAt: week.opensAt ? week.opensAt.toISOString() : null,
      closesAt: week.closesAt ? week.closesAt.toISOString() : null,
      questions: week.quiz.map(toStudentQuestion)
    });
  } catch (error) {
    console.error('load week error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

app.post('/api/weeks/:n/attempt', requireStudent(SESSION_SECRET), async (req, res) => {
  const weekNumber = Number(req.params.n);
  if (!Number.isInteger(weekNumber)) return badRequest(res, 'Unknown week.');

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
      res.status(404).json({ error: 'That week is not available.' });
      return;
    }
    const week = hydrateWeek(result.week);
    if (!isAcceptingResponses(week)) {
      res.status(403).json({ error: 'This quiz is not currently accepting responses.' });
      return;
    }
    if (week.quiz.length === 0) {
      res.status(409).json({ error: 'This week has no quiz yet.' });
      return;
    }

    const graded = gradeQuiz(week.quiz, selectedByQuestionId);
    const attempt = {
      id: crypto.randomUUID(),
      email: req.email,
      weekNumber,
      submittedAt: new Date().toISOString(),
      correctCount: graded.correctCount,
      totalQuestions: graded.totalQuestions,
      percentage: graded.percentage,
      answers: graded.answers
    };
    const saved = await saveAttempt(attempt);
    if (!saved.ok) {
      res.status(502).json({ error: saved.error || 'Could not save this attempt.' });
      return;
    }
    res.status(201).json({ attempt });
  } catch (error) {
    console.error('submit attempt error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
});

app.get('/api/attempts', requireStudent(SESSION_SECRET), async (req, res) => {
  try {
    const result = await listAttempts(req.email);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not load your quiz history.' });
      return;
    }
    const attempts = [...(result.attempts || [])].sort(
      (a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)
    );
    res.json({ attempts });
  } catch (error) {
    console.error('list attempts error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
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
        summary: week.summary,
        status: week.status,
        lessons: week.lessons,
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
  if (!title) return badRequest(res, 'A week title is required.');

  const lessons = Array.isArray(body.lessons)
    ? body.lessons
        .map((lesson) => ({
          title: String(lesson?.title || '').trim(),
          description: String(lesson?.description || '').trim(),
          videoUrl: String(lesson?.videoUrl || '').trim(),
          // Optional link to the lesson's page on the course site, shown to
          // students as a fallback when the video embed is blocked.
          pageUrl: String(lesson?.pageUrl || '').trim()
        }))
        .filter((lesson) => lesson.title || lesson.videoUrl || lesson.pageUrl)
    : [];

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
    summary: String(body.summary || '').trim(),
    lessons,
    quiz,
    opensAt: body.opensAt ? new Date(body.opensAt).toISOString() : null,
    closesAt: body.closesAt ? new Date(body.closesAt).toISOString() : null
  };

  try {
    const result = await upsertWeek(week);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not save this week.' });
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
  if (!Number.isInteger(weekNumber)) return badRequest(res, 'Unknown week.');
  try {
    const result = await setWeekStatus(weekNumber, patch);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not update this week.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('host set week status error:', error);
    res.status(502).json({ error: 'Could not reach the course sheet. Please try again.' });
  }
}

// Publish makes the week + its lessons visible to students. It does NOT open
// the quiz — the host flips that separately (below) once the quiz is ready.
app.post('/api/host/weeks/:n/publish', requireHost(SESSION_SECRET), (req, res) =>
  setStatus(req, res, { status: 'PUBLISHED' })
);
// Unpublish hides the whole week again.
app.post('/api/host/weeks/:n/unpublish', requireHost(SESSION_SECRET), (req, res) =>
  setStatus(req, res, { status: 'DRAFT', responsesOpen: false })
);
// Open / close the quiz on an already-published week without unpublishing it.
app.post('/api/host/weeks/:n/responses', requireHost(SESSION_SECRET), (req, res) =>
  setStatus(req, res, { responsesOpen: req.body?.open === true })
);

// ------------------------------------------------------------------ Host: scores

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

    // latest attempt per (email, weekNumber)
    const latest = new Map();
    for (const a of attemptsResult.attempts || []) {
      const key = `${String(a.email).toLowerCase()}::${Number(a.weekNumber)}`;
      const prev = latest.get(key);
      if (!prev || new Date(a.submittedAt) > new Date(prev.submittedAt)) latest.set(key, a);
    }

    const students = new Map();
    for (const a of latest.values()) {
      const email = String(a.email).toLowerCase();
      if (!students.has(email)) students.set(email, { email, name: a.name || '', cells: {} });
      students.get(email).cells[Number(a.weekNumber)] = {
        percentage: Number(a.percentage) || 0,
        correctCount: Number(a.correctCount) || 0,
        totalQuestions: Number(a.totalQuestions) || 0,
        submittedAt: a.submittedAt
      };
    }

    res.json({ weeks, students: [...students.values()].sort((a, b) => a.email.localeCompare(b.email)) });
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
    const weeks = (weeksResult.weeks || [])
      .map(hydrateWeek)
      .sort((a, b) => a.weekNumber - b.weekNumber);

    const latest = new Map();
    for (const a of attemptsResult.attempts || []) {
      const key = `${String(a.email).toLowerCase()}::${Number(a.weekNumber)}`;
      const prev = latest.get(key);
      if (!prev || new Date(a.submittedAt) > new Date(prev.submittedAt)) latest.set(key, a);
    }
    const byStudent = new Map();
    for (const a of latest.values()) {
      const email = String(a.email).toLowerCase();
      if (!byStudent.has(email)) byStudent.set(email, { email, name: a.name || '', cells: {} });
      byStudent.get(email).cells[Number(a.weekNumber)] = Number(a.percentage) || 0;
    }

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Email', 'Name', ...weeks.map((w) => `Week ${w.weekNumber}`)];
    const rows = [...byStudent.values()]
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((s) => [s.email, s.name, ...weeks.map((w) => (w.weekNumber in s.cells ? `${s.cells[w.weekNumber]}%` : ''))]);

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

    // Piped through as-is: the upstream only upgrades to SSE once validation
    // passes, so a validation failure still comes back as plain JSON even
    // when the client asked to stream. The client branches on content-type
    // (see src/generateClient.js), same as the Kahoot host UI does.
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
    quizUpstreamConfigured: Boolean(GENERATE_QUIZ_API_KEY)
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
