# Bhagavatam Quiz Live

A Kahoot-style live quiz game for the Bhagavatam self-study program. Host
picks a previously generated quiz, players join from their phones with a PIN,
and everyone answers in real time with server-authoritative,
latency-compensated scoring.

Built feature by feature, on stacked branches, against
`kahoot-dev-plan.md`. See task list / PRs for current status.

## Stack

- **Next.js 16** (App Router, TypeScript) — host/player UI + API routes
- **Firebase Firestore** (native mode) — quizzes, sessions, players, answers, results, and the
  live-session realtime event log. Server access is the Admin SDK (`firebase-admin`, server-only);
  the browser uses the Firebase Web SDK for the realtime listener only. See
  `docs/firestore-migration.md` for the data-model design and the Ably→Firestore realtime move.
- **Redis** — live leaderboard (`ZINCRBY` / `ZREVRANGE`) during a session
- **Vitest** — unit tests, especially the scoring formula

## Local development

Requires Docker (for Redis) and a JRE on PATH (for the Firestore emulator — e.g.
`winget install EclipseAdoptium.Temurin.21.JRE` on Windows). No third-party realtime service —
the emulator covers it; the browser client points at it via `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST`.

```bash
cp .env.example .env   # already done for local docker-compose/emulator defaults
npm install
npm run docker:up      # starts Redis
npm run emulators:up   # starts the local Firestore emulator (separate terminal)
npm run seed            # loads one sample quiz so /host has something to pick
npm run dev
```

Other scripts:

```bash
npm run test           # vitest — DB-touching tests run against the Firestore emulator
npm run lint
npm run build
npm run docker:down
```

## Quiz content

