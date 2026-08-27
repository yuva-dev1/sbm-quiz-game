import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bcrypt from 'bcryptjs';
import { createSessionCookie, clearSessionCookie, readSession, requireSession } from './session.js';
import { createAccount, findAccount, requestPasswordReset, resetPassword, saveQuizAttempt, listQuizAttempts, saveFlashcardSet, listFlashcardSets } from './sheetsClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

const SESSION_SECRET = process.env.SELF_STUDY_SESSION_SECRET || '';
// srimad-bhagavatham-quiz-game's own /generate-quiz endpoint — see that
// repo's src/app/generate-quiz/route.ts for the request/response contract
// this proxy relies on.
const UPSTREAM_QUIZ_URL = process.env.UPSTREAM_QUIZ_URL || 'https://sbm-quiz-game-876193044983.us-central1.run.app/generate-quiz';
const GENERATE_QUIZ_API_KEY = process.env.GENERATE_QUIZ_API_KEY || '';
const REG_NO_LENGTH = 5;
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 12;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Per-regNo cooldown on password-reset requests so a reset link can't be
// spammed at someone (and the Apps Script mail quota can't be drained).
// Best-effort/in-memory — one Cloud Run instance — which is plenty here.
const FORGOT_COOLDOWN_MS = 60_000;
const forgotLastSent = new Map();
// Large decks (25-35 items) can take several minutes at the generator's fixed
// concurrency of 4 (see localQuizGenerator.ts's CONCURRENCY) — this is a
// generous outer safety net, not the expected duration. The SSE progress
// stream (see below) is what makes that wait tolerable/visible rather than
// looking hung. Kept a little under the Cloud Run service's own 600s request
// timeout (see cloudbuild.yaml's Deploy step) so this fires first with a
// clean error instead of Cloud Run abruptly cutting the connection.
const GENERATE_TIMEOUT_MS = 570_000;

if (!SESSION_SECRET) console.warn('SELF_STUDY_SESSION_SECRET is not set — sessions will not be secure.');
if (!process.env.SELF_STUDY_SHEETS_ENDPOINT) console.warn('SELF_STUDY_SHEETS_ENDPOINT is not set — registration and login will fail.');
if (!GENERATE_QUIZ_API_KEY) console.warn('GENERATE_QUIZ_API_KEY is not set — quiz generation will fail.');

const app = express();
app.use(express.json({ limit: '256kb' }));

