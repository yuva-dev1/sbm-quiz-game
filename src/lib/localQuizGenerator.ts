/**
 * Generates Bhagavatam class quiz questions in-house, one question at a time
 * (bounded concurrency), instead of calling out to an external RAG service.
 * Grounded in the actual course-note text for the selected week(s) — but
 * per slot, not per run: each slot is assigned a focus topic and shown only
 * that topic's hand-authored passage(s) (src/lib/courseCatalog.ts's
 * getTopicSourceText(), backed by src/data/courseTopicText.json), falling
 * back to the run-wide sourceText only when a topic has no index entry.
 * Inlining the whole selected-weeks corpus into every call was the dominant
 * cost of a self-hosted generation (see docs/self-hosted-llm.md); a ~1-4k
 * char per-slot passage keeps decode fast. Each candidate is checked by one
 * combined LLM-judge call (src/lib/faithfulness.ts's judgeQuestion) against
 * that same per-slot passage before being accepted.
 *
 * Each question slot gets its own model call so one bad response only costs
 * a single question, with a retry ladder per slot: primary model -> repair
 * retry (same model, shown its own bad output and, if the failure was low
 * faithfulness or a duplicate, told so) -> fallback model (openrouter only —
 * on "local" primary == fallback, so the third attempt is skipped). The
 * combined judge grades grounding, single-defensible-answer, and
 * difficulty-tier fit together in one round trip. On "openrouter" it runs on
 * the *other* model from whichever drafted the candidate, so a model never
 * grades its own output, and gates on all three axes; on the default "local"
 * backend there is only one model, so it grades its own draft and gates on
 * grounding only (difficulty and answerability are weak signal from a 4B
 * self-review, and a flaky self-"fail" only costs a wasted repair round).
 * Slots left empty (or knocked out by the cross-slot duplicate sweep) after
 * a pass are re-run in a further pass, looping until every slot is filled or
 * MAX_FILL_ROUNDS is hit — a single extra pass wasn't enough headroom to
 * reliably reach the requested question count for smaller quizzes.
 * Restricted to multiple_choice/true_false — the only types the live tap
 * UI can render (see Answer model's comment in schema.prisma).
 *
 * The single-defensible-answer axis (multiple_choice only) catches a
 * different defect from faithfulness: a question whose marked answer is
 * factually correct per the source, but whose wording doesn't narrow the
 * choices down to just one of them — e.g. "who is first in the lineage of
 * transmission" with four choices that are all real, named members of that
 * lineage. The marked answer being true isn't enough; the question has to
 * actually let a student *reason their way* to it rather than guess among
 * equally plausible options. "Is this true" and "does this question have
 * exactly one defensible answer" are different questions, judged by
 * different criteria in the same combined call.
 *
 * Duplicate detection (findDuplicate) catches questions that reuse the same
 * fact even when reworded — e.g. two differently-phrased questions that
 * both boil down to "what is Ashraya" with the same four answer choices
 * just reordered. Word-overlap on the question text alone misses this (the
 * wording can differ a lot); what's actually diagnostic for multiple-choice
 * is a shared answer *plus* overlapping choice sets, since a course with a
 * fixed technical vocabulary (e.g. the ten characteristics of a Purana)
 * will legitimately reuse individual terms as distractors across genuinely
 * different questions — it's reusing the same answer with mostly the same
 * options that signals "this is the same question again," not just
 * touching the same topic. True_false questions have no choices to fall
 * back on and are often just a handful of words, so a shared-explanation
 * check catches those instead: the explanation is a near-direct restatement
 * of the source sentence backing the answer, so it stays similar across
 * paraphrases even when the question stem itself was reworded enough to
 * dodge the question-text overlap check. And because this course's material
 * restates its central themes across several different passages, even the
 * question *and* explanation can both be reworded enough to still slip
 * past — so each draft also carries a model-authored `core_fact`, a short
 * canonical label for the one specific fact it tests, which is checked
 * against prior questions' core_facts directly rather than inferring
 * sameness from prose. Checked per-slot against everything generated so far
 * (both this run's own questions and, if the caller passed
 * `existingQuestions`, prior quizzes' questions on the same material) and
 * swept again at the end since bounded concurrency lets two slots pass
 * their own check against the same stale snapshot at once.
 */

import { nanoid } from "nanoid";
import { z } from "zod";
import { completeChat, type ChatMessage } from "@/lib/openrouter";
import { judgeQuestion } from "@/lib/faithfulness";
import { llmBackend, generationModels, generationConcurrency } from "@/lib/llmBackend";
import { beginRun, endRun, type LlmCallType } from "@/lib/llmTelemetry";
import { MIN_TIME_LIMIT_SECS, MAX_TIME_LIMIT_SECS, DEFAULT_TIME_LIMIT_SECS } from "@/lib/timeLimits";

// Draft models and concurrency are backend-dependent and resolved per call
// in generateQuiz (see @/lib/llmBackend): the "openrouter" backend keeps the
// gpt-4o-mini + gemini fallback at 32/16 parallel calls tuned over several
// Cloud Run runs (25-card/2-week draft as a single wave, no 429s); the
// default "local" backend serves one model on one GPU, so both ladder rungs
// are that same model and concurrency is LLM_CONCURRENCY (default 6, small
// per-slot prompts — see docs/self-hosted-llm.md).

