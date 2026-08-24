import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

const completeChatMock = vi.fn();
const scoreFaithfulnessMock = vi.fn();

vi.mock("@/lib/openrouter", () => ({
  completeChat: (...args: [string, ChatMessage[]]) => completeChatMock(...args),
  OpenRouterError: class OpenRouterError extends Error {},
}));

vi.mock("@/lib/faithfulness", () => ({
  scoreFaithfulness: (...args: [string, string, string]) => scoreFaithfulnessMock(...args),
}));

function requestedType(messages: ChatMessage[]): "multiple_choice" | "true_false" {
  const userContent = messages.find((m) => m.role === "user")?.content ?? "";
  return userContent.includes('"type":"true_false"') ? "true_false" : "multiple_choice";
}

// checkAnswerable() reuses completeChat (same mock as drafting calls) rather
// than a separate module like faithfulness, so tests distinguish it by the
// one phrase only its own prompt contains.
function isAnswerabilityCheck(messages: ChatMessage[]): boolean {
  return (messages.find((m) => m.role === "user")?.content ?? "").includes("Marked correct answer:");
}

// Same pattern as isAnswerabilityCheck — checkDifficultyMatch() also reuses
// completeChat, distinguished by the one phrase only its own prompt contains.
function isDifficultyCheck(messages: ChatMessage[]): boolean {
  return (messages.find((m) => m.role === "user")?.content ?? "").includes("Target difficulty tier:");
}

// Each call cycles through genuinely distinct facts (not just a numeric
// suffix — normalizeWords drops words of length <= 3, including bare
// digits, so e.g. "chapter 1" vs "chapter 2" would normalize to identical
// word sets and falsely trip duplicate detection) so tests that aren't
// about duplicate detection don't accidentally trigger it.
const MULTIPLE_CHOICE_FACTS = [
  { question: "Who narrates the Bhagavatam to Pariksit?", choices: ["Sukadeva Goswami", "Vyasa", "Narada", "Suta"], answer: "Sukadeva Goswami", core_fact: "narrator of the Bhagavatam to Pariksit" },
  { question: "Which sage compiled the Vedas into four divisions?", choices: ["Vyasa", "Valmiki", "Narada", "Suta"], answer: "Vyasa", core_fact: "who compiled the Vedas into four divisions" },
  { question: "Who is described as the son of Vyasa in the Bhagavatam?", choices: ["Sukadeva", "Arjuna", "Yudhishthira", "Bhima"], answer: "Sukadeva", core_fact: "identity of Vyasa's son" },
  { question: "Which king heard the Bhagavatam before his death?", choices: ["Pariksit", "Yudhishthira", "Dhritarashtra", "Duryodhana"], answer: "Pariksit", core_fact: "which king heard the Bhagavatam before dying" },
  { question: "Whose curse led to Pariksit's seven-day deadline?", choices: ["Shringi", "Shukadeva", "Vyasa", "Narada"], answer: "Shringi", core_fact: "who cursed Pariksit with the seven-day deadline" },
];
const TRUE_FALSE_FACTS = [
  "Krishna appears within the events narrated in the Bhagavatam's tenth canto.",
  "The Srimad Bhagavatam is traditionally divided into twelve cantos.",
  "Vyasa is credited with compiling the Mahabharata.",
  "Pariksit was cursed by the son of a brahmana sage.",
  "Sukadeva Goswami is described as a renunciate from birth.",
];
const TRUE_FALSE_CORE_FACTS = [
  "Krishna's presence in the tenth canto",
  "number of cantos in the Bhagavatam",
  "Vyasa compiling the Mahabharata",
  "who cursed Pariksit",
  "Sukadeva Goswami's renunciate nature from birth",
];
let draftCounter = 0;
function validDraftFor(messages: ChatMessage[]): string {
  // checkAnswerable() also goes through completeChat — default it to a
  // benign pass so tests that aren't specifically about answerability don't
  // need to think about it, and (just as importantly) so it doesn't consume
  // a draftCounter tick and throw off which fact each real draft call gets.
  if (isAnswerabilityCheck(messages)) {
    return JSON.stringify({ answerable: true, reason: "fine" });
  }
  if (isDifficultyCheck(messages)) {
    return JSON.stringify({ matches: true, reason: "fine" });
  }
  const index = draftCounter++ % MULTIPLE_CHOICE_FACTS.length;
  // Verbatim within the one grounded sourceText any of these tests use (see
  // the faithfulness-check tests below) — harmless filler for every other
  // test here, which passes sourceText: "" and so never checks this field.
  const sourceExcerpt = "Sukadeva Goswami, Vyasa, Sukadeva, Pariksit, and Shringi";
  if (requestedType(messages) === "true_false") {
    return JSON.stringify({
      type: "true_false",
      question: TRUE_FALSE_FACTS[index],
      answer: "True",
      explanation: "Because.",
      core_fact: TRUE_FALSE_CORE_FACTS[index],
      source_excerpt: sourceExcerpt,
    });
  }
  return JSON.stringify({
    type: "multiple_choice",
    ...MULTIPLE_CHOICE_FACTS[index],
    explanation: "Because.",
    source_excerpt: sourceExcerpt,
  });
}

