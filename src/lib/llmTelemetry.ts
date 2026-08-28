/**
 * Lightweight per-run accounting for the LLM calls a single quiz generation
 * makes — call type, prompt/completion tokens, and wall latency each, plus a
 * roll-up (total wall time, call count by type, token totals, median draft
 * prompt size). Written so the dominant cost of a self-hosted generation
 * (prompt tokens carried into every draft/repair/judge call — see
 * docs/self-hosted-llm.md) is visible in Cloud Run logs without a profiler.
 *
 * State is module-level and a run is delimited by beginRun()/endRun(). Quiz
 * generation is effectively one-at-a-time per process (a single host clicks
 * "generate" and waits on the SSE stream), so overlapping runs would
 * co-mingle counts; endRun() is best-effort and never throws. This is
 * observability only — nothing downstream branches on it.
 */

export type LlmCallType = "draft" | "repair" | "judge" | "unknown";

export type LlmCallRecord = {
  callType: LlmCallType;
  /** From the endpoint's `usage` block when present, otherwise a chars/4
   *  estimate (see `estimated`). */
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** true when prompt/completion tokens are the chars/4 fallback rather than
   *  a server-reported count. */
  estimated: boolean;
};

export type LlmRunSummary = {
  wallMs: number;
  callCount: number;
  callsByType: Record<LlmCallType, number>;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Median prompt tokens across draft+repair calls only — the P0-1 lever
   *  (target < 3000 for a typical multi-topic quiz). */
  medianGenerationPromptTokens: number;
  /** true when any record in the run used the chars/4 estimate. */
  tokensPartlyEstimated: boolean;
};

let active = false;
let startedAt = 0;
let records: LlmCallRecord[] = [];

/** Starts (or restarts) a run. Any in-flight run's records are discarded. */
export function beginRun(): void {
  active = true;
  startedAt = Date.now();
  records = [];
}

/** Records one completed LLM call. No-op when no run is active. */
export function recordLlmCall(record: LlmCallRecord): void {
  if (!active) return;
  records.push(record);
}

/** Rough token count for endpoints that don't return a `usage` block. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** Ends the run and returns its summary. Safe to call with no active run. */
export function endRun(): LlmRunSummary {
  const wallMs = active ? Date.now() - startedAt : 0;
  const callsByType: Record<LlmCallType, number> = { draft: 0, repair: 0, judge: 0, unknown: 0 };
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let tokensPartlyEstimated = false;
  const generationPromptTokens: number[] = [];
  for (const record of records) {
    callsByType[record.callType]++;
    totalPromptTokens += record.promptTokens;
    totalCompletionTokens += record.completionTokens;
    if (record.estimated) tokensPartlyEstimated = true;
    if (record.callType === "draft" || record.callType === "repair") {
      generationPromptTokens.push(record.promptTokens);
    }
  }
  const summary: LlmRunSummary = {
    wallMs,
    callCount: records.length,
    callsByType,
    totalPromptTokens,
    totalCompletionTokens,
    medianGenerationPromptTokens: median(generationPromptTokens),
    tokensPartlyEstimated,
  };
  active = false;
  records = [];
  return summary;
}