// Target share of a quiz that's true/false, the rest multiple_choice. Held
// to an exact per-quiz quota (see assignQuestionTypes) rather than a
// per-question coin flip — QA feedback was that quizzes were landing with
// noticeably more true/false than intended, which a per-slot Bernoulli draw
// allows by chance even at the right long-run average (a 10-question quiz at
// a 25% flip has a real chance of drawing 4-5 true/false).
const TRUE_FALSE_RATIO = 0.2;
const DUPLICATE_OVERLAP_THRESHOLD = 0.5;
// Slightly higher than DUPLICATE_OVERLAP_THRESHOLD: explanations in this
// course share a lot of recurring domain vocabulary ("Bhagavan", "Vyasa",
// "devotion", "glories", "leelas") even when they're backing genuinely
// different facts, so a lower bar would false-positive on unrelated
// questions that just happen to cite the same names.
const EXPLANATION_OVERLAP_THRESHOLD = 0.55;
// Lower than the others: core_fact is a short, deliberately canonical
// phrase (see GeneratedQuestion.coreFact), not free prose, so genuine
// restatements of the same fact land much higher than coincidental overlap
// between unrelated ones — a lower bar catches more without the false-positive
// risk a low threshold would carry on full sentences.
const CORE_FACT_OVERLAP_THRESHOLD = 0.45;
// Cap on how many avoid-list entries get spelled out in the prompt text
// itself — findDuplicate below still checks the full list regardless of
// this cap (free, no extra tokens); only the prompt text needs bounding,
// especially once existingQuestions (prior quizzes' history) is involved.
// Kept small: on the self-hosted backend the avoid-list is dynamic tail
// that can't be KV-cached, and only each entry's `core_fact` is sent now
// (not its full question text + choices), so 12 short labels is plenty of
// signal at a fraction of the tokens.
const MAX_AVOID_ENTRIES_IN_PROMPT = 12;
// The whole course-notes corpus is ~80KB (see src/data/courseNotes.json,
// notes PDFs plus manually-transcribed infographics) — comfortably under
// this even if a host selects every week at once. This is a safety cap
// against a much larger future corpus, not a normal-path limit.
const MAX_SOURCE_TEXT_CHARS = 150_000;
// Rounds of (re)generation attempted per slot before giving up on it —
// covers both slots that produced nothing (all 3 attempts in generateSlot
// failed) and slots knocked out by the cross-slot duplicate sweep. One
// extra pass beyond the initial draft wasn't enough to reliably hit the
// requested question count, especially for smaller quizzes where a single
// dropped slot is a visible fraction of the total. Note this is currently
// clamped down by MAX_ROUNDS_CEILING; the exact requested count is instead
// guaranteed by the relaxed top-up pass at the end of generateQuiz.
const MAX_FILL_ROUNDS = 5;
// Upper bound on maxRounds below, regardless of how many topics are in
// scope. Without this, a broad multi-week "all topics" request (each week
// contributes 6-9 topics — two weeks routinely means 15+) let maxRounds
// climb past 15, and a request that genuinely needed several of those
// rounds took several minutes end to end. This trades a small amount of
// fill-completeness on very broad, stubborn requests for a hard ceiling on
// worst-case latency.
//
// Rounds run strictly sequentially — round N+1 can't start until round N's
// full worker pool finishes and the cross-round duplicate sweep runs — so
// unlike the per-round fill itself, this ceiling isn't sped up by
// CONCURRENCY at all. Tested at 8: with CONCURRENCY=16, a 25-card/2-week
// request's *draft* pass alone (round 0) reached 19-23 of 25 in under 20s,
// but needing the full repair-round budget still pushed total time past
// 100s. Tightened to 3 (draft + 2 repair passes) specifically to bound
// wall-clock time, not just eventual fill-completeness.
const MAX_ROUNDS_CEILING = 3;
// After the quality-first rounds above, any shortfall against the requested
// question count is topped up here with progressively relaxed acceptance
// (see attemptDraft's `relax`): first drop the difficulty-tier and
// single-defensible-answer judges, then also drop the faithfulness score.
// The generation prompt is unchanged throughout, so these are still real,
// on-topic, source-grounded questions — a relaxed slot just isn't
// guaranteed to land on its exact difficulty tier. This is what makes
// "8 means 8" hold without raising the wall-clock ceiling above.
const MAX_TOPUP_ROUNDS_PER_LEVEL = 3;
// The top-up runs on a much smaller worker pool than the main fill and each
// relaxed slot is a single draft attempt rather than the
// primary→repair→fallback ladder. Both keep a large-count top-up from
// holding hundreds of in-flight responses at once — that memory spike (plus
// the extra wall-clock) is what tipped a 25-card request over the quiz
// service's limits and surfaced as an outright generation failure. The pool
// size itself is backend-dependent (16 for "openrouter", LLM_TOPUP_CONCURRENCY
// — default 3 — for "local"); see generationConcurrency in @/lib/llmBackend.
// Hard wall-clock budget for the whole relaxed top-up across all three
// levels — a genuinely thin scope (a single light week asked for 25+ cards)
// returns a little short rather than grinding until the request is killed
// upstream.
const TOPUP_DEADLINE_MS = 180_000;

export type GeneratedQuestion = {
  id: string;
  type: "multiple_choice" | "true_false";
  question: string;
  choices: string[];
  answer: string;
  explanation: string;
  /** Short canonical statement of the one specific fact/claim this question
   * tests (e.g. "Narada's reason for urging Vyasa to compose a scripture"),
   * self-reported by the model. Used only for in-batch/cross-quiz duplicate
   * detection (see findDuplicate) — not persisted to the saved quiz. Two
   * questions can be worded completely differently, with different
   * explanations, and still both boil down to the same takeaway (this
   * course's material restates "the point is to inspire devotion" in
   * several different passages); asking the model to name the fact directly
   * catches that, where word-overlap on the question/explanation text alone
   * doesn't reliably. */
  coreFact: string;
  /** A short phrase or sentence self-reported by the model as copied
   * verbatim from the course-note excerpt it was shown — mechanically
   * checked against that excerpt (see attemptDraft's excerpt_not_verbatim
   * check) before the question is ever accepted, so this is a real citation
   * a host can Ctrl+F for in the source notes, not just an LLM claim. Null
   * for ungrounded generation (no source text was available to quote from).
   * Persisted to the saved quiz so the host's draft/published question
   * preview can show it. */
  sourceExcerpt: string | null;
  /** Per-question countdown, derived from a word-count-based complexity score
   * (see computeTimeLimitSecs) rather than one flat default for every
   * question — a longer stem plus four choices needs more reading time than
   * a short true/false statement. */
  timeLimitSecs: number;
};

export type GeneratedQuiz = {
  title: string;
  description: string;
  questions: GeneratedQuestion[];
};

export type GenerationProgress = {
  phase: "draft" | "repairing" | "validating";
  completed: number;
  total: number;
};

export class QuizGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizGenerationError";
  }
}

type Difficulty = "beginner" | "intermediate" | "advanced" | "mixed";
type EffectiveDifficulty = "beginner" | "intermediate" | "advanced";
type QuestionType = "multiple_choice" | "true_false";
// How much of the acceptance gauntlet a draft attempt must clear, escalated
// by the end-of-run top-up in generateQuiz to guarantee the requested count.
// "none" is the full bar. "shape" drops only the single-defensible-answer
// judge (the one most prone to false rejects). "all" also drops the
// difficulty-tier judge — so the trivia ban is no longer enforced, though
// the generation prompt still discourages it. "bare" additionally drops
// faithfulness scoring and downgrades a missing/bad source_excerpt to just
// dropping the citation — the last-resort floor. Grounding (faithfulness)
// survives every level except "bare".
type RelaxLevel = "none" | "shape" | "all" | "bare";
type FailureReason =
  | "invalid_json"
  | "low_faithfulness"
  | "duplicate"
  | "ambiguous"
  | "choice_too_long"
  | "excerpt_not_verbatim"
  | "difficulty_mismatch";

/**
 * Writing instruction and judge criteria are defined together per tier
 * (rather than as two separately-maintained lists) so the difficulty axis of
 * the combined judge (judgeQuestion, fed judgeCriteria here) can never
 * reject a question for failing to do something the generation prompt was
 * never told to do — QA
 * feedback was that "Discussion" (intermediate) and "Mixed" quizzes felt
 * indistinguishable from "Foundations" (beginner) because the old one-line
 * guidance ("connect two related ideas or explain significance") was too
 * abstract for a small model to reliably act on, and nothing ever checked
 * whether it had.
 */
