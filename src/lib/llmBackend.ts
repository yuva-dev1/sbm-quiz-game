/**
 * The single switch deciding which LLM backend every quiz-generation call
 * uses. Read by openrouter.ts (the chat-completions client), faithfulness.ts
 * (the RAGAS judge client), and localQuizGenerator.ts (model choice +
 * concurrency).
 *
 * `LLM_BACKEND` (env):
 *   - "local" — the DEFAULT when unset. 100% self-hosted: every generation
 *     call (primary draft, repair retry, fallback-slot draft) AND every
 *     judge call (faithfulness, answerable, difficulty-match) goes to the
 *     self-hosted OpenAI-compatible endpoint at LLM_BASE_URL using the one
 *     model LLM_MODEL. The OpenRouter code path is unreachable in this mode.
 *   - "openrouter" — the prior production behaviour, unchanged:
 *     OPENROUTER_MODEL_PRIMARY (gpt-4o-mini) primary with an
 *     OPENROUTER_MODEL_FALLBACK (gemini-2.5-flash) slot, judges on
 *     OpenRouter, keyed by OPENROUTER_API_KEY.
 *
 * There is deliberately NO automatic fall-through between the two. In
 * "local" mode a failed or timed-out call is only ever retried against the
 * same self-hosted endpoint through the existing per-slot retry ladder in
 * localQuizGenerator; a slot that still can't be filled stays empty and
 * flows into the existing top-up / relaxation path. The ONLY way an
 * OpenRouter request is ever made is LLM_BACKEND=openrouter.
 *
 * Grading in "local" mode: with a single model on the box, the drafter also
 * grades its own output (primary == fallback == judge). Self-grading runs
 * more lenient than an independent judge would; this is an accepted
 * limitation of running fully local with one 4B model — there is no second
 * model on the endpoint. See judgeQuestion in faithfulness.ts: on "local"
 * it gates on grounding only and fails open (verdict null → keep the draft)
 * if the small model can't return a clean JSON verdict.
 */

export type LlmBackend = "local" | "openrouter";

/** Resolved per call (not cached) so tests can flip env between cases. */
export function llmBackend(): LlmBackend {
  return process.env.LLM_BACKEND === "openrouter" ? "openrouter" : "local";
}

// --- self-hosted endpoint defaults -----------------------------------------
// LLM_BASE_URL is safe to default in source (a Tailscale Funnel hostname,
// not a secret). LLM_API_KEY is a secret and has NO default — it must come
// from the environment (.env locally, a Cloud Run secret in prod); an unset
// key surfaces as a clear "LLM_API_KEY is not set" error at call time.
const DEFAULT_LLM_BASE_URL = "https://llm-box.tailc146aa.ts.net/v1";
const DEFAULT_LLM_MODEL = "qwen3-4b-local";
// Once generation and judge calls carry only a per-slot scoped passage
// (~1-4k tokens) instead of the whole week's notes (~27k), a warm call
// lands in a few seconds and a cold start / repair no longer needs minutes
// of headroom. Overridable via LLM_TIMEOUT_MS.
const DEFAULT_LLM_TIMEOUT_MS = 60_000;
// With small per-slot prompts one stream no longer saturates the GPU, so the
// box can serve more in parallel. This assumes the self-hosted endpoint runs
// OLLAMA_NUM_PARALLEL >= 6 (see docs/self-hosted-llm.md); if it doesn't, the
// extra calls just queue there — set LLM_CONCURRENCY / LLM_TOPUP_CONCURRENCY
// back down to match.
const DEFAULT_LLM_CONCURRENCY = 6;
const DEFAULT_LLM_TOPUP_CONCURRENCY = 6;

// --- OpenRouter defaults (unchanged production behaviour) -----------------
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_PRIMARY_MODEL = "openai/gpt-4o-mini";
const DEFAULT_OPENROUTER_FALLBACK_MODEL = "google/gemini-2.5-flash";
const OPENROUTER_TIMEOUT_MS = 30_000;
const OPENROUTER_CONCURRENCY = 32;
const OPENROUTER_TOPUP_CONCURRENCY = 16;

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type LlmClientConfig = {
  backend: LlmBackend;
  /** Origin + base path, trailing slash stripped, no "/chat/completions". */
  baseURL: string;
  apiKey: string | undefined;
  /** Env var name to cite when apiKey is missing. */
  apiKeyEnvHint: string;
  timeoutMs: number;
  /** OpenRouter-only analytics headers; empty for the self-hosted endpoint. */
  extraHeaders: Record<string, string>;
};

/** Base URL / key / timeout / headers for the raw chat-completions client
 *  (openrouter.ts), also used by the combined judge in faithfulness.ts. */
export function llmClientConfig(): LlmClientConfig {
  if (llmBackend() === "openrouter") {
    return {
      backend: "openrouter",
      baseURL: OPENROUTER_BASE_URL,
      apiKey: process.env.OPENROUTER_API_KEY,
      apiKeyEnvHint: "OPENROUTER_API_KEY",
      timeoutMs: OPENROUTER_TIMEOUT_MS,
      extraHeaders: {
        // OpenRouter uses these purely for its own leaderboards/analytics.
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://bhagavatham-quiz-game",
        "X-Title": "Bhagavatam Quiz Live",
      },
    };
  }
  return {
    backend: "local",
    baseURL: (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, ""),
    apiKey: process.env.LLM_API_KEY,
    apiKeyEnvHint: "LLM_API_KEY",
    timeoutMs: positiveIntFromEnv(process.env.LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS),
    extraHeaders: {},
  };
}

/** Draft models for the per-slot retry ladder. In "local" mode the box
 *  serves one model, so primary == fallback: the ladder still runs, every
 *  rung just hits the same model/endpoint (never OpenRouter). */
export function generationModels(): { primaryModel: string; fallbackModel: string } {
  if (llmBackend() === "openrouter") {
    return {
      primaryModel: process.env.OPENROUTER_MODEL_PRIMARY || DEFAULT_OPENROUTER_PRIMARY_MODEL,
      fallbackModel: process.env.OPENROUTER_MODEL_FALLBACK || DEFAULT_OPENROUTER_FALLBACK_MODEL,
    };
  }
  const model = process.env.LLM_MODEL || DEFAULT_LLM_MODEL;
  return { primaryModel: model, fallbackModel: model };
}

/** Parallel model calls per generation. OpenRouter absorbs 32/16 fine; the
 *  self-hosted GPU uses LLM_CONCURRENCY / LLM_TOPUP_CONCURRENCY (default 6/6,
 *  assumes OLLAMA_NUM_PARALLEL >= 6 on the box). */
export function generationConcurrency(): { concurrency: number; topupConcurrency: number } {
  if (llmBackend() === "openrouter") {
    return { concurrency: OPENROUTER_CONCURRENCY, topupConcurrency: OPENROUTER_TOPUP_CONCURRENCY };
  }
  return {
    concurrency: positiveIntFromEnv(process.env.LLM_CONCURRENCY, DEFAULT_LLM_CONCURRENCY),
    topupConcurrency: positiveIntFromEnv(process.env.LLM_TOPUP_CONCURRENCY, DEFAULT_LLM_TOPUP_CONCURRENCY),
  };
}
