import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

const completeChatMock = vi.fn();
const judgeQuestionMock = vi.fn();

vi.mock("@/lib/openrouter", () => ({
  completeChat: (...args: [string, ChatMessage[], string?]) => completeChatMock(...args),
  OpenRouterError: class OpenRouterError extends Error {},
}));

// The three separate judge round-trips (faithfulness / answerable /
// difficulty) are now one combined call — faithfulness.ts's judgeQuestion,
// returning { faithful, answerable, difficultyMatch, reason } (any subset
// null when not asked for or on a fail-open).
vi.mock("@/lib/faithfulness", () => ({
  judgeQuestion: (...args: [Record<string, unknown>]) => judgeQuestionMock(...args),
}));

function requestedType(messages: ChatMessage[]): "multiple_choice" | "true_false" {
  const userContent = messages.find((m) => m.role === "user")?.content ?? "";
  return userContent.includes('"type":"true_false"') ? "true_false" : "multiple_choice";
}

// Every grounded test builds its sourceText to contain this exact phrase so
// validDraftFor's cited source_excerpt passes the verbatim check — while
// deliberately NOT containing the MC answers below, so the grounding
// short-circuit (verbatim excerpt + verbatim answer => skip the judge) does
// not fire and judgeQuestion is actually consulted.
const SOURCE_EXCERPT = "a sentence copied verbatim from the course notes";

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
  const index = draftCounter++ % MULTIPLE_CHOICE_FACTS.length;
  if (requestedType(messages) === "true_false") {
    return JSON.stringify({
      type: "true_false",
      question: TRUE_FALSE_FACTS[index],
      answer: "True",
      explanation: "Because.",
      core_fact: TRUE_FALSE_CORE_FACTS[index],
      source_excerpt: SOURCE_EXCERPT,
    });
  }
  return JSON.stringify({
    type: "multiple_choice",
    ...MULTIPLE_CHOICE_FACTS[index],
    explanation: "Because.",
    source_excerpt: SOURCE_EXCERPT,
  });
}

/** sourceText that passes validDraftFor's verbatim source_excerpt check
 *  without containing any MC answer (so the grounding short-circuit stays
 *  off and judgeQuestion is exercised). */
const GROUNDED_SOURCE = `Overview of the week's material. ${SOURCE_EXCERPT}. Further supporting notes follow.`;

const PASSING_VERDICT = { faithful: true, answerable: true, difficultyMatch: true, reason: "ok" };