const DIFFICULTY_SPEC: Record<EffectiveDifficulty, { writingInstruction: string; judgeCriteria: string }> = {
  beginner: {
    writingInstruction:
      "a straightforward recall question answerable directly from ONE explicit clause or sentence in the " +
      'source — e.g. "What was Kunti Devi\'s prayer regarding calamities?" or "What did Arjuna do to ' +
      'Ashwatthama before letting him go?" The fact it tests must be substantive — an action someone takes, ' +
      "the outcome of an event, or a specific relationship between named figures. It must NOT be a bare number " +
      "or count, the expansion of a numbering code or abbreviation, the definition of a single term, or merely " +
      'which name belongs to a list. Do not phrase it as "why", "how does this relate to", or "what does this ' +
      'signify", and do not require connecting two separate facts — a student should be able to point to a ' +
      "single sentence in the source and be done.",
    judgeCriteria:
      "PASSES only if the question is answerable by locating a single explicit statement in the source, with " +
      'no need to connect it to any other fact or interpret its significance. FAILS if it uses "why" / "how ' +
      'does X relate to Y" / "what does this signify" phrasing, or if answering it requires combining two ' +
      "separate facts from the source. ALSO FAILS if the fact it tests is just a bare number or count " +
      "(including a true/false statement that merely asserts a count), a numbering-code or abbreviation " +
      "expansion, a single term's definition, or which items belong to a list the source enumerates — those " +
      "are too trivial to ask even at this tier.",
  },
  intermediate: {
    writingInstruction:
      "a question that names two distinct facts, people, or events from the source and asks the student to " +
      "connect them — a cause and its stated effect, a person and the stated reason for their action, or how " +
      "two described events relate — not a question answerable from a single isolated clause.",
    judgeCriteria:
      "PASSES only if answering requires connecting two distinct named facts/entities from the source (e.g. a " +
      "cause and its effect, or a person and the reason behind their action). FAILS if it's answerable from " +
      "one isolated clause with nothing to connect, and also FAILS if it's a broad interpretive/thematic " +
      "question with no two concrete facts actually being connected.",
  },
  advanced: {
    writingInstruction:
      "a reflective question asking what a described event, teaching, or statement in the source signifies, " +
      "why it matters, or what it reveals — going beyond restating what happened to its significance or " +
      "implication, while staying strictly grounded in what the source actually says (do not introduce outside " +
      "interpretation not supported by the excerpt).",
    judgeCriteria:
      "PASSES only if it asks for the significance, implication, or deeper meaning of something in the " +
      "source, not just what happened. FAILS if it's simple recall answerable directly from one clause with " +
      "no interpretation asked for.",
  },
};

// Weighted, not uniform: QA feedback singled out an easy, single-fact
// question as the target feel for most of a quiz, with only the occasional
// harder one — a plain 1-in-3 split was landing a third of every "mixed"
// quiz on intermediate/advanced, too much for that goal.
const MIXED_DIFFICULTY_WEIGHTS: Record<EffectiveDifficulty, number> = {
  beginner: 0.7,
  intermediate: 0.2,
  advanced: 0.1,
};

function pickEffectiveDifficulty(difficulty: Difficulty): EffectiveDifficulty {
  if (difficulty !== "mixed") return difficulty;
  const roll = Math.random();
  let cumulative = 0;
  for (const [tier, weight] of Object.entries(MIXED_DIFFICULTY_WEIGHTS) as [EffectiveDifficulty, number][]) {
    cumulative += weight;
    if (roll < cumulative) return tier;
  }
  return "advanced";
}

/**
 * Assigns each slot in the quiz a fixed question type up front, holding the
 * true/false share to an exact quota (see TRUE_FALSE_RATIO) instead of
 * rolling it per-slot — a slot's type is decided once here and stays fixed
 * across every retry/repair round in generateQuiz, so the final quiz can't
 * drift off the target ratio no matter how many slots need re-rolling.
 */
function assignQuestionTypes(questionCount: number): QuestionType[] {
  const trueFalseCount = Math.min(questionCount, Math.round(questionCount * TRUE_FALSE_RATIO));
  const types: QuestionType[] = [
    ...Array<QuestionType>(trueFalseCount).fill("true_false"),
    ...Array<QuestionType>(questionCount - trueFalseCount).fill("multiple_choice"),
  ];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }
  return types;
}

function normalizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Below this many normalized words, Jaccard overlap is too noisy to trust as
// a duplicate signal — e.g. two unrelated one-word explanations that happen
// to share that one word score a perfect 1.0. Real explanations/core_facts
// are always short sentences/phrases well above this, so it only guards
// against degenerate input (a model returning a near-empty field).
const MIN_WORDS_FOR_OVERLAP_CHECK = 3;

function meaningfulOverlap(a: Set<string>, b: Set<string>, threshold: number): boolean {
  if (a.size < MIN_WORDS_FOR_OVERLAP_CHECK || b.size < MIN_WORDS_FOR_OVERLAP_CHECK) return false;
  return jaccard(a, b) >= threshold;
}

/** See the module docstring for why this checks answer+choices, not just question-text similarity. */
function findDuplicate(candidate: GeneratedQuestion, existing: GeneratedQuestion[]): GeneratedQuestion | null {
  const candidateQuestionWords = normalizeWords(candidate.question);
  const candidateExplanationWords = normalizeWords(candidate.explanation);
  const candidateCoreFactWords = normalizeWords(candidate.coreFact);
  for (const other of existing) {
    if (jaccard(candidateQuestionWords, normalizeWords(other.question)) >= DUPLICATE_OVERLAP_THRESHOLD) {
      return other;
    }
    if (candidate.type === "multiple_choice" && other.type === "multiple_choice") {
      const sameAnswer = candidate.answer.trim().toLowerCase() === other.answer.trim().toLowerCase();
      const choiceOverlap = jaccard(normalizeWords(candidate.choices.join(" ")), normalizeWords(other.choices.join(" ")));
      if (sameAnswer && choiceOverlap >= DUPLICATE_OVERLAP_THRESHOLD) return other;
    }
    // Two questions worded very differently can still be testing the exact
    // same underlying fact — the explanation is what actually names that
    // fact (it's a direct restatement of the source sentence backing the
    // answer), so it stays similar across paraphrases even when the question
    // stem and choices are reworded enough to dodge the checks above. This
    // is what catches the true_false case, which has no choices to compare
    // and often only a handful of words in the question itself.
    if (meaningfulOverlap(candidateExplanationWords, normalizeWords(other.explanation), EXPLANATION_OVERLAP_THRESHOLD)) {
      return other;
    }
    // Belt-and-suspenders on top of the above: a course whose central thesis
    // ("the point of it all is devotion to Bhagavan") gets restated in
    // several different passages can produce two questions with genuinely
    // different question wording *and* different explanation prose that
    // still both just test that same restated thesis. Comparing the model's
    // own short, canonical restatement of "what fact is this testing"
    // catches that case directly instead of hoping surface wording overlaps.
    if (meaningfulOverlap(candidateCoreFactWords, normalizeWords(other.coreFact), CORE_FACT_OVERLAP_THRESHOLD)) {
      return other;
    }
  }
  return null;
}

function clampSourceText(sourceText: string): string {
  if (sourceText.length <= MAX_SOURCE_TEXT_CHARS) return sourceText;
  return sourceText.slice(0, MAX_SOURCE_TEXT_CHARS) + "\n\n[...source truncated...]";
}

