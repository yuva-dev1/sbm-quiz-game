import "dotenv/config";
import { getCourseCatalog, resolveGenerationScope, getSourceText, getTopicSourceText } from "@/lib/courseCatalog";
import { generateQuiz } from "@/lib/localQuizGenerator";

/**
 * Fixed-selection latency benchmark for quiz generation — the before/after
 * check for the self-hosted-latency work (see docs/self-hosted-llm.md).
 * Calls generateQuiz directly (no Firestore, no dedup history) so it
 * measures the generator + LLM backend, nothing else. generateQuiz already
 * logs its own per-run telemetry summary; this adds the wall-clock headline.
 *
 * Usage (needs LLM_API_KEY / LLM_BASE_URL in .env, or LLM_BACKEND=openrouter
 * + OPENROUTER_API_KEY):
 *   npx tsx scripts/bench_generation.ts
 *   WEEKS=week-4,week-5,week-6 COUNT=15 DIFFICULTY=mixed npx tsx scripts/bench_generation.ts
 */

async function main(): Promise<void> {
  const weekIds = (process.env.WEEKS ?? "week-6,week-7").split(",").map((s) => s.trim()).filter(Boolean);
  const questionCount = Number(process.env.COUNT ?? 15);
  const difficulty = (process.env.DIFFICULTY ?? "mixed") as "beginner" | "intermediate" | "advanced" | "mixed";
  const topics = (process.env.TOPICS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const catalog = await getCourseCatalog();
  const { topics: scopeTopics, coverageLabel } = resolveGenerationScope(
    catalog,
    weekIds,
    topics.length > 0 ? topics : null
  );
  const sourceText = getSourceText(catalog, weekIds, null);
  const topicSourceText = getTopicSourceText(catalog, weekIds, scopeTopics);

  console.log(
    `[bench] backend=${process.env.LLM_BACKEND ?? "local"} weeks=${weekIds.join(",")} ` +
      `topics=${scopeTopics.length} count=${questionCount} difficulty=${difficulty} ` +
      `fullSourceText=${sourceText.length} chars, topicSourceText=${Object.keys(topicSourceText).length} passages`
  );

  const started = Date.now();
  const quiz = await generateQuiz({
    topics: scopeTopics,
    sourceText,
    topicSourceText,
    questionCount,
    difficulty,
    coverageLabel,
  });
  const wallSecs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[bench] OK — ${quiz.questions.length}/${questionCount} questions in ${wallSecs}s wall (target < ~60s)`);
}

main().catch((error) => {
  console.error("[bench] FAILED:", error);
  process.exit(1);
});
