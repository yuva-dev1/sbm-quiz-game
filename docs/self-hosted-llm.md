# LLM backend for quiz generation

Quiz generation (`src/lib/localQuizGenerator.ts`) and its three LLM judges
(faithfulness, answerable, difficulty-match) talk to one of two backends,
chosen by a single env var: **`LLM_BACKEND`**.

| `LLM_BACKEND` | What runs | Keyed by |
|---|---|---|
| unset / `local` | **the default.** 100% self-hosted: primary draft, repair retry, fallback-slot draft, and all three judges hit the self-hosted OpenAI-compatible endpoint using one model (`qwen3-4b-local`). | `LLM_API_KEY` |
| `openrouter` | The prior production path, unchanged: `openai/gpt-4o-mini` primary, `google/gemini-2.5-flash` fallback slot, judges on OpenRouter. | `OPENROUTER_API_KEY` |

Resolution lives in `src/lib/llmBackend.ts`; `openrouter.ts` and
`faithfulness.ts` read it for their client config, `localQuizGenerator.ts`
reads it for model choice and concurrency.

## No automatic fallback

There is **no** silent fall-through between the two backends. In `local`
mode a failed or timed-out call is only ever retried against the same
self-hosted endpoint, through the existing per-slot retry ladder (primary →
repair retry → "fallback" — all the same model in this mode). A slot that
still can't be filled stays empty and flows into the existing top-up /
relaxation path, exactly as before. The **only** way an OpenRouter request
is ever made is `LLM_BACKEND=openrouter`.

## `local` mode: one model grades its own output

The self-hosted box serves a single 4B model, so in `local` mode the drafter
is also every judge (`primary == fallback == faithfulness/answerable/
difficulty judge`). A model scoring its own generations is more lenient than
an independent judge would be. This is an accepted limitation of running
fully local with one model — there is no second model on the endpoint. It's
logged once per process (`[localQuizGenerator] LLM_BACKEND=local: …`).

Separately, autoevals' `Faithfulness` prompt doesn't always parse cleanly
against a model this small. When the judge call fails or returns no numeric
score, `scoreFaithfulness` **fails open** (returns `null` → the caller skips
the grounding check for that question) and logs it
(`[faithfulness] judge "…" … failing open, grounding check skipped`). Watch
the rate of that line in Cloud Run logs — a high rate means grounding is
effectively unenforced.

## Env vars

### `local` backend (the default)

| Var | Default | Notes |
|---|---|---|
| `LLM_BACKEND` | `local` | Set to `openrouter` to opt out. |
| `LLM_BASE_URL` | `https://llm-box.tailc146aa.ts.net/v1` | Origin + base path; `/chat/completions` is appended. A trailing slash is trimmed. |
| `LLM_API_KEY` | *(none — required)* | Bearer token the endpoint expects. **Secret** — env / Cloud Run secret only, never committed. Unset → a clear `LLM_API_KEY is not set` error at call time. |
| `LLM_MODEL` | `qwen3-4b-local` | The only model on the box. |
| `LLM_TIMEOUT_MS` | `180000` | Per-request timeout. A local 4B model on one GPU is far slower than a hosted API; 30s is not enough. |
| `LLM_CONCURRENCY` | `3` | Parallel model calls during the main fill. One GPU handles ~3 before latency balloons. |
| `LLM_TOPUP_CONCURRENCY` | `3` | Same, for the relaxed end-of-run top-up pass. |

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