function buildSystemPrompt(grounded: boolean): string {
  const base =
    "You are an expert instructor for a home-study course on the Srimad Bhagavatam, a classical " +
    "Sanskrit Vaishnava scripture organized into Cantos. Write exactly one quiz question for " +
    "students reviewing the course material. Respond with a single strict JSON object only — no " +
    "markdown code fences, no commentary before or after it.";
  if (!grounded) {
    return `${base} Draw on your own knowledge of the Srimad Bhagavatam's content, stories, and teachings.`;
  }
  return (
    `${base} Base every claim in the question, answer, and explanation strictly on the course-note ` +
    "excerpt provided below. Treat it as your only source of truth: do not use outside knowledge of the " +
    "Srimad Bhagavatam, do not consult or rely on anything beyond this excerpt, and do not invent or infer " +
    "names, numbers, dates, or details that aren't explicitly written in it — even facts you are confident " +
    "are true of the Srimad Bhagavatam in general. If it is not written in the excerpt, it does not exist " +
    "for the purposes of this question."
  );
}

/**
 * Prompt layout is deliberate (see docs/self-hosted-llm.md): the per-slot
 * scoped passage comes first, then a block of instructions that is
 * byte-identical for every call of a given (grounded, type) shape, then —
 * last — everything that varies slot to slot (coverage label, focus topic,
 * difficulty writing instruction, avoid-list, JSON shape). Keeping all
 * per-call variation at the tail lets a repair retry (which re-sends this
 * exact first user message unchanged) and same-shape sibling slots reuse the
 * llama.cpp KV prefix instead of re-prefilling it.
 */
function buildUserPrompt(params: {
  topics: string[];
  focusTopic: string | null;
  coverageLabel: string;
  type: QuestionType;
  effectiveDifficulty: EffectiveDifficulty;
  avoidEntries: GeneratedQuestion[];
  sourceText: string;
}): string {
  const topicList = params.topics.length > 0 ? params.topics.join("; ") : params.coverageLabel;
  const grounded = params.sourceText.trim().length > 0;
  const lines: string[] = [];

  // --- Scoped source passage (per-slot) ---
  if (grounded) {
    lines.push(
      "Course-note excerpt (this is your ONLY source of truth — do not use outside knowledge, do not fill " +
        "gaps with plausible-sounding invented details, and do not draw on anything not explicitly written " +
        "here, even if you're confident it's true of the Srimad Bhagavatam in general):",
      '"""',
      params.sourceText.trim(),
      '"""',
      "Every name, fact, and number in your question, answer, and explanation must trace back to a specific " +
        "phrase in this excerpt.",
      ""
    );
  }

  // --- Fixed instruction block (identical for every call of this shape) ---
  lines.push(
    "Whatever the difficulty, the question must test something a student would have needed to actually " +
      "understand from the material — what someone did and the stated reason, the cause or outcome of an " +
      "event, the relationship between two named figures, or the point a passage is making. Do NOT build the " +
      "question around a bare number or count (e.g. how many cantos there are), the expansion of a numbering " +
      'code or abbreviation (e.g. what "1.2.23" stands for), a single term\'s definition, or which items belong ' +
      "to a list the source enumerates. This applies to true/false statements too — do not write one that just " +
      "asserts a count, or that just asserts an item is (or isn't) in such a list. And for multiple choice, do " +
      "not write a question where more than one of the four choices is a true statement from the source."
  );
  if (params.type === "multiple_choice") {
    lines.push(
      'Exactly 4 choices, only one correct, choices in a random order, and "answer" must match one of the choices character-for-character.',
      "Every choice must be short — 1 to 5 words, not a full sentence.",
      "The three wrong choices must be clearly and definitively wrong — not just different, less complete, " +
        "or other real facts from the same list. Avoid bare ordinal/sequence questions over a named list " +
        "(\"who is first/second in this lineage\", \"which came right after X\") when the other choices are " +
        "also genuine members of that same list — the only way to answer those is memorizing exact list " +
        "order, not reasoning about the material, even though the source technically supports one answer. " +
        "Prefer testing a relationship, distinguishing trait, or cause instead (e.g. who something originates " +
        "from, who directly did X, what makes one option different in kind from the others)."
    );
    if (grounded) {
      lines.push(
        "The correct answer must be a fact the excerpt clearly states or directly implies, worded closely to " +
          "the source. The three wrong choices should NOT be lifted from the excerpt; write those freely so " +
          "they're clearly wrong but plausible."
      );
    }
  }
  lines.push(
    "Also include \"core_fact\": a short (5-12 word) canonical, plainly-worded restatement of the one " +
      "specific fact or claim this question tests (e.g. \"Narada's reason for urging Vyasa to compose a " +
      "scripture\") — not a copy of the question or answer text, just a terse label for the underlying fact, " +
      "so it can be checked against the core_fact of already-used questions."
  );
  if (grounded) {
    lines.push(
      "Also include \"source_excerpt\": a short phrase or sentence (roughly 6-25 words) copied verbatim, " +
        "word-for-word, straight from the course-note excerpt above — the exact text that most directly " +
        "supports this question's answer. Quote a single contiguous run of text exactly as written there; do " +
        "not paraphrase or splice together separate sentences. This is what lets a host verify the question " +
        "against the source material later, so it must be real, checkable text, not a summary."
    );
  }

  // --- Per-call variable tail (everything that changes slot to slot) ---
  lines.push(
    "",
    `Course coverage: ${params.coverageLabel || topicList}.`,
    params.focusTopic
      ? `This question MUST test a specific fact from this topic: ${params.focusTopic}. Do not switch to a ` +
          `different topic because the excerpt happens to say more about another one — write the best question ` +
          `you can about this topic. (Full topic list for context: ${topicList}.)`
      : `Topics to draw from: ${topicList}.`,
    params.type === "multiple_choice"
      ? `Write ${DIFFICULTY_SPEC[params.effectiveDifficulty].writingInstruction}`
      : `Write ${DIFFICULTY_SPEC[params.effectiveDifficulty].writingInstruction}, phrased as a true/false statement.`
  );

  if (params.avoidEntries.length > 0) {
    const avoidFacts = params.avoidEntries
      .map((q) => q.coreFact.trim())
      .filter(Boolean)
      .slice(0, MAX_AVOID_ENTRIES_IN_PROMPT);
    if (avoidFacts.length > 0) {
      lines.push(
        "Do not test the same underlying fact, reuse the same correct answer, or reuse the same answer " +
          "choices (even reordered) as any already-used question. This course's material restates its " +
          "central themes in several different passages, so a question worded completely differently can " +
          "still be testing the same fact underneath — that is exactly what to avoid. Pick a different " +
          "specific detail or aspect, even within the same topic. Facts already used (by core_fact):",
        ...avoidFacts.map((fact) => `- ${fact}`)
      );
    }
  }

  lines.push("Return JSON matching exactly this shape:");
  const shapeTail = grounded ? ',"source_excerpt":"..."}' : "}";
  lines.push(
    params.type === "multiple_choice"
      ? '{"type":"multiple_choice","question":"...","choices":["...","...","...","..."],"answer":"<one of the four choices, verbatim>","explanation":"...","core_fact":"..."' +
          shapeTail
      : '{"type":"true_false","question":"...","answer":"True" or "False","explanation":"...","core_fact":"..."' + shapeTail
  );

  return lines.join("\n");
}