The host generates quizzes from `/host` by picking a class week (or several)
and topic(s). Generation is entirely in-house
(`src/lib/localQuizGenerator.ts`): each question is its own call to an LLM,
scoped to the selected week/topic via this app's own catalog
(`src/data/courseCatalog.json`, regenerated with
`python scripts/build_course_catalog.py` from `course-materials/raw/` — see
that script's docstring).

Which LLM is a single switch, `LLM_BACKEND` (see `docs/self-hosted-llm.md`).
Unset it defaults to **`local`**: every generation and grading call goes to
a self-hosted OpenAI-compatible endpoint (`LLM_BASE_URL`, one model
`qwen3-4b-local`), with no fallback to anything else. `LLM_BACKEND=openrouter`
opts into [OpenRouter](https://openrouter.ai) instead (`openai/gpt-4o-mini`
by default, falling back to `google/gemini-2.5-flash` on a repair retry).

Each question is grounded in the actual course-note text for the selected
week(s) — `src/data/courseNotes.json` (regenerated with
`node scripts/build_course_notes.mjs` from `content/course-notes/`) is
included directly in the generation prompt, and every candidate is scored
against it with [autoevals](https://github.com/braintrustdata/autoevals)'
RAGAS-style `Faithfulness` metric (`src/lib/faithfulness.ts`, LLM-as-judge)
before it's accepted — below a 0.7 score, it's treated like any other
validation failure in the retry ladder (repair retry, then fallback model,
then the slot is dropped rather than kept). On `openrouter` the judge is
whichever of the two models *didn't* write the question; on `local` there is
only one model, so it grades its own output (and `Faithfulness` sometimes
can't parse a 4B model's response, in which case the check fails open and is
skipped — logged either way). See `docs/self-hosted-llm.md`.

The same generator is also exposed as a standalone backend endpoint,
`POST /generate-quiz` (`src/app/generate-quiz/route.ts`), for other services
to call directly — same request shape
(`{ weekIds, topics?, questionCount, difficulty }`), gated by a shared
bearer token (`GENERATE_QUIZ_API_KEY`), no DB persistence. It streams
`progress`/`complete`/`error` Server-Sent Events if the caller sends
`Accept: text/event-stream`, otherwise it awaits generation and returns
plain JSON.

This app owns its own `quizzes`/`questions` Firestore collections — a
generated quiz is saved as a draft, previewed, and Published before it can be
turned into a live session. `/host` and all of `/api/quizzes/*` (which now
runs generation on the app's own LLM backend) sit behind a shared
passcode (`HOST_PASSCODE`).

## Deployment

Config is entirely environment-based (see `.env.example`) — dev and prod
never share credentials.

1. **Firestore**: this app deploys onto the `namabiksha-v1` Firebase project
   (native mode). No connection string to set — the Admin SDK picks up
   Application Default Credentials from the deployment environment
   automatically (Cloud Run's attached service account); `FIRESTORE_EMULATOR_HOST`
   and `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` must be **unset** in prod.
   Deploy security rules/indexes with `firebase deploy --only firestore`
   (as `yuvadev1@godivinity.org` — see `CLAUDE.md`). One-time per project:
   enable the TTL policy on the broadcast event log —
   `gcloud firestore fields ttls update expireAt --collection-group=events --enable-ttl --project=namabiksha-v1`.
2. **Redis**: any hosted Redis works (Upstash's free tier is enough for a
   single-class event). Set `REDIS_URL`.
3. **Firebase web config** (client realtime listener): set
   `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
   `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` from the
   Firebase console (Project settings → your apps → Web app). Not secrets, but
   **build-time** — pass them as Cloud Run build env vars (they're inlined
   into the client bundle; see `Dockerfile`), not just runtime.
4. **`NEXT_PUBLIC_APP_URL`**: the real prod domain (used to build the
   join-link shown on the host screen).
5. **`HOST_PASSCODE`**: a real passcode only hosts should know — do not reuse
   any value from a local `.env`.
6. **`SESSION_SECRET`**: signs the host's session cookie. Generate a fresh
   one for prod (`openssl rand -base64 32`) — do not reuse the local dev
   value.
7. **LLM backend**: `LLM_BACKEND` unset (or `local`) is the default and
   needs **`LLM_API_KEY`** set (the self-hosted endpoint's bearer token — a
   Cloud Run secret, never committed); `LLM_BASE_URL`, `LLM_MODEL`,
   `LLM_TIMEOUT_MS`, `LLM_CONCURRENCY`, `LLM_TOPUP_CONCURRENCY` have working
   defaults. Set `LLM_BACKEND=openrouter` to use OpenRouter instead, which
   then needs **`OPENROUTER_API_KEY`** (`OPENROUTER_MODEL_PRIMARY`/
   `OPENROUTER_MODEL_FALLBACK` are optional overrides). Full details and the
   toggle steps: `docs/self-hosted-llm.md`. **`GENERATE_QUIZ_API_KEY`**:
   a random shared secret (`openssl rand -base64 32`) other services must
   present as a bearer token to call `POST /generate-quiz` — do not reuse
   any other secret for this.
8. Deploy the Next.js app itself anywhere that supports it (Vercel is the
   path of least resistance for this stack — git push, no server to manage).
   HTTPS is automatic on Vercel and most other platforms; the Firestore Web
   SDK negotiates its own secure connection regardless.

**Monitoring** (Story 8.2): `GET /api/health` checks Firestore and Redis live,
returning 503 if anything's down. Point an
external uptime monitor at it (UptimeRobot's free tier is enough) so an
outage mid-class is caught within seconds instead of being discovered from a
confused host. A root error boundary (`src/app/error.tsx`) also logs
uncaught errors with a stack trace instead of the app just going blank.

Not built: an admin view of active sessions (Story 8.3) — explicitly a cut
candidate in the dev plan, cut here too given the time budget.

## QA (Feature 9 — the long pole)

- `docs/qa-checklist.md` — what's verified vs. what still needs a human
  (real devices, real remote testers, a real deployment)
- `docs/formula-audit.md` — the scoring formula's correctness verification
- `load-test/` — k6 scripts simulating the plan's worst case (500-1000
  players joining, then all answering within the last 1-2 seconds)