describe("generateQuiz", () => {
  const originalFallback = process.env.OPENROUTER_MODEL_FALLBACK;
  const originalBackend = process.env.LLM_BACKEND;

  beforeEach(() => {
    draftCounter = 0;
    // Default: the combined judge passes every axis, so tests that aren't
    // about grading don't have to think about it.
    judgeQuestionMock.mockImplementation(async () => ({ ...PASSING_VERDICT }));
  });

  afterEach(() => {
    completeChatMock.mockReset();
    judgeQuestionMock.mockReset();
    if (originalFallback === undefined) delete process.env.OPENROUTER_MODEL_FALLBACK;
    else process.env.OPENROUTER_MODEL_FALLBACK = originalFallback;
    if (originalBackend === undefined) delete process.env.LLM_BACKEND;
    else process.env.LLM_BACKEND = originalBackend;
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
    // Two distinct draft models only exist on the "openrouter" backend; the
    // default "local" backend serves one model for every ladder rung (and so
    // skips the fallback-model third attempt entirely).
    process.env.LLM_BACKEND = "openrouter";
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

  it("retries a schema-valid draft that fails the grounding check, and keeps it once it passes", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));
    judgeQuestionMock
      .mockImplementationOnce(async () => ({ ...PASSING_VERDICT, faithful: false })) // first attempt: not grounded
      .mockImplementation(async () => ({ ...PASSING_VERDICT })); // repair retry: grounded

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: GROUNDED_SOURCE,
      questionCount: 1,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(judgeQuestionMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("drops a slot whose drafts never pass the grounding check", async () => {
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));
    judgeQuestionMock.mockImplementation(async () => ({ ...PASSING_VERDICT, faithful: false }));

    const { generateQuiz, QuizGenerationError } = await import("@/lib/localQuizGenerator");
    await expect(
      generateQuiz({
        topics: ["Sanatana Dharma"],
        sourceText: GROUNDED_SOURCE,
        questionCount: 1,
        difficulty: "mixed",
        coverageLabel: "Week 1",
      })
    ).rejects.toThrow(QuizGenerationError);
  });

  it("skips the grounding judge when the cited excerpt and the answer are both verbatim in the passage", async () => {
    // source_excerpt AND the marked answer both appear verbatim => grounded
    // by construction => no judge call at all on the local backend.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0); // force multiple_choice
    completeChatMock.mockImplementation(async () =>
      JSON.stringify({
        type: "multiple_choice",
        question: "Who narrates the Bhagavatam to Pariksit?",
        choices: ["Sukadeva Goswami", "Vyasa", "Narada", "Suta"],
        answer: "Sukadeva Goswami",
        explanation: "Because.",
        core_fact: "narrator of the Bhagavatam to Pariksit",
        source_excerpt: SOURCE_EXCERPT,
      })
    );

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: `${SOURCE_EXCERPT}. Sukadeva Goswami is the narrator.`,
      questionCount: 1,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(judgeQuestionMock).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  it("never keeps two questions that are exact repeats of each other", async () => {
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
    let call = 0;
    completeChatMock.mockImplementation(async () => {
      call++;
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
    process.env.LLM_BACKEND = "openrouter"; // the answerability axis only gates on this backend
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0); // forces multiple_choice every time
    let judgeCalls = 0;
    judgeQuestionMock.mockImplementation(async () => {
      judgeCalls++;
      return { ...PASSING_VERDICT, answerable: judgeCalls > 1 };
    });
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));

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
    expect(judgeCalls).toBeGreaterThan(1);
    randomSpy.mockRestore();
  });

  it("drops a slot whose answerability check never passes, even after its type flips to escape a stuck quota", async () => {
    process.env.LLM_BACKEND = "openrouter";
    judgeQuestionMock.mockImplementation(async (p: { type: string }) => ({
      ...PASSING_VERDICT,
      answerable: p.type === "multiple_choice" ? false : true,
    }));
    // Force the flipped-to true_false attempt to fail too (invalid JSON), so
    // the test still proves a genuinely unfillable slot is dropped rather
    // than the type flip being an unconditional escape hatch.
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      if (requestedType(messages) === "true_false") return "not valid json";
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
    process.env.LLM_BACKEND = "openrouter";
    judgeQuestionMock.mockImplementation(async (p: { type: string }) => ({
      ...PASSING_VERDICT,
      answerable: p.type === "multiple_choice" ? false : true,
    }));
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));

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
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 5,
      difficulty: "mixed",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(5);
    const trueFalseCount = quiz.questions.filter((q) => q.type === "true_false").length;
    expect(trueFalseCount).toBe(1);
  });

  it("rejects a draft that fails the difficulty-conformance judge and recovers once it matches", async () => {
    process.env.LLM_BACKEND = "openrouter"; // the difficulty axis only gates on this backend
    let judgeCalls = 0;
    judgeQuestionMock.mockImplementation(async () => {
      judgeCalls++;
      return { ...PASSING_VERDICT, difficultyMatch: judgeCalls > 1 };
    });
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: "",
      questionCount: 1,
      difficulty: "beginner",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(judgeCalls).toBeGreaterThan(1);
  });

  it("drops a slot whose difficulty-conformance check never passes", async () => {
    process.env.LLM_BACKEND = "openrouter";
    judgeQuestionMock.mockImplementation(async () => ({ ...PASSING_VERDICT, difficultyMatch: false }));
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));

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

  it("on the local backend asks the judge for grounding only — never difficulty or answerability", async () => {
    // Grounded, so judgeQuestion IS called (for faithfulness). It's mocked
    // to fail difficulty and answerability; if the local backend gated on
    // those the slot would be dropped. Instead the draft is kept and the
    // call is made with those axes explicitly not requested.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0); // force multiple_choice
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => validDraftFor(messages));
    judgeQuestionMock.mockImplementation(async () => ({ faithful: true, answerable: false, difficultyMatch: false, reason: "x" }));

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    const quiz = await generateQuiz({
      topics: ["Sanatana Dharma"],
      sourceText: GROUNDED_SOURCE,
      questionCount: 1,
      difficulty: "advanced",
      coverageLabel: "Week 1",
    });

    expect(quiz.questions).toHaveLength(1);
    expect(judgeQuestionMock).toHaveBeenCalled();
    for (const [callArg] of judgeQuestionMock.mock.calls as [Record<string, unknown>][]) {
      expect(callArg.askAnswerable).toBe(false);
      expect(callArg.difficultyCriteria).toBeNull();
      expect(callArg.askFaithful).toBe(true);
    }
    randomSpy.mockRestore();
  });

  it("grounds each slot and the judge in its focus topic's scoped passage, not the whole corpus", async () => {
    process.env.LLM_BACKEND = "openrouter"; // so the judge runs for grounding on every slot
    const draftUserMessages: string[] = [];
    completeChatMock.mockImplementation(async (_model: string, messages: ChatMessage[]) => {
      draftUserMessages.push(messages.find((m) => m.role === "user")?.content ?? "");
      return validDraftFor(messages);
    });
    const judgeSourceTexts: string[] = [];
    judgeQuestionMock.mockImplementation(async (p: { sourceText: string }) => {
      judgeSourceTexts.push(p.sourceText);
      return { ...PASSING_VERDICT };
    });

    const alphaPassage = `ALPHA_PASSAGE. ${SOURCE_EXCERPT}. ${"alpha detail ".repeat(300)}`;
    const betaPassage = `BETA_PASSAGE. ${SOURCE_EXCERPT}. ${"beta detail ".repeat(300)}`;

    const { generateQuiz } = await import("@/lib/localQuizGenerator");
    await generateQuiz({
      topics: ["Alpha", "Beta"],
      sourceText: "FULL_CORPUS_SENTINEL — this must never be shown to a call",
      topicSourceText: { Alpha: alphaPassage, Beta: betaPassage },
      questionCount: 4,
      difficulty: "mixed",
      coverageLabel: "Week X",
    });

    expect(draftUserMessages.length).toBeGreaterThan(0);
    for (const content of draftUserMessages) {
      expect(content).not.toContain("FULL_CORPUS_SENTINEL");
      expect(content.includes("ALPHA_PASSAGE") || content.includes("BETA_PASSAGE")).toBe(true);
    }
    expect(judgeSourceTexts.length).toBeGreaterThan(0);
    for (const sourceText of judgeSourceTexts) {
      expect(sourceText).not.toContain("FULL_CORPUS_SENTINEL");
      expect(sourceText.includes("ALPHA_PASSAGE") || sourceText.includes("BETA_PASSAGE")).toBe(true);
    }
  });
});