const MultipleChoiceDraftSchema = z
  .object({
    type: z.literal("multiple_choice"),
    question: z.string().trim().min(1),
    choices: z.array(z.string().trim().min(1)).length(4),
    answer: z.string().trim().min(1),
    explanation: z.string().trim().min(1),
    core_fact: z.string().trim().min(1),
    // Absent for ungrounded generation (no source text to quote from) —
    // only required/checked when grounded, see attemptDraft.
    source_excerpt: z.string().trim().min(1).optional(),
  })
  .refine((draft) => draft.choices.includes(draft.answer), {
    message: "answer must match one of the choices exactly",
  });

const TrueFalseDraftSchema = z.object({
  type: z.literal("true_false"),
  question: z.string().trim().min(1),
  answer: z.enum(["True", "False"]),
  explanation: z.string().trim().min(1),
  core_fact: z.string().trim().min(1),
  source_excerpt: z.string().trim().min(1).optional(),
});

function parseDraft(raw: string, type: QuestionType): GeneratedQuestion | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  if (type === "multiple_choice") {
    const result = MultipleChoiceDraftSchema.safeParse(json);
    if (!result.success) return null;
    return {
      id: nanoid(),
      type: "multiple_choice",
      question: result.data.question,
      choices: result.data.choices,
      answer: result.data.answer,
      explanation: result.data.explanation,
      coreFact: result.data.core_fact,
      sourceExcerpt: result.data.source_excerpt ?? null,
      // Placeholder — generateSlot overwrites this with the real
      // complexity-derived value once effectiveDifficulty is known.
      timeLimitSecs: DEFAULT_TIME_LIMIT_SECS,
    };
  }

  const result = TrueFalseDraftSchema.safeParse(json);
  if (!result.success) return null;
  return {
    id: nanoid(),
    type: "true_false",
    question: result.data.question,
    choices: ["True", "False"],
    answer: result.data.answer,
    explanation: result.data.explanation,
    coreFact: result.data.core_fact,
    sourceExcerpt: result.data.source_excerpt ?? null,
    timeLimitSecs: DEFAULT_TIME_LIMIT_SECS,
  };
}

// Word count is a simple, deterministic proxy for how long a question takes
// to read and answer — no extra model call, and nothing to validate the way
// a self-reported complexity score would need. Reading a four-choice MC
// question takes longer than a single true/false statement of the same
// length, and harder difficulty tiers get a little slack on top of that.
const SECS_PER_WORD = 1.1;
const DIFFICULTY_TIME_MULTIPLIER: Record<EffectiveDifficulty, number> = {
  beginner: 0.85,
  intermediate: 1,
  advanced: 1.15,
};

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Complexity-derived per-question countdown, clamped to the product's global time-limit bounds. */
function computeTimeLimitSecs(question: GeneratedQuestion, effectiveDifficulty: EffectiveDifficulty): number {
  const readableWords =
    wordCount(question.question) +
    (question.type === "multiple_choice" ? wordCount(question.choices.join(" ")) : 0);
  const raw = MIN_TIME_LIMIT_SECS + readableWords * SECS_PER_WORD * DIFFICULTY_TIME_MULTIPLIER[effectiveDifficulty];
  const rounded = Math.round(raw / 5) * 5;
  return Math.min(MAX_TIME_LIMIT_SECS, Math.max(MIN_TIME_LIMIT_SECS, rounded));
}

async function tryComplete(
  model: string,
  messages: ChatMessage[],
  callType: LlmCallType
): Promise<string | null> {
  try {
    return await completeChat(model, messages, callType);
  } catch {
    return null;
  }
}

// Per-slot grounding bounds (chars). A pinned slot gets its focus topic's
// passage plus enough sibling scope passages to clear the floor — a lone
// ~300-char passage is too thin to draw a good question from — while staying
// far below the ~110k chars a full "all weeks" corpus used to inline into
// every call. The unpinned relaxed top-up gets the union of the scope's
// passages up to a larger cap so it can range across the whole selection.
const MIN_FOCUS_SCOPE_CHARS = 2500;
const MAX_FOCUS_SCOPE_CHARS = 6000;
const MAX_UNION_SCOPE_CHARS = 16000;

/**
 * The exact grounding text one slot's draft/repair/judge calls all see.
 * `topicSourceText` maps each in-scope catalog topic to its hand-authored
 * passage (see courseCatalog.getTopicSourceText); `fullSourceText` is the
 * run-wide fallback for when that map is empty or has no entry for the
 * slot's focus topic. Everything downstream — isVerbatimInSource, the
 * source_excerpt check, judgeQuestion — is handed this same string, so
 * grounding is always checked against precisely what the model was shown.
 */
function resolveSlotSourceText(
  focusTopic: string | null,
  scopeTopics: string[],
  topicSourceText: Record<string, string>,
  fullSourceText: string
): string {
  if (Object.keys(topicSourceText).length === 0) return fullSourceText;

  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (topic: string) => {
    const passage = topicSourceText[topic]?.trim();
    if (passage && !seen.has(passage)) {
      seen.add(passage);
      ordered.push(passage);
    }
  };

  if (focusTopic) {
    add(focusTopic);
    if (ordered.length === 0) return fullSourceText; // focus topic isn't indexed
  }
  for (const topic of scopeTopics) add(topic);

  const cap = focusTopic ? MAX_FOCUS_SCOPE_CHARS : MAX_UNION_SCOPE_CHARS;
  const floor = focusTopic ? MIN_FOCUS_SCOPE_CHARS : Number.POSITIVE_INFINITY;
  let out = "";
  for (const passage of ordered) {
    if (out && out.length + 2 + passage.length > cap) break;
    out = out ? `${out}\n\n${passage}` : passage;
    if (out.length >= floor) break;
  }
  return out || fullSourceText;
}

type AttemptResult =
  | { ok: true; question: GeneratedQuestion }
  | { ok: false; reason: FailureReason; raw: string | null; duplicateOf?: string };

// Loose bound (not the strict 1-5) — a model occasionally sends "at least
// one, at most" as a whole clause; this only rejects choices that are
// clearly full sentences rather than short answer text.
const MAX_CHOICE_WORDS = 6;

function findOverLongChoice(choices: string[]): string | null {
  return choices.find((choice) => wordCount(choice) > MAX_CHOICE_WORDS) ?? null;
}

/** Loose containment check — normalizes whitespace/case only, so minor
 * punctuation differences don't false-positive a verbatim quote as a paraphrase. */
function isVerbatimInSource(answer: string, sourceText: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(sourceText).includes(normalize(answer));
}

