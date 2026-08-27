/**
 * Shared request validation + catalog scoping for the two quiz-generation
 * entry points (src/app/generate-quiz/route.ts and
 * src/app/api/quizzes/generate/route.ts) so the two don't drift on what
 * counts as a valid request.
 */

import { getCourseCatalog, resolveGenerationScope, getSourceText } from "@/lib/courseCatalog";
import { firestore } from "@/lib/firestore";
import type { GeneratedQuestion } from "@/lib/localQuizGenerator";

export const ALLOWED_DIFFICULTIES = new Set(["beginner", "intermediate", "advanced", "mixed"]);
export const ALLOWED_QUESTION_COUNTS = new Set([5, 8, 10, 15, 20, 25, 30, 35]);
// Bounds both the DB query and the resulting avoid-list size — the course
// corpus is small (a single class's worth of material), so this comfortably
// covers realistic history without the query or prompt growing unbounded.
const MAX_EXISTING_QUESTIONS_FOR_DEDUP = 150;

export type Difficulty = "beginner" | "intermediate" | "advanced" | "mixed";
export type QuizMode = "LIVE" | "SELF_PACED";

export type GenerateQuizRequest = {
  weekIds: string[];
  requestedTopics: string[];
  questionCount: number;
  difficulty: Difficulty;
  /** Which quiz experience the generated quiz is for — LIVE (Kahoot-style) or
   * SELF_PACED (Google-Forms-style). Purely a tag on the created Quiz row;
   * doesn't change what the generator itself produces. */
  mode: QuizMode;
  scopeTopics: string[];
  coverageLabel: string;
  sourceText: string;
  /** Prior quizzes' questions, most recent first — seeds generation's
   * duplicate-avoidance beyond just the questions drafted in this one run. */
  existingQuestions: GeneratedQuestion[];
};

export type GenerateQuizRequestResult =
  | { ok: true; value: GenerateQuizRequest }
  | { ok: false; error: string; status: number };

export async function resolveGenerateQuizRequest(request: Request): Promise<GenerateQuizRequestResult> {
  const body = await request.json().catch(() => null);
  const weekIds: string[] = Array.isArray(body?.weekIds)
    ? body.weekIds.filter((id: unknown) => typeof id === "string")
    : [];
  const requestedTopics: string[] = Array.isArray(body?.topics)
    ? body.topics.filter((t: unknown) => typeof t === "string" && t.trim() !== "")
    : [];
  const questionCount = Number(body?.questionCount ?? 8);
  const difficulty = typeof body?.difficulty === "string" ? body.difficulty : "mixed";
  const mode = body?.mode === "SELF_PACED" ? "SELF_PACED" : "LIVE";

  if (weekIds.length === 0) {
    return { ok: false, error: "Select at least one class week.", status: 400 };
  }
  if (!ALLOWED_QUESTION_COUNTS.has(questionCount)) {
    return { ok: false, error: "questionCount must be one of 5, 8, 10, 15, 20, 25, 30, 35.", status: 400 };
  }
  if (!ALLOWED_DIFFICULTIES.has(difficulty)) {
    return { ok: false, error: "difficulty must be beginner, intermediate, advanced, or mixed.", status: 400 };
  }

  const catalog = await getCourseCatalog();
  const knownWeekIds = new Set(catalog.map((week) => week.id));
  if (!weekIds.every((id) => knownWeekIds.has(id))) {
    return { ok: false, error: "One or more selected weeks were not found.", status: 400 };
  }

  const { topics: scopeTopics, coverageLabel } = resolveGenerationScope(
    catalog,
    weekIds,
    requestedTopics.length > 0 ? requestedTopics : null
  );
  if (scopeTopics.length === 0) {
    return { ok: false, error: "No topics found for that week/topic combination. Try 'All topics'.", status: 400 };
  }

  // Topic-scoped grounding (just the selected topics' excerpts instead of the
  // whole week's notes — see getSourceText) is limited to SELF_PACED quizzes.
  // A LIVE (Kahoot) quiz always gets the full week's notes, so this
  // optimisation can never change what a live session serves. Empty
  // requestedTopics means "all topics", which is the full week either way.
  const useTopicScope = mode === "SELF_PACED" && requestedTopics.length > 0;
  const sourceText = getSourceText(catalog, weekIds, useTopicScope ? scopeTopics : null);

  // Only MULTIPLE_CHOICE/TRUE_FALSE match what the generator itself ever
  // produces (and what findDuplicate's answer/choice-overlap check expects)
  // — MULTI_SELECT/SHORT_ANSWER questions are excluded rather than
  // shoehorned into that shape.
  //
  // "Most recent quizzes first" was a join on the parent Quiz's createdAt in
  // Prisma — Firestore collection-group queries can't join, so each
  // Question doc carries a denormalized quizCreatedAt field (set wherever
  // Question docs are created — see src/app/api/quizzes/[id]/questions/route.ts
  // and .../generate/route.ts) specifically so this query can order by it
  // directly.
  //
  // Scoped to the requested week(s) via a same denormalized-onto-Question-doc
  // trick (weekIds, copied from the parent Quiz) — unscoped, this pulled the
  // 150 most recent questions from *any* quiz on *any* week, which stopped
  // being useful signal as the corpus grew and made findDuplicate burn
  // retries "avoiding" facts from completely unrelated material instead of
  // the ones actually likely to repeat. Quiz/Question docs written before
  // this field existed simply have no weekIds and never match — no backfill
  // needed, the avoid-list just fills back in naturally as new quizzes on a
  // week accumulate.
  const existingQuestionsSnap = await firestore
    .collectionGroup("questions")
    .where("weekIds", "array-contains-any", weekIds)
    .where("type", "in", ["MULTIPLE_CHOICE", "TRUE_FALSE"])
    .orderBy("quizCreatedAt", "desc")
    .limit(MAX_EXISTING_QUESTIONS_FOR_DEDUP)
    .get();
  const existingQuestions: GeneratedQuestion[] = existingQuestionsSnap.docs.map((doc) => {
    const row = doc.data();
    return {
      id: doc.id,
      type: row.type === "TRUE_FALSE" ? "true_false" : "multiple_choice",
      question: row.question,
      choices: row.choices,
      answer: row.correctChoices[0] ?? "",
      explanation: "",
      // Not persisted (see route.ts's save mapping) so prior quizzes'
      // questions have none — findDuplicate's core_fact check is a no-op
      // against these rows (empty word-set never meets the overlap
      // threshold), same as the empty explanation above; the other checks
      // still apply.
      coreFact: "",
      // Unused by findDuplicate (the only thing this array feeds) — no need
      // to read the stored value back out for this.
      sourceExcerpt: null,
      // Only used for findDuplicate's avoid-list — timing is never derived
      // from these rows, so the actual stored value doesn't matter here.
      timeLimitSecs: row.timeLimitSecs,
    };
  });

  return {
    ok: true,
    value: {
      weekIds,
      requestedTopics,
      questionCount,
      difficulty: difficulty as Difficulty,
      mode,
      scopeTopics,
      coverageLabel,
      sourceText,
      existingQuestions,
    },
  };
}
