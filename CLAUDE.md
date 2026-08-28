# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## GitHub access

Please always use the gh CLI to commit files, to create PR's, to merge PR's, and all other GitHub commands.

Always create a feature branch off `main` and open a PR for it rather than committing directly to `main`.

## Deployment

Always deploy from main — pushing to `main` triggers an automatic Cloud Build deploy; there is no
manual `gcloud` deploy step.

Firebase deployments (e.g. `firebase deploy --only firestore:indexes`) must be run authenticated as
the `yuvadev1@godivinity.org` account, not the legacy `wise.ani@gmail.com` account. Check the active
account with `firebase login:list` before deploying, and switch with `firebase login --reauth` if
it's on the wrong one.

## What this is

A Kahoot-style live quiz game for a self-study program (`README.md` has full detail). Host picks a
generated quiz, players join from their phones with a PIN, everyone answers in real time with
server-authoritative, latency-compensated scoring. There's also a second, unrelated-in-UX mode:
self-paced Google-Forms-style quizzes at `/quiz/[slug]` with no live session.

## Commands

```bash
npm run dev             # start Next.js dev server
npm run docker:up       # start local Redis (needed before dev/test)
npm run docker:down
npm run emulators:up    # start the local Firestore emulator (needs a JRE — see below)
npm run build
npm run lint
npm test                # vitest run (single pass) — DB-touching tests run against the Firestore emulator
npm run test:watch      # vitest watch mode
npx vitest run src/lib/scoring.test.ts   # run a single test file
npm run seed             # seed one sample quiz so /host has something to pick
```

The Firestore emulator is JVM-based — needs a local JRE on PATH (e.g.
`winget install EclipseAdoptium.Temurin.21.JRE` on Windows) that isn't part of `firebase-tools`
itself. There is no CI — `lint`/`test` are only enforced by whoever runs them locally, so run both
before calling a change done.

## Architecture

**Stack**: Next.js 16 App Router + TypeScript (breaking changes vs. training data — see
`AGENTS.md`/`node_modules/next/dist/docs/`), Firebase Firestore (via `firebase-admin`, server-only —
see `src/lib/firestore.ts`), Redis (live leaderboard via `ZINCRBY`/`ZREVRANGE`), Ably (realtime
pub/sub per game PIN, channel `game:{pin}`), Vitest.

**Layering**: `src/app/api/**/route.ts` handlers stay thin — parse/delegate/respond — with real
logic living in `src/lib/*.ts`. Tests are colocated as `*.test.ts` next to the module they cover in
`src/lib/` (not a separate `__tests__` tree).