async function attemptDraft(params: {
  model: string;
  judgeModel: string;
  messages: ChatMessage[];
  type: QuestionType;
  effectiveDifficulty: EffectiveDifficulty;
  sourceText: string;
  avoidEntries: GeneratedQuestion[];
  relax: RelaxLevel;
  callType: LlmCallType;
}): Promise<AttemptResult> {
  const raw = await tryComplete(params.model, params.messages, params.callType);
  if (!raw) return { ok: false, reason: "invalid_json", raw: null };

  const parsed = parseDraft(raw, params.type);
  if (!parsed) return { ok: false, reason: "invalid_json", raw };

  // The question/answer text itself is never required to be verbatim — a
  // true_false statement is often a paraphrase or a deliberately altered
  // fact, and a good multiple_choice answer about what someone did rarely
  // appears as a contiguous quote — but the `source_excerpt` the model cites
  // as backing it must be real, checkable text a host can find in the notes.
  // Fully relaxed, a bad/missing citation just gets dropped rather than
  // failing the whole draft.
  if (params.sourceText.trim()) {
    const excerptOk = !!parsed.sourceExcerpt && isVerbatimInSource(parsed.sourceExcerpt, params.sourceText);
    if (!excerptOk) {
      if (params.relax === "bare") parsed.sourceExcerpt = null;
      else return { ok: false, reason: "excerpt_not_verbatim", raw };
    }
  }

  if (parsed.type === "multiple_choice") {
    const overLong = findOverLongChoice(parsed.choices);
    if (overLong) return { ok: false, reason: "choice_too_long", raw };
  }

  // The correct answer no longer has to be a verbatim substring of the
  // source. That check was cheap but it quietly biased the whole generator
  // toward list/number/label facts (whose answers — "12", "1st Canto, 2nd
  // Chapter, 23rd Verse" — are trivially verbatim) and starved narrative
  // topics (a good answer about what someone *did* is rarely a contiguous
  // quote), which showed up as shallow quizzes that also under-filled the
  // requested count. Grounding is still enforced, by the faithfulness judge
  // below and by the verbatim `source_excerpt` citation checked above.

  const duplicate = findDuplicate(parsed, params.avoidEntries);
  if (duplicate) {
    return { ok: false, reason: "duplicate", raw, duplicateOf: duplicate.question };
  }

  // One combined LLM-judge call (faithfulness.ts's judgeQuestion) replaces
  // what used to be three separate round trips. Which axes it's actually
  // asked to gate on depends on the relax level (see RelaxLevel):
  //   bare  → no judge call at all (schema-valid + non-duplicate is the bar)
  //   all   → grounding only
  //   shape → grounding + difficulty tier
  //   none  → grounding + difficulty tier + single-defensible-answer
  //
  // The "local" backend never gates on difficulty or answerability: that's a
  // 4B model grading its own draft (primary == judge there), weak signal
  // whose flaky "fail" only costs a wasted repair round. Grounding still
  // runs, and the whole call still fails open (null verdict → keep the
  // draft) so a judge hiccup never silently drops a good question.
  if (params.relax === "bare") {
    return { ok: true, question: parsed };
  }

  const grounded = params.sourceText.trim().length > 0;
  const selfJudgeOnly = llmBackend() === "local";
  const gateDifficulty = !selfJudgeOnly && (params.relax === "none" || params.relax === "shape");
  const gateAnswerable = !selfJudgeOnly && params.relax === "none" && parsed.type === "multiple_choice";

  // Grounding short-circuit: if the model's cited source_excerpt is verbatim
  // in the passage (already checked above unless fully relaxed) AND the
  // marked answer itself appears verbatim there too, the question is
  // grounded by construction — skip the LLM grounding check. multiple_choice
  // only: a true_false answer ("True"/"False") is never a meaningful
  // verbatim hit, and its statement is often a deliberate paraphrase worth
  // judging.
  const groundingShortCircuit =
    grounded &&
    parsed.type === "multiple_choice" &&
    !!parsed.sourceExcerpt &&
    isVerbatimInSource(parsed.sourceExcerpt, params.sourceText) &&
    isVerbatimInSource(parsed.answer, params.sourceText);
  const gateFaithful = grounded && !groundingShortCircuit;

  if (!gateFaithful && !gateDifficulty && !gateAnswerable) {
    return { ok: true, question: parsed };
  }

  const verdict = await judgeQuestion({
    question: parsed.question,
    type: parsed.type,
    choices: parsed.choices,
    answer: parsed.answer,
    explanation: parsed.explanation,
    sourceText: params.sourceText,
    judgeModel: params.judgeModel,
    askFaithful: gateFaithful,
    askAnswerable: gateAnswerable,
    difficultyCriteria: gateDifficulty ? DIFFICULTY_SPEC[params.effectiveDifficulty].judgeCriteria : null,
  });

  if (verdict) {
    if (gateDifficulty && verdict.difficultyMatch === false) {
      return { ok: false, reason: "difficulty_mismatch", raw };
    }
    if (gateFaithful && verdict.faithful === false) {
      return { ok: false, reason: "low_faithfulness", raw };
    }
    if (gateAnswerable && verdict.answerable === false) {
      return { ok: false, reason: "ambiguous", raw };
    }
  }

  return { ok: true, question: parsed };
}

function repairPrompt(reason: FailureReason, raw: string, effectiveDifficulty: EffectiveDifficulty, duplicateOf?: string): string {
  if (reason === "invalid_json") {
    return (
      `That response was not valid JSON matching the requested shape. Here is what you sent:\n${raw}\n\n` +
      "Respond again with ONLY a corrected JSON object matching the shape above."
    );
  }
  if (reason === "duplicate") {
    return (
      `Here is what you sent:\n${raw}\n\n` +
      `That overlaps too much with an already-used question${duplicateOf ? ` ("${duplicateOf}")` : ""} — the ` +
      "same underlying fact, the same correct answer, nearly the same answer choices, or the same core_fact " +
      "as one already used, even though the wording differs. Pick a different specific detail, term, or angle " +
      "instead — it can be the same general topic, but must test a genuinely different fact, with a different " +
      "core_fact to match. Respond again with ONLY the corrected JSON object."
    );
  }
  if (reason === "ambiguous") {
    return (
      `Here is what you sent:\n${raw}\n\n` +
      "The marked answer is true, but more than one of the choices is a genuinely defensible answer to the " +
      "question as worded — a student can't reason their way to the single correct choice from the question " +
      "text alone, only by already knowing the answer. Reword the question to pin down exactly which fact, " +
      "position, or relationship you're asking about (e.g. name a specific step, role, or comparison) so only " +
      "one choice fits, or write different choices that are clearly wrong rather than other real facts from " +
      "the same list. Respond again with ONLY the corrected JSON object."
    );
  }
  if (reason === "choice_too_long") {
    return (
      `Here is what you sent:\n${raw}\n\n` +
      "One or more of the choices is too long — every choice must be 1 to 5 words, not a full sentence. " +
      "Shorten each choice to a short phrase or name while keeping the same meaning. Respond again with ONLY " +
      "the corrected JSON object."
    );
  }
  if (reason === "excerpt_not_verbatim") {
    return (
      `Here is what you sent:\n${raw}\n\n` +
      "The \"source_excerpt\" field is missing, or doesn't appear verbatim in the course-note excerpt above — " +
      "it looks paraphrased, shortened, or spliced together from separate sentences. Copy a single contiguous " +
      "phrase or sentence exactly as written in the excerpt, character-for-character. Respond again with ONLY " +
      "the corrected JSON object."
    );
  }
  if (reason === "difficulty_mismatch") {
    return (
      `Here is what you sent:\n${raw}\n\n` +
      `That question doesn't actually match its assigned "${effectiveDifficulty}" difficulty tier. Write ` +
      `${DIFFICULTY_SPEC[effectiveDifficulty].writingInstruction} Respond again with ONLY the corrected JSON ` +
      "object."
    );
  }
  return (
    `Here is what you sent:\n${raw}\n\n` +
    "That question, answer, or explanation wasn't clearly supported by the course-note excerpt above — " +
    "it may be relying on outside knowledge instead of what's actually written there. Revise it so every " +
    "claim is directly grounded in the excerpt. Respond again with ONLY the corrected JSON object."
  );
}

