import { describe, expect, it } from "vitest";
import {
  parseDelimited,
  questionsFromRows,
  questionsFromJson,
  questionsFromStructuredText,
  normalizeQuestions,
  QuizImportError,
  type ImportedQuestion,
} from "@/lib/quizImport";

describe("parseDelimited", () => {
  it("splits a simple comma file", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("respects quoted fields with embedded commas, quotes and newlines", () => {
    const text = 'q,"a, b","she said ""hi"""\n"line1\nline2",x,y\n';
    expect(parseDelimited(text, ",")).toEqual([
      ["q", "a, b", 'she said "hi"'],
      ["line1\nline2", "x", "y"],
    ]);
  });

  it("handles a file with no trailing newline and drops blank rows", () => {
    expect(parseDelimited("a,b\n\n\nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses tab-separated input", () => {
    expect(parseDelimited("q\tans\n1\t2\n", "\t")).toEqual([
      ["q", "ans"],
      ["1", "2"],
    ]);
  });
});

describe("questionsFromRows — headerless positional", () => {
  it("reads question, correct answer, then wrong answers", () => {
    const rows = [
      ["Who spoke the Bhagavatam first?", "Krishna", "Arjuna", "Vyasa", "Narada"],
      ["Where was it first recited?", "Sukatal", "Vrindavan", "Mathura"],
    ];
    const questions = questionsFromRows(rows);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      type: "MULTIPLE_CHOICE",
      question: "Who spoke the Bhagavatam first?",
      choices: ["Krishna", "Arjuna", "Vyasa", "Narada"],
      correctChoices: ["Krishna"],
    });
    expect(questions[1].choices).toEqual(["Sukatal", "Vrindavan", "Mathura"]);
    expect(questions[1].correctChoices).toEqual(["Sukatal"]);
  });

  it("makes a True/False question from a two-column row", () => {
    const questions = questionsFromRows([["The Bhagavatam has 12 cantos.", "True"]]);
    expect(questions[0]).toMatchObject({
      type: "TRUE_FALSE",
      choices: ["True", "False"],
      correctChoices: ["True"],
    });
  });
});

describe("questionsFromRows — header row", () => {
  it("maps named columns and resolves a letter answer", () => {
    const rows = parseDelimited(
      "question,option 1,option 2,option 3,option 4,correct\n" +
        "How many cantos?,10,11,12,13,C\n",
      ","
    );
    const questions = questionsFromRows(rows);
    expect(questions[0]).toMatchObject({
      type: "MULTIPLE_CHOICE",
      question: "How many cantos?",
      choices: ["10", "11", "12", "13"],
      correctChoices: ["12"],
    });
  });

  it("supports a type column and a time column", () => {
    const rows = parseDelimited(
      "question,correct,type,seconds\nIs Krishna the speaker of the Gita?,yes,true_false,45\n",
      ","
    );
    const questions = questionsFromRows(rows);
    expect(questions[0]).toMatchObject({
      type: "TRUE_FALSE",
      correctChoices: ["True"],
      timeLimitSecs: 45,
    });
  });

  it("produces MULTI_SELECT when the correct cell names several options", () => {
    const rows = parseDelimited(
      "question,a,b,c,d,answer\nWhich are cantos of the Bhagavatam?,1,2,99,100,\"A, B\"\n",
      ","
    );
    const questions = questionsFromRows(rows);
    expect(questions[0].type).toBe("MULTI_SELECT");
    expect(questions[0].correctChoices.sort()).toEqual(["1", "2"]);
  });

  it("folds a correct answer that isn't among the option columns into the choices", () => {
    const rows = parseDelimited(
      "question,wrong 1,wrong 2,wrong 3,correct answer\nWho is Sukadeva's father?,Narada,Vyasa's brother,Parikshit,Vyasa\n",
      ","
    );
    const questions = questionsFromRows(rows);
    expect(questions[0].choices).toContain("Vyasa");
    expect(questions[0].correctChoices).toEqual(["Vyasa"]);
  });
});

describe("questionsFromJson", () => {
  it("reads an explicit array of questions", () => {
    const text = JSON.stringify([
      { question: "Q1?", choices: ["a", "b", "c"], answer: "b" },
      { question: "Q2?", options: ["x", "y"], correctAnswers: ["x", "y"], type: "multi-select" },
    ]);
    const { questions } = questionsFromJson(text);
    expect(questions[0]).toMatchObject({ type: "MULTIPLE_CHOICE", correctChoices: ["b"] });
    expect(questions[1]).toMatchObject({ type: "MULTI_SELECT", correctChoices: ["x", "y"] });
  });

  it("reads a wrapper object with title + questions and a true/false entry", () => {
    const text = JSON.stringify({
      title: "My Quiz",
      questions: [{ question: "The Gita has 18 chapters.", type: "TRUE_FALSE", correct: "true" }],
    });
    const { title, questions } = questionsFromJson(text);
    expect(title).toBe("My Quiz");
    expect(questions[0]).toMatchObject({ type: "TRUE_FALSE", correctChoices: ["True"] });
  });

  it("throws a QuizImportError on invalid JSON", () => {
    expect(() => questionsFromJson("{not json")).toThrow(QuizImportError);
  });
});

describe("questionsFromStructuredText", () => {
  it("reads lettered MCQ blocks with a starred correct answer", () => {
    const text = [
      "1. Who narrated the Bhagavatam to Parikshit?",
      "a) Vyasa",
      "*b) Sukadeva",
      "c) Narada",
      "d) Suta",
      "",
      "2. Where did this happen?",
      "a) Vrindavan",
      "*b) Bank of the Ganga",
    ].join("\n");
    const questions = questionsFromStructuredText(text);
    expect(questions).not.toBeNull();
    expect(questions).toHaveLength(2);
    expect(questions![0]).toMatchObject({
      type: "MULTIPLE_CHOICE",
      question: "Who narrated the Bhagavatam to Parikshit?",
      choices: ["Vyasa", "Sukadeva", "Narada", "Suta"],
      correctChoices: ["Sukadeva"],
    });
  });

  it("reads a (correct) tag as well as an asterisk", () => {
    const text = "Q. Colour of Krishna?\na) White\nb) Blue (correct)\nc) Green\n";
    const questions = questionsFromStructuredText(text);
    expect(questions![0].correctChoices).toEqual(["Blue"]);
  });

  it("turns Q:/A: true-false pairs into questions and skips bare pairs", () => {
    const text = "Q: The Bhagavatam has twelve cantos.\nA: True\n\nQ: Name the author.\nA: Vyasa\n";
    const questions = questionsFromStructuredText(text);
    expect(questions).toHaveLength(1);
    expect(questions![0]).toMatchObject({ type: "TRUE_FALSE", correctChoices: ["True"] });
  });

  it("merges lettered MCQ blocks and Q:/A: pairs from the same file", () => {
    const text = [
      "1. Where was the Bhagavatam recited?",
      "a) Vrindavan",
      "*b) Sukatal",
      "c) Mathura",
      "",
      "Q: The Bhagavatam has twelve cantos.",
      "A: True",
    ].join("\n");
    const questions = questionsFromStructuredText(text);
    expect(questions).toHaveLength(2);
    expect(questions!.map((q) => q.type)).toEqual(["MULTIPLE_CHOICE", "TRUE_FALSE"]);
  });

  it("returns null when there's no recognisable structure", () => {
    expect(questionsFromStructuredText("just some prose about the Bhagavatam, nothing structured")).toBeNull();
  });
});

describe("normalizeQuestions", () => {
  it("drops questions with too few choices or no resolvable correct answer", () => {
    const raw: ImportedQuestion[] = [
      { type: "MULTIPLE_CHOICE", question: "ok?", choices: ["a", "b", "c"], correctChoices: ["b"], timeLimitSecs: 20 },
      { type: "MULTIPLE_CHOICE", question: "too few?", choices: ["only one"], correctChoices: ["only one"], timeLimitSecs: 20 },
      { type: "MULTIPLE_CHOICE", question: "no correct?", choices: ["a", "b"], correctChoices: ["z"], timeLimitSecs: 20 },
    ];
    const clean = normalizeQuestions(raw);
    expect(clean).toHaveLength(1);
    expect(clean[0].question).toBe("ok?");
  });

  it("de-dupes choices case-insensitively and clamps the time limit", () => {
    const clean = normalizeQuestions([
      {
        type: "MULTIPLE_CHOICE",
        question: "  spaced   out  ",
        choices: ["Yes", "yes", "No", "Maybe"],
        correctChoices: ["YES"],
        timeLimitSecs: 5,
      },
    ]);
    expect(clean[0].question).toBe("spaced out");
    expect(clean[0].choices).toEqual(["Yes", "No", "Maybe"]);
    expect(clean[0].correctChoices).toEqual(["Yes"]);
    expect(clean[0].timeLimitSecs).toBe(20); // clamped up to MIN_TIME_LIMIT_SECS
  });

  it("downgrades a single-answer MULTI_SELECT to MULTIPLE_CHOICE and vice versa", () => {
    const clean = normalizeQuestions([
      { type: "MULTI_SELECT", question: "one?", choices: ["a", "b", "c"], correctChoices: ["a"], timeLimitSecs: 30 },
      { type: "MULTIPLE_CHOICE", question: "two?", choices: ["a", "b", "c"], correctChoices: ["a", "b"], timeLimitSecs: 30 },
    ]);
    expect(clean[0].type).toBe("MULTIPLE_CHOICE");
    expect(clean[1].type).toBe("MULTI_SELECT");
  });

  it("throws when nothing usable is left", () => {
    expect(() =>
      normalizeQuestions([
        { type: "MULTIPLE_CHOICE", question: "x", choices: ["a"], correctChoices: ["a"], timeLimitSecs: 20 },
      ])
    ).toThrow(QuizImportError);
  });
});
