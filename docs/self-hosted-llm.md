# LLM backend for quiz generation

Quiz generation (`src/lib/localQuizGenerator.ts`) and its combined LLM judge
(`faithfulness.ts`'s `judgeQuestion` — grounding + single-defensible-answer +
difficulty-tier, in one call) talk to one of two backends, chosen by a
single env var: **`LLM_BACKEND`**.

| `LLM_BACKEND` | What runs | Keyed by |
|---|---|---|
| unset / `local` | **the default.** 100% self-hosted: primary draft, repair retry, and the judge hit the self-hosted OpenAI-compatible endpoint using one model (`qwen3-4b-local`). The judge gates on **grounding only** in this mode; the fallback-model third attempt is skipped (one model, nothing to escalate to). | `LLM_API_KEY` |
| `openrouter` | `openai/gpt-4o-mini` primary, `google/gemini-2.5-flash` fallback slot, judge on the other model. Gates on all three axes. | `OPENROUTER_API_KEY` |

Resolution lives in `src/lib/llmBackend.ts`; `openrouter.ts` and
`faithfulness.ts` read it for their client config, `localQuizGenerator.ts`
reads it for model choice and concurrency.

## Prompt size is the cost, not token speed

At full-course scope the old code inlined the entire selected-weeks corpus
(~27k tokens) into **every** draft, repair, and judge call. Decode then runs
~65 tok/s instead of 200+ because each token attends over ~27k tokens of
context — a ~7–10s floor per question. Two changes fix this:

- **Per-slot topic-scoped grounding.** Each slot already has a `focusTopic`;
  it's now grounded in just that topic's hand-authored passage
  (`getTopicSourceText` → `src/data/courseTopicText.json`), ~1–4k chars,
  falling back to the run-wide `sourceText` only for a topic with no index
  entry. The unpinned relaxed top-up gets the union of the scope's passages
  up to a larger cap. `isVerbatimInSource`, the `source_excerpt` check, and
  `judgeQuestion` all see that same per-slot text, so grounding is narrowed
  per question, never weakened. This applies to LIVE (Kahoot) quizzes too.
- **One judge call instead of three.** `judgeQuestion` returns
  `{ faithful, answerable, difficultyMatch, reason }` in a single round trip,
  and is skipped entirely when the cited `source_excerpt` is verbatim in the
  passage *and* the marked answer is too (grounded by construction).

`buildUserPrompt` puts the scoped passage first, then a byte-identical fixed
instruction block, then all per-call variation last, so a repair retry and
same-shape sibling slots reuse the llama.cpp KV prefix.

### Telemetry

`generateQuiz` logs one summary line per run
(`[localQuizGenerator] generation summary: …s wall, N LLM calls (…draft / …repair / …judge), … prompt + … completion tokens, median draft/repair prompt … tokens`),
built by `src/lib/llmTelemetry.ts` from per-call records `completeChat`
emits. Median draft/repair prompt tokens is the number to watch — target
**< 3000** for a typical multi-topic quiz.

`scripts/bench_generation.ts` runs a fixed week selection end to end and
prints the wall-clock headline (target **< ~60s** for 15 questions):

```
npx tsx scripts/bench_generation.ts
WEEKS=week-4,week-5,week-6 COUNT=15 npx tsx scripts/bench_generation.ts
```

## No automatic fallback

There is **no** silent fall-through between the two backends. In `local`
mode a failed or timed-out call is only ever retried against the same
self-hosted endpoint, through the existing per-slot retry ladder (primary →
repair retry → "fallback" — all the same model in this mode). A slot that
still can't be filled stays empty and flows into the existing top-up /
relaxation path, exactly as before. The **only** way an OpenRouter request
is ever made is `LLM_BACKEND=openrouter`.

## `local` mode: the judge

The self-hosted box serves a single 4B model, so in `local` mode the drafter
also judges its own draft. `judgeQuestion` is still called, but:

- **It gates on grounding only.** The difficulty-tier and
  single-defensible-answer axes are neither asked for nor enforced — a 4B
  model grading its own draft on those is weak signal, and a flaky
  self-"fail" only buys a wasted repair round. They still gate on the
  `openrouter` backend, where the judge is a different model from the
  drafter.
- **It fails open.** If the judge call errors, returns non-JSON, or omits a
  requested key, the verdict is `null` and the caller keeps the draft rather
  than dropping an otherwise-good question. It logs the reason
  (`[judgeQuestion] judge "…" … failing open, checks skipped`). Watch the
  rate of that line in Cloud Run logs — when it's high, grounding on the
  local backend rests on the verbatim `source_excerpt` citation check (which
  is mechanical and always enforced).