function normalizeRegNo(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

app.post('/api/auth/register', async (req, res) => {
  const regNo = normalizeRegNo(req.body?.regNo);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (regNo.length !== REG_NO_LENGTH) {
    res.status(400).json({ error: `Registration number must be exactly ${REG_NO_LENGTH} characters.` });
    return;
  }
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    res.status(400).json({ error: 'Enter a valid email address — it is the only way to recover a lost password.' });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await createAccount(regNo, passwordHash, email);
    if (!result.ok) {
      res.status(409).json({ error: result.error || 'That registration number is already in use.' });
      return;
    }
    res.setHeader('Set-Cookie', createSessionCookie(regNo, SESSION_SECRET));
    res.status(201).json({ regNo });
  } catch (error) {
    console.error('register error:', error);
    res.status(502).json({ error: 'Could not reach the accounts sheet. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const regNo = normalizeRegNo(req.body?.regNo);
  const password = String(req.body?.password || '');

  if (regNo.length !== REG_NO_LENGTH || !password) {
    res.status(400).json({ error: 'Enter your registration number and password.' });
    return;
  }

  try {
    const result = await findAccount(regNo);
    if (!result.ok || !result.passwordHash) {
      res.status(401).json({ error: 'Incorrect registration number or password.' });
      return;
    }
    const matches = await bcrypt.compare(password, result.passwordHash);
    if (!matches) {
      res.status(401).json({ error: 'Incorrect registration number or password.' });
      return;
    }
    res.setHeader('Set-Cookie', createSessionCookie(regNo, SESSION_SECRET));
    res.status(200).json({ regNo });
  } catch (error) {
    console.error('login error:', error);
    res.status(502).json({ error: 'Could not reach the accounts sheet. Please try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.status(204).end();
});

app.get('/api/auth/session', (req, res) => {
  const regNo = readSession(req, SESSION_SECRET);
  res.json(regNo ? { authenticated: true, regNo } : { authenticated: false });
});

// Always answers { ok: true } regardless of whether the regNo/email match an
// account — never reveal account existence here. The Apps Script generates
// the token, stores its hash, and sends the email; this route only relays.
app.post('/api/auth/forgot', async (req, res) => {
  const regNo = normalizeRegNo(req.body?.regNo);
  const email = normalizeEmail(req.body?.email);

  const done = () => res.status(200).json({ ok: true });
  if (regNo.length !== REG_NO_LENGTH || !EMAIL_PATTERN.test(email)) {
    done();
    return;
  }

  const now = Date.now();
  if (now - (forgotLastSent.get(regNo) || 0) < FORGOT_COOLDOWN_MS) {
    done();
    return;
  }
  forgotLastSent.set(regNo, now);
  if (forgotLastSent.size > 5000) forgotLastSent.clear();

  try {
    await requestPasswordReset(regNo, email);
  } catch (error) {
    console.error('forgot-password error:', error);
  }
  done();
});

app.post('/api/auth/reset', async (req, res) => {
  const regNo = normalizeRegNo(req.body?.regNo);
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');

  if (regNo.length !== REG_NO_LENGTH || !token) {
    res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await resetPassword(regNo, token, passwordHash);
    if (!result.ok) {
      res.status(400).json({ error: result.error || 'This reset link is invalid or has expired. Request a new one.' });
      return;
    }
    res.setHeader('Set-Cookie', createSessionCookie(regNo, SESSION_SECRET));
    res.status(200).json({ regNo });
  } catch (error) {
    console.error('reset-password error:', error);
    res.status(502).json({ error: 'Could not reach the accounts sheet. Please try again.' });
  }
});

app.post('/api/quiz/generate', requireSession(SESSION_SECRET), async (req, res) => {
  if (!GENERATE_QUIZ_API_KEY) {
    res.status(500).json({ error: 'Quiz generation is not configured.' });
    return;
  }

  const wantsStream = (req.headers.accept ?? '').includes('text/event-stream');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(UPSTREAM_QUIZ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GENERATE_QUIZ_API_KEY}`,
        Accept: wantsStream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify({ ...req.body, mode: 'SELF_PACED' }),
      signal: controller.signal
    });

    // Piped through as-is rather than buffered with .json() — the upstream
    // route only upgrades to an SSE stream once request validation passes
    // (see generate-quiz/route.ts), so a validation failure still comes back
    // as plain JSON even when the client asked to stream. Letting the client
    // branch on content-type (like the host's own GenerateQuizForm.tsx does)
    // keeps this proxy from having to duplicate that logic.
    res.status(upstreamResponse.status);
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentType?.includes('text/event-stream')) {
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
    }

    if (upstreamResponse.body) {
      Readable.fromWeb(upstreamResponse.body).pipe(res);
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

app.post('/api/quiz/attempts', requireSession(SESSION_SECRET), async (req, res) => {
  const { contextLabel, weekIds, topics, difficulty, correctCount, scoredCount, percentage, questions } = req.body || {};
  if (typeof contextLabel !== 'string' || !contextLabel.trim() || !Array.isArray(questions) || questions.length === 0) {
    res.status(400).json({ error: 'Missing quiz attempt details.' });
    return;
  }

  const attempt = {
    id: crypto.randomUUID(),
    submittedAt: new Date().toISOString(),
    contextLabel,
    weekIds: Array.isArray(weekIds) ? weekIds : [],
    topics: Array.isArray(topics) ? topics : [],
    difficulty: String(difficulty || ''),
    correctCount: Number(correctCount) || 0,
    scoredCount: Number(scoredCount) || questions.length,
    percentage: Number(percentage) || 0,
    questions
  };

  try {
    const result = await saveQuizAttempt(req.regNo, attempt);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not save this quiz attempt.' });
      return;
    }
    res.status(201).json({ attempt });
  } catch (error) {
    console.error('save quiz attempt error:', error);
    res.status(502).json({ error: 'Could not reach the accounts sheet. Please try again.' });
  }
});

app.get('/api/quiz/attempts', requireSession(SESSION_SECRET), async (req, res) => {
  try {
    const result = await listQuizAttempts(req.regNo);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not load quiz history.' });
      return;
    }
    res.json({ attempts: result.attempts || [] });
  } catch (error) {
    console.error('list quiz attempts error:', error);
    res.status(502).json({ error: 'Could not reach the accounts sheet. Please try again.' });
  }
});

app.post('/api/flashcards/sets', requireSession(SESSION_SECRET), async (req, res) => {
  const { label, weekIds, topics, cards } = req.body || {};
  if (typeof label !== 'string' || !label.trim() || !Array.isArray(cards) || cards.length === 0) {
    res.status(400).json({ error: 'Missing flashcard set details.' });
    return;
  }

  const set = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    label,
    weekIds: Array.isArray(weekIds) ? weekIds : [],
    topics: Array.isArray(topics) ? topics : [],
    cards
  };

  try {
    const result = await saveFlashcardSet(req.regNo, set);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not save this flashcard set.' });
      return;
    }
    res.status(201).json({ set });
  } catch (error) {
    console.error('save flashcard set error:', error);
    res.status(502).json({ error: 'Could not reach the accounts sheet. Please try again.' });
  }
});

app.get('/api/flashcards/sets', requireSession(SESSION_SECRET), async (req, res) => {
  try {
    const result = await listFlashcardSets(req.regNo);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Could not load your flashcard sets.' });
      return;
    }
    res.json({ sets: result.sets || [] });
  } catch (error) {
    console.error('list flashcard sets error:', error);
    res.status(502).json({ error: 'Could not reach the accounts sheet. Please try again.' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    sheetsConfigured: Boolean(process.env.SELF_STUDY_SHEETS_ENDPOINT),
    quizUpstreamConfigured: Boolean(GENERATE_QUIZ_API_KEY),
    sessionConfigured: Boolean(SESSION_SECRET)
  });
});

app.use(express.static(distDir));
app.get('*', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`bhagavatham-self-study listening on ${port}`);
});