async function generateSlot(params: {
  type: QuestionType;
  topics: string[];
  focusTopic: string | null;
  coverageLabel: string;
  difficulty: Difficulty;
  avoidEntries: GeneratedQuestion[];
  sourceText: string;
  topicSourceText: Record<string, string>;
  primaryModel: string;
  fallbackModel: string;
  relax: RelaxLevel;
  /** "draft" for the first fill round, "repair" for later rounds and the
   *  top-up — observability only (see llmTelemetry.ts). */
  callType: LlmCallType;
}): Promise<GeneratedQuestion | null> {
  const type = params.type;
  const effectiveDifficulty = pickEffectiveDifficulty(params.difficulty);
  // Every call for this slot — draft, repair, and the judge — is grounded in
  // this one string, so grounding is always checked against exactly what the
  // model saw.
  const slotSourceText = resolveSlotSourceText(
    params.focusTopic,
    params.topics,
    params.topicSourceText,
    params.sourceText
  );
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(slotSourceText.trim().length > 0) },
    {
      role: "user",
      content: buildUserPrompt({
        topics: params.topics,
        focusTopic: params.focusTopic,
        coverageLabel: params.coverageLabel,
        type,
        effectiveDifficulty,
        avoidEntries: params.avoidEntries,
        sourceText: slotSourceText,
      }),
    },
  ];

  const first = await attemptDraft({
    model: params.primaryModel,
    judgeModel: params.fallbackModel,
    messages,
    type,
    effectiveDifficulty,
    sourceText: slotSourceText,
    avoidEntries: params.avoidEntries,
    relax: params.relax,
    callType: params.callType,
  });
  if (first.ok) return withTimeLimit(first.question, effectiveDifficulty);

  if (first.raw) {
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: repairPrompt(first.reason, first.raw, effectiveDifficulty, first.duplicateOf) },
    ];
    const second = await attemptDraft({
      model: params.primaryModel,
      judgeModel: params.fallbackModel,
      messages: repairMessages,
      type,
      effectiveDifficulty,
      sourceText: slotSourceText,
      avoidEntries: params.avoidEntries,
      relax: params.relax,
      callType: "repair",
    });
    if (second.ok) return withTimeLimit(second.question, effectiveDifficulty);
  }

  // Stop after the one repair retry when there's no genuinely different
  // model to escalate to (LLM_BACKEND=local: primaryModel == fallbackModel,
  // so a third attempt is just another identical sample for one more slow
  // call) or for relaxed top-up slots (a whole extra round trip per
  // still-failing slot is what makes a large top-up drag). Only the
  // "openrouter" backend, with a real second model, runs the third attempt.
  if (params.relax !== "none" || params.primaryModel === params.fallbackModel) return null;

  const third = await attemptDraft({
    model: params.fallbackModel,
    judgeModel: params.primaryModel,
    messages,
    type,
    effectiveDifficulty,
    sourceText: slotSourceText,
    avoidEntries: params.avoidEntries,
    relax: params.relax,
    callType: "repair",
  });
  return third.ok ? withTimeLimit(third.question, effectiveDifficulty) : null;
}

function withTimeLimit(question: GeneratedQuestion, effectiveDifficulty: EffectiveDifficulty): GeneratedQuestion {
  return { ...question, timeLimitSecs: computeTimeLimitSecs(question, effectiveDifficulty) };
}

// In the default "local" backend one model on the self-hosted box drafts
// AND grades every question — primary == fallback == the faithfulness,
// answerable and difficulty-match judges. Self-grading is more lenient than
// an independent judge; it's an accepted limitation of running fully local
// with a single 4B model (there is no second model on the endpoint). Logged
// once per process so the trade-off is visible in Cloud Run logs without
// spamming a line per generation.
let localSelfJudgeLogged = false;
function logLocalSelfJudgeOnce(model: string): void {
  if (localSelfJudgeLogged) return;
  localSelfJudgeLogged = true;
  console.warn(
    `[localQuizGenerator] LLM_BACKEND=local: "${model}" on the self-hosted endpoint drafts and grades every ` +
      `question (primary == fallback == all judges). Self-grading runs more lenient than an independent judge.`
  );
}

