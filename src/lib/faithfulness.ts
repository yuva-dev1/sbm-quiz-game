/**
 * One LLM-as-judge call that grades a drafted quiz question on up to three
 * independent axes at once:
 *
 *   - faithful         — every factual claim in the question, answer, and
 *                        explanation is stated or clearly entailed by the
 *                        course-note excerpt (grounding).
 *   - answerable       — (multiple_choice only) the wording actually narrows
 *                        the four choices to one defensible answer, rather
 *                        than the marked answer merely being *a* true fact
 *                        among several plausible ones.
 *   - difficultyMatch  — the question hits the difficulty tier it was
 *                        written for (criteria passed in by the caller).
 *
 * This replaced three separate round-trips (autoevals' RAGAS Faithfulness,
 * plus a bespoke answerability judge and a difficulty-tier judge). At the
 * ~27k-token prompts the self-hosted backend was carrying, three judge calls
 * per question dominated generation latency; folding them into one call that
 * sees only the per-slot scoped passage is the single biggest cut. The
 * caller decides which axes to actually gate on (see `askFaithful` /
 * `askAnswerable` / `difficultyCriteria`) — unrequested axes are neither
 * asked for nor returned.
 *
 * Fails open: if the judge call itself errors, returns non-JSON, or omits a
 * requested key, the corresponding field is null and the caller skips that
 * gate rather than dropping an otherwise-good question over a validator
 * hiccup. A 4B self-hosted model grading its own draft (LLM_BACKEND=local,
 * where drafter == judge) is lenient signal, and a flaky self-"fail" only
 * costs a wasted repair round — so `local` deliberately gates on faithful
 * only (see attemptDraft), and this call is skipped entirely when a verbatim
 * source_excerpt already backs a verbatim answer.
 */

import { z } from "zod";
import { completeChat, type ChatMessage } from "@/lib/openrouter";

export type JudgeVerdict = {
  faithful: boolean | null;
  answerable: boolean | null;
  difficultyMatch: boolean | null;
  reason: string;
};

const VerdictSchema = z.object({
  faithful: z.boolean().optional(),
  answerable: z.boolean().optional(),
  difficultyMatch: z.boolean().optional(),
  reason: z.string().optional(),
});

export type JudgeQuestionParams = {
  question: string;
  type: "multiple_choice" | "true_false";
  choices: string[];
  answer: string;
  explanation: string;
  /** The exact text the drafter was shown for this slot (per-slot scoped
   *  passage, not the whole corpus) — grounding must be checked against
   *  precisely what the model saw. */
  sourceText: string;
  judgeModel: string;
  /** Gate on grounding. Forced off (and unasked) when there's no source text. */
  askFaithful: boolean;
  /** Gate on single-defensible-answer. multiple_choice only. */
  askAnswerable: boolean;
  /** Non-null => also grade the difficulty tier against this pass/fail bar. */
  difficultyCriteria: string | null;
};

const EMPTY_VERDICT: JudgeVerdict = { faithful: null, answerable: null, difficultyMatch: null, reason: "" };

export async function judgeQuestion(params: JudgeQuestionParams): Promise<JudgeVerdict | null> {
  const grounded = params.sourceText.trim().length > 0;
  const askFaithful = params.askFaithful && grounded;
  const askAnswerable = params.askAnswerable && params.type === "multiple_choice";
  const askDifficulty = params.difficultyCriteria !== null;
  if (!askFaithful && !askAnswerable && !askDifficulty) return EMPTY_VERDICT;

  const checks: string[] = [];
  const shapeKeys: string[] = [];
  if (askFaithful) {
    checks.push(
      '- "faithful": true only if EVERY factual claim in the question, marked answer, and explanation is ' +
        "explicitly stated in, or unambiguously entailed by, the course-note excerpt above. If any name, " +
        "number, relationship, or motive is not traceable to a specific phrase in the excerpt, it is false."
    );
    shapeKeys.push('"faithful":true|false');
  }
  if (askAnswerable) {
    checks.push(
      '- "answerable": true only if the question wording pins down exactly one of the four choices as ' +
        "defensible. It is false if the only way to pick the marked answer over the others is to have " +
        "memorized an arbitrary sequence, list order, or position while the other choices are otherwise " +
        "equally valid members of the same category."
    );
    shapeKeys.push('"answerable":true|false');
  }
  if (askDifficulty) {
    checks.push(`- "difficultyMatch": ${params.difficultyCriteria}`);
    shapeKeys.push('"difficultyMatch":true|false');
  }
  shapeKeys.push('"reason":"one short sentence"');

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a strict quality reviewer for quiz questions on the Srimad Bhagavatam. Judge only what is " +
        "asked. Respond with a single strict JSON object only — no markdown code fences, no commentary.",
    },
    {
      role: "user",
      content: [
        grounded ? `Course-note excerpt:\n"""\n${params.sourceText.trim()}\n"""\n` : "",
        "Apply each of these checks independently:",
        ...checks,
        "",
        `Question: ${params.question}`,
        params.type === "multiple_choice" ? `Choices: ${params.choices.join(" / ")}` : "",
        `Marked answer: ${params.answer}`,
        `Explanation: ${params.explanation}`,
        "",
        `Return JSON matching exactly this shape: {${shapeKeys.join(",")}}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];

  let raw: string;
  try {
    raw = await completeChat(params.judgeModel, messages, "judge");
  } catch (error) {
    console.warn(
      `[judgeQuestion] judge "${params.judgeModel}" call failed — failing open, checks skipped for this ` +
        `question: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  let parsed: z.infer<typeof VerdictSchema>;
  try {
    const result = VerdictSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      console.warn(
        `[judgeQuestion] judge "${params.judgeModel}" returned JSON that didn't match the verdict shape — ` +
          "failing open, checks skipped for this question."
      );
      return null;
    }
    parsed = result.data;
  } catch {
    console.warn(
      `[judgeQuestion] judge "${params.judgeModel}" returned non-JSON — failing open, checks skipped for ` +
        "this question."
    );
    return null;
  }

  return {
    faithful: askFaithful ? parsed.faithful ?? null : null,
    answerable: askAnswerable ? parsed.answerable ?? null : null,
    difficultyMatch: askDifficulty ? parsed.difficultyMatch ?? null : null,
    reason: parsed.reason ?? "",
  };
}