describe("generateQuiz", () => {
  const originalFallback = process.env.OPENROUTER_MODEL_FALLBACK;

  beforeEach(() => {
    draftCounter = 0;
    // Default: faithfulness check passes (or is skipped, same as an empty
    // sourceText would do for real) so tests that aren't about grounding
    // don't need to think about it.
    scoreFaithfulnessMock.mockImplementation(async () => null);
  });

  afterEach(() => {
    completeChatMock.mockReset();
    scoreFaithfulnessMock.mockReset();
    if (originalFallback === undefined) delete process.env.OPENROUTER_MODEL_FALLBACK;
    else process.env.OPENROUTER_MODEL_FALLBACK = originalFallback;
  });

  it("generates exactly questionCount questions when every model call succeeds", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 5,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(5);
    for (const question of quiz.questions) {
      if (question.type === "true_false") {
        expect(question.choices).toEqual(["True", "False"]);
      } else {
        expect(question.choices).toContain(question.answer);
      }
    }
  });

  it("reports draft progress up to the full total when nothing needs repairing", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));
    const { generateQuiz } = await import("@/lib/localQuizGenerator");

    const progressEvents: { phase: string; completed: number; total: number }[] = [];
    await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 3,
      difficulty: "mixed",
      coverageLabel: "Week 1",
      onProgress: (p) => progressEvents.push(p),
    });

    expect(progressEvents).toHaveLength(3);
    expect(progressEvents.every((p) => p.phase === "draft" && p.total === 3)).toBe(true);
    expect(progressEvents[progressEvents.length - 1].completed).toBe(3);
  });

  it("falls back to the second model and still succeeds when the primary model never returns valid JSON", async () => {
    process.env.OPENROUTER_MODEL_FALLBACK = "fallback/model";
    completeChatMock.mockImplementation(async (model: string, messages: ChatMessage[]) => {
      if (model === "fallback/model") return validDraftFor(messages);
      return "not valid json";
    });

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 3,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(3);
    const fallbackCalls = completeChatMock.mock.calls.filter(([model]) => model === "fallback/model");
    expect(fallbackCalls.length).toBeGreaterThan(0);
  });

  it("throws QuizGenerationError when every model call returns invalid JSON", async () => {
    completeChatMock.mockImplementation(async () => "not valid json");

    const { generateQuiz, QuizGenerationError } = await import("@/lib/localQuizGenerator");
    await expect(
      generateQuiz({
        topics: ["Sanatana Dharma"],
        sourceText: "",
        questionCount: 2,
        difficulty: "mixed",
        coverageLabel: "Week 1",
      })
    ).rejects.toThrow(QuizGenerationError);
  });

  it("rejects a malformed first draft (bad answer/choices) and recovers via the repair retry", async () => {
    let calls = 0;
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      calls++;
      if (calls === 1) {
        return requestedType(messages) === "multiple_choice"
          ? JSON.stringify({
              type: "multiple_choice",
              question: "Bad draft",
              choices: ["A", "B", "C", "D"],
              answer: "Not one of the choices",
              explanation: "E",
              core_fact: "bad draft",
            })
          : JSON.stringify({ type: "true_false", question: "Bad draft", answer: "Maybe", explanation: "E", core_fact: "bad draft" });
      }
      return validDraftFor(messages);
    });

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 1,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0].choices).toContain(quiz.questions[0].answer);
  });

  it("retries a schema-valid draft that fails the faithfulness check, and keeps it once faithfulness passes", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));
    scoreFaithfulnessMock
      .mockImplementationOnce(async () => 0.2) // first attempt: not grounded
      .mockImplementation(async () => 0.95); // repair retry: grounded

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      // Contains every MULTIPLE_CHOICE_FACTS answer verbatim so these
      // faithfulness-focused tests don't also trip the (unrelated)
      // verbatim-correct-answer check on whichever slot type gets drawn.
      sourceText: "Some course-note excerpt about Sukadeva Goswami, Vyasa, Sukadeva, Pariksit, and Shringi.",
      questionCount: 1,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(scoreFaithfulnessMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("drops a slot whose drafts never pass the faithfulness check", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));
    scoreFaithfulnessMock.mockImplementation(async () => 0.1);

    const { generateQuiz, QuizGenerationError } = await import("@/lib/localQuizGenerator");
    await expect(
      generateQuiz({
        topics: ["Sanatana Dharma"],
        // Contains every MULTIPLE_CHOICE_FACTS answer verbatim so these
      // faithfulness-focused tests don't also trip the (unrelated)
      // verbatim-correct-answer check on whichever slot type gets drawn.
      sourceText: "Some course-note excerpt about Sukadeva Goswami, Vyasa, Sukadeva, Pariksit, and Shringi.",
        questionCount: 1,
        difficulty: "mixed",
        coverageLabel: "Week 1",
      })
    ).rejects.toThrow(QuizGenerationError);
  });

  it("never keeps two questions that are exact repeats of each other", async () => {
    // Every call returns the exact same multiple_choice content — with two
    // slots running concurrently, both can pass their own duplicate check
    // before either result is recorded (the scenario the final sweep pass
    // exists to catch), and every regeneration attempt is just as
    // duplicate, so the second slot should end up dropped rather than kept.
    completeChatMock.mockImplementation(async () =>
      JSON.stringify({
        type: "multiple_choice",
        question: "What is the main subject that Srimad Bhagavatam directs us towards?",
        choices: ["Mukti", "Ashraya", "Sarga", "Poshanam"],
        answer: "Ashraya",
        explanation: "Because.",
        core_fact: "Ashraya as the subject Bhagavatam directs us towards",
      })
    );

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 2,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
  });

  it("rejects a reworded question that reuses the same answer and mostly the same choices", async () => {
    // Reproduces the reported bug: differently-worded questions that both
    // resolve to the same answer with 3 of 4 choices in common (only their
    // wording differs, e.g. "main subject Bhagavatam directs us towards"
    // vs. "main subject (lakshana) of Canto 10") should be caught even
    // though plain question-text similarity wouldn't flag them.
    let call = 0;
    completeChatMock.mockImplementation(async () => {
      call++;
      // Deliberately different core_fact wording on each branch too, so this
      // test still proves the pre-existing answer/choice-overlap check
      // catches this case on its own, independent of the new core_fact check.
      return call % 2 === 1
        ? JSON.stringify({
            type: "multiple_choice",
            question: "What is the main subject that Srimad Bhagavatam directs us towards?",
            choices: ["Mukti", "Ashraya", "Sarga", "Poshanam"],
            answer: "Ashraya",
            explanation: "Because.",
            core_fact: "the subject Bhagavatam directs listeners towards",
          })
        : JSON.stringify({
            type: "multiple_choice",
            question: "What is the main subject (lakshana) of Canto 10 in Srimad Bhagavatam?",
            choices: ["Ashraya", "Sarga", "Visarga", "Mukti"],
            answer: "Ashraya",
            explanation: "Because.",
            core_fact: "Canto 10's defining lakshana",
          });
    });

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 2,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
  });

  it("rejects two questions with unrelated wording and answers that both test the same core_fact", async () => {
    // Reproduces the live bug this was added for: a course whose material
    // restates its central theme ("the point is to inspire devotion") in
    // several passages can produce two questions with different question
    // text, different explanations, and non-matching answers/choices that
    // still both just test that same restated theme. Only the core_fact
    // overlap check (not question-text, explanation, or answer/choice
    // overlap — all deliberately kept low here) should catch this pair.
    let call = 0;
    completeChatMock.mockImplementation(async () => {
      call++;
      return call % 2 === 1
        ? JSON.stringify({
            type: "multiple_choice",
            question: "What prompted Sage Narada to encourage Sage Vyasa to compose a scripture describing the glories and leelas of Bhagavan?",
            choices: [
              "Historical accounts of ancient kings",
              "Vyasa's personal recognition and fame",
              "Inspire devotion in listeners' hearts",
              "Philosophical principles without narrative",
            ],
            answer: "Inspire devotion in listeners' hearts",
            explanation: "The passage says Narada shared his own past-life story to move Vyasa toward composing a devotional work.",
            core_fact: "Narada's reason for urging Vyasa to compose a scripture about Bhagavan",
          })
        : JSON.stringify({
            type: "multiple_choice",
            question: "What did Sage Narada suggest as the primary purpose of composing a scripture during his conversation with Sage Vyasa?",
            choices: [
              "Detailed genealogies of ancient kings",
              "Instill devotion to Bhagavan",
              "A guide for performing rituals",
              "Document the historical events",
            ],
            answer: "Instill devotion to Bhagavan",
            explanation: "According to the text, Narada's aim was for the scripture to awaken love for the Lord in its readers.",
            core_fact: "Narada's stated reason for encouraging Vyasa to compose a scripture",
          });
    });

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 2,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
  });

  it("rejects an ambiguous multiple_choice draft and recovers once the answerability check passes", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0); // forces multiple_choice every time
    let answerabilityCalls = 0;
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      if (isAnswerabilityCheck(messages)) {
        answerabilityCalls++;
        return JSON.stringify({ answerable: answerabilityCalls > 1, reason: "test" });
      }
      return validDraftFor(messages);
    });

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 1,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0].type).toBe("multiple_choice");
    expect(answerabilityCalls).toBeGreaterThan(1);
    randomSpy.mockRestore();
  });

  it("drops a slot whose answerability check never passes, even after its type flips to escape a stuck quota", async () => {
    // questionCount: 1 is always assigned multiple_choice up front (see
    // assignQuestionTypes), but a slot stuck failing for a couple of rounds
    // gets its type flipped once as a last resort (see TYPE_FLIP_AFTER_ROUNDS
    // in generateQuiz) so the requested question *count* doesn't get
    // sacrificed to a type quota the material can't fill. This forces the
    // flipped-to true_false attempt to fail too (invalid JSON), so the test
    // still proves a genuinely unfillable slot gets dropped rather than the
    // flip being an unconditional escape hatch.
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      if (isAnswerabilityCheck(messages)) {
        return JSON.stringify({ answerable: false, reason: "always ambiguous" });
      }
      if (requestedType(messages) === "true_false") {
        return "not valid json";
      }
      return validDraftFor(messages);
    });

    const { generateQuiz, QuizGenerationError } = await import("@/lib/localQuizGenerator");
    await expect(
      generateQuiz({
        topics: ["Sanatana Dharma"],
        sourceText: "",
        questionCount: 1,
        difficulty: "mixed",
        coverageLabel: "Week 1",
      })
    ).rejects.toThrow(QuizGenerationError);
  });

  it("flips a stuck slot's type after enough failed rounds so the requested question count is still met", async () => {
    // Simulates a slot whose assigned type (multiple_choice, per
    // assignQuestionTypes for questionCount: 1) can never pass — here because
    // the answerability judge always rejects it — while the *other* type
    // succeeds immediately. Without the type-flip fallback this slot would
    // be dropped and the quiz would come back short of the requested count.
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      if (isAnswerabilityCheck(messages)) {
        return JSON.stringify({ answerable: false, reason: "always ambiguous" });
      }
      return validDraftFor(messages);
    });

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 1,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0].type).toBe("true_false");
  });

  it("drops a slot whose every draft duplicates an existingQuestions entry passed in by the caller", async () => {
    // existingQuestions represents prior quizzes' history (Phase 5:
    // generation dedup) — findDuplicate checks the merged in-batch +
    // existingQuestions list, so a draft that only duplicates something
    // from existingQuestions (never generated in this run) should still be
    // caught on every attempt and the slot dropped.
    // questionCount: 1 is always assigned multiple_choice (see
    // assignQuestionTypes — a 1-question quiz rounds its true_false quota
    // down to 0), so the mocked draft and existingQuestions entry below are
    // both multiple_choice to actually exercise the duplicate path rather
    // than accidentally failing on a type mismatch instead.
    completeChatMock.mockImplementation(async () =>
      JSON.stringify({
        type: "multiple_choice",
        question: "Who does Krishna appear as in Canto 1?",
        choices: ["Himself", "Vyasa", "Narada", "Suta"],
        answer: "Himself",
        explanation: "Because.",
        core_fact: "Krishna's appearance in Canto 1",
      })
    );

    const { generateQuiz, QuizGenerationError } = await import("@/lib/localQuizGenerator");
    await expect(
      generateQuiz({
        topics: ["Sanatana Dharma"],
        sourceText: "",
        questionCount: 1,
        difficulty: "mixed",
        coverageLabel: "Week 1",
        existingQuestions: [
          {
            id: "existing-1",
            type: "multiple_choice",
            question: "Who does Krishna appear as in Canto 1?",
            choices: ["Himself", "Vyasa", "Narada", "Suta"],
            answer: "Himself",
            explanation: "",
            coreFact: "",
            sourceExcerpt: null,
            timeLimitSecs: 20,
          },
        ],
      })
    ).rejects.toThrow(QuizGenerationError);
  });

  it("holds the true/false share to an exact per-quiz quota instead of a per-slot coin flip", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    // questionCount: 5 so the 4 multiple_choice + 1 true_false slots it needs
    // stay within MULTIPLE_CHOICE_FACTS/TRUE_FALSE_FACTS' 5 distinct facts
    // each — a larger count would need to cycle back through the same facts
    // and start tripping findDuplicate, which isn't what this test is about.
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 5,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(5);
    const trueFalseCount = quiz.questions.filter((q) => q.type === "true_false").length;
    // TRUE_FALSE_RATIO is 0.2 — for 5 questions that's an exact quota of 1,
    // not a probabilistic average, so this should hold on every run.
    expect(trueFalseCount).toBe(1);
  });

  it("rejects a draft that fails the difficulty-conformance judge and recovers once it matches", async () => {
    let difficultyCalls = 0;
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      if (isDifficultyCheck(messages)) {
        difficultyCalls++;
        return JSON.stringify({ matches: difficultyCalls > 1, reason: "test" });
      }
      return validDraftFor(messages);
    });

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 1,
      difficulty: "beginner",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(difficultyCalls).toBeGreaterThan(1);
  });

  it("drops a slot whose difficulty-conformance check never passes", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      if (isDifficultyCheck(messages)) {
        return JSON.stringify({ matches: false, reason: "never matches" });
      }
      return validDraftFor(messages);
    });

    const { generateQuiz, QuizGenerationError } = await import("@/lib/localQuizGenerator");
    await expect(
      generateQuiz({
        topics: ["Sanatana Dharma"],
        sourceText: "",
        questionCount: 1,
        difficulty: "advanced",
        coverageLabel: "Week 1",
      })
    ).rejects.toThrow(QuizGenerationError);
  });
});