export async function generateQuiz(params: {
  topics: string[];
  sourceText: string;
  /** Per-topic scoped grounding passages (catalog topic → excerpt), from
   * courseCatalog.getTopicSourceText. When present, each slot is grounded in
   * just its focus topic's passage(s) instead of `sourceText` — the single
   * biggest latency lever on the self-hosted backend (see
   * docs/self-hosted-llm.md). Absent/empty falls back to `sourceText` for
   * every slot, i.e. the pre-scoping behaviour. */
  topicSourceText?: Record<string, string>;
  questionCount: number;
  difficulty: Difficulty;
  coverageLabel: string;
  onProgress?: (progress: GenerationProgress) => void;
  /** Questions from prior quizzes on this material — seeds findDuplicate's
   * avoid-list beyond just this run's own in-batch questions. */
  existingQuestions?: GeneratedQuestion[];
}): Promise<GeneratedQuiz> {
  const { primaryModel, fallbackModel } = generationModels();
  const { concurrency, topupConcurrency } = generationConcurrency();
  if (llmBackend() === "local") logLocalSelfJudgeOnce(primaryModel);
  const sourceText = clampSourceText(params.sourceText);
  const topicSourceText = params.topicSourceText ?? {};
  const existingQuestions = params.existingQuestions ?? [];

  beginRun();
  const logRunSummary = () => {
    const s = endRun();
    console.log(
      `[localQuizGenerator] generation summary: ${(s.wallMs / 1000).toFixed(1)}s wall, ${s.callCount} LLM ` +
        `calls (${s.callsByType.draft} draft / ${s.callsByType.repair} repair / ${s.callsByType.judge} judge), ` +
        `${s.totalPromptTokens} prompt + ${s.totalCompletionTokens} completion tokens` +
        `${s.tokensPartlyEstimated ? " (some estimated)" : ""}, median draft/repair prompt ` +
        `${s.medianGenerationPromptTokens} tokens`
    );
  };

  // Round-robin a shuffled topic order across slots (rather than handing
  // every call the same full topic list) so questions spread across the
  // material instead of the model gravitating to the same one or two facts
  // repeatedly, especially for short true/false statements. Offsetting by
  // `round` shifts a retried slot onto a *different* topic each round
  // instead of retrying the same one — a slot whose assigned topic has run
  // out of fresh, non-duplicate facts (easy to hit on a small course week
  // once a few quizzes' worth of questions on it already exist) would
  // otherwise retry that same exhausted topic every round and never fill.
  const shuffledTopics = [...params.topics].sort(() => Math.random() - 0.5);
  const focusTopicFor = (slotIndex: number, round: number): string | null =>
    shuffledTopics.length > 0 ? shuffledTopics[(slotIndex + round) % shuffledTopics.length] : null;

  // Assigned once per slot up front (not re-rolled on retry) so the quiz's
  // overall true/false-vs-multiple_choice mix stays exactly on target no
  // matter how many rounds a slot needs before it fills — see
  // assignQuestionTypes.
  const slotTypes = assignQuestionTypes(params.questionCount);

  const slots: (GeneratedQuestion | null)[] = new Array(params.questionCount).fill(null);
  let completedCount = 0;

  async function runPass(indices: number[], phase: GenerationProgress["phase"], round: number) {
    let cursor = 0;
    async function worker() {
      while (cursor < indices.length) {
        const slotIndex = indices[cursor++];
        const avoidEntries = [
          ...existingQuestions,
          ...slots.filter((q): q is GeneratedQuestion => q !== null),
        ];
        slots[slotIndex] = await generateSlot({
          type: slotTypes[slotIndex],
          topics: params.topics,
          focusTopic: focusTopicFor(slotIndex, round),
          coverageLabel: params.coverageLabel,
          difficulty: params.difficulty,
          avoidEntries,
          sourceText,
          topicSourceText,
          primaryModel,
          fallbackModel,
          relax: "none",
          callType: round === 0 ? "draft" : "repair",
        });
        completedCount++;
        params.onProgress?.({ phase, completed: completedCount, total: params.questionCount });
      }
    }
    const workerCount = Math.min(concurrency, indices.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  // At least one round per topic, so a stuck slot's rotation (above) gets a
  // shot at every topic before this gives up on it, not just whichever
  // number of topics the flat MAX_FILL_ROUNDS floor happens to cover —
  // capped at MAX_ROUNDS_CEILING so a broad topic selection can't push
  // worst-case latency arbitrarily high (see that constant's comment).
  const maxRounds = Math.min(Math.max(MAX_FILL_ROUNDS, shuffledTopics.length), MAX_ROUNDS_CEILING);
  // A slot's assigned type is fixed for its first couple of rounds so the
  // requested true/false ratio holds in the common case, but a slot that's
  // still empty after that gets its type flipped (once) rather than kept
  // fighting for a type the source material for its topic may not actually
  // support well — hitting the requested *question count* takes priority
  // over hitting the exact ratio for one stuck slot. Without this, a whole
  // quiz could come back short by exactly its true/false quota if every
  // true/false slot happened to land on thin material.
  const TYPE_FLIP_AFTER_ROUNDS = 2;
  const flippedSlots = new Set<number>();
  let indicesToFill = slots.map((_, i) => i);
  for (let round = 0; indicesToFill.length > 0 && round < maxRounds; round++) {
    if (round >= TYPE_FLIP_AFTER_ROUNDS) {
      for (const index of indicesToFill) {
        if (flippedSlots.has(index)) continue;
        slotTypes[index] = slotTypes[index] === "true_false" ? "multiple_choice" : "true_false";
        flippedSlots.add(index);
      }
    }
    completedCount = params.questionCount - indicesToFill.length;
    await runPass(indicesToFill, round === 0 ? "draft" : "repairing", round);

    // Bounded concurrency means two slots can each pass their own duplicate
    // check against the same not-yet-updated snapshot before either result
    // is recorded, letting a duplicate through the per-slot ladder inside
    // generateSlot. Sweep the finished slots in order and null out any
    // later one that duplicates an earlier one, now against the complete
    // set, so it gets picked up by the next round's fill pass.
    const acceptedSoFar: GeneratedQuestion[] = [...existingQuestions];
    const duplicateIndices: number[] = [];
    slots.forEach((question, index) => {
      if (!question) return;
      if (findDuplicate(question, acceptedSoFar)) {
        duplicateIndices.push(index);
      } else {
        acceptedSoFar.push(question);
      }
    });
    for (const index of duplicateIndices) slots[index] = null;

    indicesToFill = slots.reduce<number[]>((acc, q, i) => (q === null ? [...acc, i] : acc), []);
  }

  const questions = slots.filter((q): q is GeneratedQuestion => q !== null);
  if (questions.length === 0) {
    logRunSummary();
    throw new QuizGenerationError("The generator could not produce any usable questions. Try again.");
  }

  // Guarantee the exact requested count. If the quality-first rounds left a
  // slot or two unfilled (a topic that just doesn't hold enough substantive
  // material for its assigned type, made more likely by the strict trivia
  // bar), top up the shortfall here rather than handing back a short quiz.
  // Acceptance is relaxed one step at a time (see RelaxLevel): "shape", then
  // "all", then "bare" — each only reached if the previous still came up
  // short. The focus topic is unpinned so these draw from the whole scope
  // instead of retrying the thin topic that stalled, and the generation
  // prompt is unchanged, so a topped-up question is still real and on-topic.
  // Duplicates are rejected at every level.
  const topUpDeadline = Date.now() + TOPUP_DEADLINE_MS;
  async function topUp(relax: RelaxLevel): Promise<void> {
    for (
      let round = 0;
      round < MAX_TOPUP_ROUNDS_PER_LEVEL && questions.length < params.questionCount && Date.now() < topUpDeadline;
      round++
    ) {
      const need = params.questionCount - questions.length;
      // Bounded worker pool (TOPUP_CONCURRENCY), not one promise per missing
      // slot — a 15-short round otherwise fans out to dozens of concurrent
      // generateSlot calls on top of the main fill's own load.
      const drafted: (GeneratedQuestion | null)[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < need && Date.now() < topUpDeadline) {
          const i = cursor++;
          drafted.push(
            await generateSlot({
              type: (questions.length + i) % 5 === 4 ? "true_false" : "multiple_choice",
              topics: params.topics,
              focusTopic: null,
              coverageLabel: params.coverageLabel,
              difficulty: params.difficulty,
              avoidEntries: [...existingQuestions, ...questions],
              sourceText,
              topicSourceText,
              primaryModel,
              fallbackModel,
              relax,
              callType: "repair",
            })
          );
        }
      };
      await Promise.all(Array.from({ length: Math.min(topupConcurrency, need) }, worker));

      for (const q of drafted) {
        if (questions.length >= params.questionCount) break;
        if (q && !findDuplicate(q, [...existingQuestions, ...questions])) {
          questions.push(q);
          params.onProgress?.({ phase: "repairing", completed: questions.length, total: params.questionCount });
        }
      }
    }
  }
  if (questions.length < params.questionCount) await topUp("shape");
  if (questions.length < params.questionCount) await topUp("all");
  if (questions.length < params.questionCount) await topUp("bare");
  questions.length = Math.min(questions.length, params.questionCount);

  const title = params.coverageLabel ? `${params.coverageLabel} Quiz` : "Bhagavatam Quiz";
  const description =
    params.topics.length > 0
      ? `Covering ${params.topics.slice(0, 3).join(", ")}${params.topics.length > 3 ? ", and more" : ""}.`
      : "";

  logRunSummary();
  return { title, description, questions };
}