**Data model** (Firestore, native mode — `firestore.rules`/`firestore.indexes.json` at the repo
root; migrated off Prisma/Postgres, see `docs/firestore-migration.md` for the full design rationale):
- `quizzes/{id}` → `questions/{id}` subcollection is the authored/generated template; `mode` splits
  it into `LIVE` (Kahoot-style) vs `SELF_PACED` (`/quiz/[slug]`, `responsesOpen`/`opensAt`/`closesAt`
  gate access). `responses/{sha256(regNo)}` (doc ID = a hash of the respondent's registration number)
  holds self-paced submissions.
- `gameSessions/{id}` (top-level, looked up by `pin`) is one live instance of a Quiz. Its questions
  are **frozen** at creation into a `sessionQuestions/{id}` subcollection (batch-copied from the
  source Quiz's `questions`, deliberately a different subcollection name to avoid colliding with it
  in collection-group queries) so editing the source quiz mid-session never affects a running game.
  Each frozen question doc also carries incrementally-maintained tally fields
  (`answeredCount`/`correctCount`/`incorrectCount`/`choiceCounts` — the last a **map**, `{"0": n,
  ...}`, not an array; Firestore's dotted-path field updates only address map fields) updated inside
  `submitAnswer`'s transaction, so reads never need to aggregate over the `answers` subcollection.
- `players/{id}` and `results/{id}` (doc ID = playerId in both) live under each `gameSessions/{id}`.
  `answers/{playerId}` lives under each `sessionQuestions/{id}` — doc-ID-as-key gives the
  once-per-question and once-per-session uniqueness constraints for free via Firestore's own
  create()-fails-if-exists behavior, no separate unique-constraint handling needed.

**Scoring** (`src/lib/scoring.ts`) is the one piece of logic held to "provably correct": pure
functions, no I/O, unit-tested against hand-calculated cases. Server-authoritative — reaction time is
computed server-side from `serverReceivedAt` vs. the question's broadcast time, latency-compensated
by subtracting half the player's estimated one-way RTT (`Player.estimatedLatencyMs`), then clamped.
Points decay linearly over the question's time limit (`SPEED` mode) or ignore time entirely
(`ACCURACY` mode), scaled by `correctFraction` for partial-credit multi-select grading.

**Realtime events** (`src/lib/events.ts`) are a single source of truth for event names/payloads
published on `game:{pin}` — both the host and player UIs and every API route that publishes an event
import from here rather than hand-rolling event strings.

**Quiz generation** (`src/lib/localQuizGenerator.ts`) calls an LLM per-question (primary model,
falling back to a second on a repair retry), grounded in course-note text. The backend is one env
switch, `LLM_BACKEND` (`src/lib/llmBackend.ts`, `docs/self-hosted-llm.md`): unset/`local` (default)
sends every generation and judge call to a self-hosted OpenAI-compatible endpoint with a single
model and no fallback anywhere else; `openrouter` restores the hosted `gpt-4o-mini` + `gemini-2.5-flash`
path. Grounding is course-note text
(`src/data/courseNotes.json`, regenerated from `content/course-notes/` via
`node scripts/build_course_notes.mjs`), scoped by `src/data/courseCatalog.json` (regenerated via
`python scripts/build_course_catalog.py`). When a host picks specific topics rather than "all
topics", grounding is narrowed further to just those topics' hand-authored excerpts
(`src/data/courseTopicText.json`, see `docs/topic-scoped-grounding.md`) instead of the whole week's
notes — the single biggest lever on generation latency, since the source text rides along in every
draft and judge call. Every candidate question is scored against the source
notes with autoevals' Faithfulness metric (`src/lib/faithfulness.ts`) before acceptance. The same
generator is also exposed standalone at `POST /generate-quiz` for other services, gated by a bearer
token (`GENERATE_QUIZ_API_KEY`), independent of this app's own DB-backed `/api/quizzes/*` flow.

**Auth**: `/host` and `/api/quizzes/*` sit behind a shared passcode (`HOST_PASSCODE`,
`src/lib/hostAuth.ts`), session cookie signed with `SESSION_SECRET`. There's no per-user auth model —
one shared host secret is the whole system.

## Conventions

- `camelCase.ts` for `src/lib` modules, `PascalCase.tsx` for components, `route.ts` for API handlers,
  `[param]` dynamic segments for path params.
- Pure ESM (`import`/`export`), no `require()`.
- Zod at the boundary (e.g. `src/lib/generateQuizRequest.ts`) for parsing untrusted request bodies,
  not scattered manual validation.
- Typed errors for expected failure modes (e.g. `QuizGenerationError` → clean SSE `error` event);
  `console.error` is reserved for genuinely unexpected failures, not routine control flow.
- No empty `catch {}` blocks / swallowed errors.
- A multi-paragraph rationale comment at the top of a genuinely non-obvious algorithmic module (see
  `localQuizGenerator.ts`, `scoring.ts`) is welcome and different from the general no-comments
  default — it belongs when it explains a hidden design constraint, not when it narrates obvious code.

For a full project-calibrated cleanliness checklist (smell greps, what counts as "enforced" without
CI, etc.), see the `clean-codebase` skill (`.claude/skills/clean-codebase/SKILL.md`) or run
`/clean-codebase`.

## Docs worth knowing about

- `docs/qa-checklist.md` — what's verified vs. what still needs a human/real deployment.
- `docs/formula-audit.md` — correctness verification for the scoring formula.
- `docs/firestore-migration.md` — the Postgres/Prisma → Firestore migration's data-model design
  rationale (denormalization decisions, why `sessionQuestions` isn't named `questions`, the
  doc-ID-as-natural-key pattern, incrementally-maintained counters) and real findings from building
  it.
- `docs/topic-scoped-grounding.md` — how topic selection narrows the grounding text handed to quiz
  generation (`src/data/courseTopicText.json`), and how to extend the index for a new week.
- `docs/self-hosted-llm.md` — the `LLM_BACKEND` switch (self-hosted `local` default vs opt-in
  `openrouter`), every `LLM_*` env var, and the exact steps to flip it for local dev and Cloud Run.
- `load-test/README.md` — k6-based load testing for the 500-1000-player worst case.