- **It's skipped entirely** for a multiple_choice draft whose cited
  `source_excerpt` and marked answer are both verbatim in the passage.

The `local` backend logs its judge setup once per process
(`[localQuizGenerator] LLM_BACKEND=local: …`).

## Env vars

### `local` backend (the default)

| Var | Default | Notes |
|---|---|---|
| `LLM_BACKEND` | `local` | Set to `openrouter` to opt out. |
| `LLM_BASE_URL` | `https://llm-box.tailc146aa.ts.net/v1` | Origin + base path; `/chat/completions` is appended. A trailing slash is trimmed. |
| `LLM_API_KEY` | *(none — required)* | Bearer token the endpoint expects. **Secret** — env / Cloud Run secret only, never committed. Unset → a clear `LLM_API_KEY is not set` error at call time. |
| `LLM_MODEL` | `qwen3-4b-local` | The only model on the box. |
| `LLM_TIMEOUT_MS` | `60000` | Per-request timeout. With per-slot scoped prompts a warm call is a few seconds; 60s still covers a cold start or a long repair. |
| `LLM_CONCURRENCY` | `6` | Parallel model calls during the main fill. Assumes `OLLAMA_NUM_PARALLEL >= 6` on the box (see below) — otherwise the extra calls just queue there; set this back to `3` to match. |
| `LLM_TOPUP_CONCURRENCY` | `6` | Same, for the relaxed end-of-run top-up pass. |

### Box-side settings this assumes

The app defaults are paired with the self-hosted Ollama box running:

- `OLLAMA_NUM_PARALLEL=6` — to actually serve `LLM_CONCURRENCY=6`. Small
  per-slot prompts mean one stream no longer saturates the GPU.
- `num_ctx` can drop back to ~8192 (from 32768) — no single call carries the
  whole corpus any more, which frees VRAM for the extra parallel slots.

If the box keeps `OLLAMA_NUM_PARALLEL=3`, set `LLM_CONCURRENCY=3` /
`LLM_TOPUP_CONCURRENCY=3` so the app doesn't pile up a queue on the box.

### `openrouter` backend (opt-in)

| Var | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | *(none — required in this mode)* | https://openrouter.ai/keys |
| `OPENROUTER_MODEL_PRIMARY` | `openai/gpt-4o-mini` | Optional override. |
| `OPENROUTER_MODEL_FALLBACK` | `google/gemini-2.5-flash` | Optional override. Used for the fallback slot and as the judge for primary-drafted questions. |

In `openrouter` mode the timeout is a fixed 30s and concurrency is 32 / 16
(`LLM_TIMEOUT_MS` / `LLM_CONCURRENCY` / `LLM_TOPUP_CONCURRENCY` are ignored).

## Flipping the toggle

### Local dev (`.env.local`)

Default (self-hosted) — this is what you get with nothing set, but to be
explicit:

```
LLM_BACKEND=local
LLM_API_KEY=<the self-hosted endpoint's bearer token>
# LLM_BASE_URL / LLM_MODEL / LLM_TIMEOUT_MS / LLM_CONCURRENCY / LLM_TOPUP_CONCURRENCY
# only if overriding the defaults above
```

Back to OpenRouter:

```
LLM_BACKEND=openrouter
OPENROUTER_API_KEY=<your OpenRouter key>
```

Restart `npm run dev` after changing either.

### Cloud Run

`LLM_API_KEY` is a secret; the rest are plain env vars.

```bash
# one-time: store the self-hosted token as a secret
printf %s "<TOKEN>" | gcloud secrets create llm-api-key --data-file=-
# (later rotation: gcloud secrets versions add llm-api-key --data-file=-)

# default (self-hosted) backend
gcloud run services update <SERVICE> --region <REGION> \
  --update-env-vars LLM_BACKEND=local \
  --update-secrets LLM_API_KEY=llm-api-key:latest
# optional: --update-env-vars LLM_BASE_URL=...,LLM_MODEL=...,LLM_TIMEOUT_MS=...,LLM_CONCURRENCY=...,LLM_TOPUP_CONCURRENCY=...

# switch to OpenRouter
gcloud run services update <SERVICE> --region <REGION> \
  --update-env-vars LLM_BACKEND=openrouter
# ensure OPENROUTER_API_KEY is already set (it is in current prod)
```

`LLM_BACKEND` unset behaves as `local`, so a deploy that sets neither var
lands on the self-hosted backend — make sure `LLM_API_KEY` is wired before
that ships. Each `gcloud run services update` starts a new revision; no
`main` push or Cloud Build run is involved.
