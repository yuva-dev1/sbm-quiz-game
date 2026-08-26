import { firestore } from "@/lib/firestore";

type NewQuestionInput = {
  order: number;
  type: "MULTIPLE_CHOICE" | "TRUE_FALSE" | "SHORT_ANSWER" | "MULTI_SELECT";
  question: string;
  choices: string[];
  correctChoices: string[];
  explanation: string;
  timeLimitSecs: number;
  /** Verbatim quote from the course notes backing this question, self-
   * reported and verified by the generator (src/lib/localQuizGenerator.ts) —
   * absent for manually-authored questions (see AddQuestionForm) and for
   * ungrounded generation. Shown in the host's draft/published question
   * preview so a question's grounding can actually be checked, not just
   * trusted. */
  sourceExcerpt?: string | null;
};

/**
 * Batch-creates a Quiz doc plus its Question docs — the one place every
 * Quiz-creation site (generation, seed script, load-test fixture) should go
 * through, rather than each hand-rolling the full default field set.
 * Firestore has no schema-level defaults the way Prisma's `@default(...)`
 * did, so a Quiz doc missing any of these fields leaves later reads seeing
 * `undefined` instead of the expected value — a real hazard hit twice
 * already during this migration (see the plan's Phase 5/7 notes).
 *
 * Every Question doc also gets a `quizCreatedAt` copy of the parent's
 * `createdAt` (both set from the same in-memory value, never two separate
 * `serverTimestamp()` calls) so generateQuizRequest.ts's
 * collectionGroup("questions") dedup query can order by it without a join —
 * and a `weekIds` copy of the parent's `weekIds` so that same query can
 * scope its avoid-list to the relevant week(s) instead of the whole app's
 * recent history.
 */
export async function createQuiz(input: {
  title: string;
  description: string;
  status?: "DRAFT" | "PUBLISHED";
  mode?: "LIVE" | "SELF_PACED";
  weekIds: string[];
  questions: NewQuestionInput[];
}) {
  const createdAt = new Date();
  const status = input.status ?? "DRAFT";
  const mode = input.mode ?? "LIVE";

  const quizRef = firestore.collection("quizzes").doc();
  await quizRef.set({
    title: input.title,
    description: input.description,
    status,
    createdAt,
    updatedAt: createdAt,
    mode,
    weekIds: input.weekIds,
    slug: null,
    responsesOpen: false,
    opensAt: null,
    closesAt: null,
    showLeaderboardDefault: true,
    showTimerDefault: true,
    scoringMode: "SPEED",
    leadTimeSecs: 5,
  });

  const questionsRef = quizRef.collection("questions");
  const batch = firestore.batch();
  const questions = input.questions.map((question) => {
    const ref = questionsRef.doc();
    batch.set(ref, { ...question, quizCreatedAt: createdAt, weekIds: input.weekIds });
    return { id: ref.id, ...question };
  });
  await batch.commit();

  return { id: quizRef.id, title: input.title, status, questions };
}
