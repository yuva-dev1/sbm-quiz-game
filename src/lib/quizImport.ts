/**
 * Turns an uploaded file into a set of playable live-quiz questions.
 *
 * Three parsing strategies, picked by file type, all funnelling into the
 * same normaliser/validator (`normalizeQuestions`) and the same
 * `createQuiz` call the generator uses:
 *
 *  - **Delimited** (`.csv`, `.tsv`) — a dependency-free RFC-4180-ish reader
 *    (`parseDelimited`), then `questionsFromRows` maps columns to questions
 *    either by a recognised header row or positionally
 *    (`question, correctAnswer, wrong1, wrong2, …`).
 *  - **JSON** (`.json`) — `questionsFromJson`, an explicit
 *    `{ title?, questions: [...] }` shape.
 *  - **Free text / PDF / anything else** — `questionsFromStructuredText`
 *    first (it recognises `Q:`/`A:` pairs and lettered `a) … *c) …` MCQ
 *    blocks with zero LLM cost); if that finds nothing, the text is handed
 *    to the configured LLM backend (`extractQuestionsWithLlm`) with a strict
 *    "extract only, never invent" instruction. PDFs are run through `unpdf`
 *    to get their text first.
 *
 * The LLM path is the only one that needs `LLM_API_KEY` / an OpenRouter key;
 * the structured paths work with no backend configured at all.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { completeChat, OpenRouterError } from "@/lib/openrouter";
import { generationModels } from "@/lib/llmBackend";
import {
  MIN_TIME_LIMIT_SECS,
  MAX_TIME_LIMIT_SECS,
  DEFAULT_TIME_LIMIT_SECS,
} from "@/lib/timeLimits";

export class QuizImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizImportError";
  }
}

export type ImportedQuestionType = "MULTIPLE_CHOICE" | "TRUE_FALSE" | "MULTI_SELECT";

export type ImportedQuestion = {
  type: ImportedQuestionType;
  question: string;
  choices: string[];
  correctChoices: string[];
  timeLimitSecs: number;
};

/** Hard ceiling on a single import — a runaway file shouldn't create a
 * thousand-question quiz. */
export const MAX_IMPORTED_QUESTIONS = 100;
const MAX_QUESTION_CHARS = 500; // matches the /api/quizzes/[id]/questions limit
const MAX_CHOICE_CHARS = 200;
const MIN_CHOICES = 2;
const MAX_CHOICES = 6;
const MAX_LLM_INPUT_CHARS = 24_000;

const TRUE_FALSE_CHOICES = ["True", "False"];

// --- delimited (CSV / TSV) -------------------------------------------------

/**
 * Minimal RFC-4180-ish reader: handles quoted fields, embedded delimiters,
 * embedded newlines, and `""` escaped quotes. Bare `\r\n` and `\r` are
 * treated as row breaks. Good enough for hand-made quiz spreadsheets
 * exported from Sheets/Excel — not a general CSV library.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (char === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    if (char === "\r") {
      pushRow();
      if (text[i + 1] === "\n") i += 1;
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // Trailing field/row (file not ending in a newline).
  if (field !== "" || row.length > 0) pushRow();

  // Drop fully-blank rows.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

const HEADER_QUESTION = /^(question|prompt|q|text)$/i;
// Deliberately no bare single letters here — a spreadsheet that names its
// option columns "a,b,c,d" must not have "a" picked up as the answer column.
const HEADER_CORRECT = /^(correct|correct answer|correctanswer|answer|answer key|key)$/i;
const HEADER_OPTION = /^(option|choice|answer|distractor|wrong|incorrect)\s*\d*$/i;
const HEADER_TYPE = /^(type|kind)$/i;
const HEADER_TIME = /^(time|timelimit|time limit|seconds|secs|duration)$/i;

function looksLikeHeader(row: string[]): boolean {
  return row.some((cell) => HEADER_QUESTION.test(cell.trim()));
}

/** Resolve one correct-answer token against the question's choices: a
 * letter (`A`/`b`), a 1-based index (`3`), or exact (case-insensitive)
 * choice text. Returns the canonical choice string, or `undefined`. */
function resolveCorrectToken(token: string, choices: string[]): string | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;

  if (/^[A-Za-z]$/.test(trimmed)) {
    const idx = trimmed.toLowerCase().charCodeAt(0) - 97;
    if (idx >= 0 && idx < choices.length) return choices[idx];
  }
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx];
  }
  return choices.find((c) => c.trim().toLowerCase() === trimmed.toLowerCase());
}

/** A correct-answer cell may name one answer or several (`A,C` / `red; blue`).
 * Only treat it as multi if every split piece resolves — otherwise it's a
 * single answer that happened to contain punctuation. */
function resolveCorrectCell(cell: string, choices: string[]): string[] {
  const raw = cell.trim();
  if (!raw) return [];

  const parts = raw.split(/\s*[,;|/]\s*/).filter(Boolean);
  if (parts.length > 1) {
    const resolved = parts.map((p) => resolveCorrectToken(p, choices));
    if (resolved.every((r): r is string => Boolean(r))) {
      return [...new Set(resolved)];
    }
  }

  const one = resolveCorrectToken(raw, choices);
  if (one) return [one];

  // Unresolved — hand the raw text back; the caller decides whether to fold
  // it into `choices` or reject the row.
  return [raw];
}

function isTrueFalseCell(value: string): boolean {
  return /^(true|false|t|f|yes|no|y|n)$/i.test(value.trim());
}

function normalizeTrueFalse(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "t" || v === "yes" || v === "y") return "True";
  if (v === "false" || v === "f" || v === "no" || v === "n") return "False";
  return undefined;
}

export function questionsFromRows(rows: string[][]): ImportedQuestion[] {
  if (rows.length === 0) return [];

  let headerMap: { question: number; correct: number; type: number; time: number; options: number[] } | null = null;
  let dataRows = rows;

  if (looksLikeHeader(rows[0])) {
    const header = rows[0].map((c) => c.trim());
    const question = header.findIndex((c) => HEADER_QUESTION.test(c));
    const correct = header.findIndex((c) => HEADER_CORRECT.test(c));
    const type = header.findIndex((c) => HEADER_TYPE.test(c));
    const time = header.findIndex((c) => HEADER_TIME.test(c));
    const options: number[] = [];
    header.forEach((c, idx) => {
      if (idx === question || idx === correct || idx === type || idx === time) return;
      if (HEADER_OPTION.test(c) || c === "") options.push(idx);
      else options.push(idx); // any other extra column is treated as an option
    });
    headerMap = { question, correct, type, time, options };
    dataRows = rows.slice(1);
  }

  const questions: ImportedQuestion[] = [];

  for (const row of dataRows) {
    const cells = row.map((c) => c.trim());
    let questionText: string;
    let correctCell: string;
    let typeCell = "";
    let timeCell = "";
    let optionCells: string[];

    if (headerMap) {
      questionText = cells[headerMap.question] ?? "";
      correctCell = headerMap.correct >= 0 ? (cells[headerMap.correct] ?? "") : "";
      typeCell = headerMap.type >= 0 ? (cells[headerMap.type] ?? "") : "";
      timeCell = headerMap.time >= 0 ? (cells[headerMap.time] ?? "") : "";
      optionCells = headerMap.options.map((idx) => cells[idx] ?? "").filter((c) => c !== "");
    } else {
      // Positional: question, correctAnswer, wrong1, wrong2, ...
      questionText = cells[0] ?? "";
      correctCell = cells[1] ?? "";
      const rest = cells.slice(2).filter((c) => c !== "");
      optionCells = [correctCell, ...rest].filter((c) => c !== "");
    }

    if (!questionText) continue;

    const wantsTrueFalse =
      /^(true[_\s-]?false|tf|boolean|bool)$/i.test(typeCell) ||
      (optionCells.length === 0 && isTrueFalseCell(correctCell)) ||
      (optionCells.length <= 2 && optionCells.every(isTrueFalseCell) && isTrueFalseCell(correctCell));

    if (wantsTrueFalse) {
      const answer = normalizeTrueFalse(correctCell);
      if (!answer) continue;
      questions.push({
        type: "TRUE_FALSE",
        question: questionText,
        choices: [...TRUE_FALSE_CHOICES],
        correctChoices: [answer],
        timeLimitSecs: parseTimeLimit(timeCell),
      });
      continue;
    }

    let choices = [...new Set(optionCells)];
    let correctChoices = resolveCorrectCell(correctCell, choices);

    // The correct answer's text wasn't among the option columns — fold it in
    // (common when a sheet lists only the distractors as "option" columns).
    const unresolved = correctChoices.filter((c) => !choices.includes(c));
    if (unresolved.length > 0) {
      choices = [...new Set([...choices, ...unresolved])];
      correctChoices = resolveCorrectCell(correctCell, choices);
    }

    questions.push({
      type: correctChoices.length > 1 ? "MULTI_SELECT" : "MULTIPLE_CHOICE",
      question: questionText,
      choices,
      correctChoices,
      timeLimitSecs: parseTimeLimit(timeCell),
    });
  }

  return questions;
}

function parseTimeLimit(raw: string): number {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIME_LIMIT_SECS;
  return Math.round(n);
}

// --- JSON ----------------------------------------------------------------

export function questionsFromJson(text: string): { title?: string; questions: ImportedQuestion[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new QuizImportError("That .json file isn't valid JSON.");
  }

  const container = Array.isArray(parsed) ? { questions: parsed } : (parsed as Record<string, unknown>);
  const rawList = (container?.questions ?? container?.items ?? container?.quiz) as unknown;
  if (!Array.isArray(rawList)) {
    throw new QuizImportError('The JSON must be an array of questions, or an object with a "questions" array.');
  }

  const title = typeof container?.title === "string" ? container.title : undefined;

  const questions: ImportedQuestion[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;

    const questionText = String(q.question ?? q.prompt ?? q.q ?? q.text ?? "").trim();
    if (!questionText) continue;

    const rawChoices = (q.choices ?? q.options ?? q.answers) as unknown;
    const choices = Array.isArray(rawChoices)
      ? rawChoices.map((c) => String(c).trim()).filter(Boolean)
      : [];

    const rawCorrect = (q.correctChoices ?? q.correctAnswers ?? q.correct ?? q.answer ?? q.correctAnswer) as unknown;
    const correctList = Array.isArray(rawCorrect)
      ? rawCorrect.map((c) => String(c).trim())
      : rawCorrect !== undefined && rawCorrect !== null
        ? [String(rawCorrect).trim()]
        : [];

    const declaredType = String(q.type ?? "").toUpperCase().replace(/[\s-]/g, "_");

    if (declaredType === "TRUE_FALSE" || (choices.length === 0 && correctList.length === 1 && isTrueFalseCell(correctList[0]))) {
      const answer = normalizeTrueFalse(correctList[0] ?? "");
      if (!answer) continue;
      questions.push({
        type: "TRUE_FALSE",
        question: questionText,
        choices: [...TRUE_FALSE_CHOICES],
        correctChoices: [answer],
        timeLimitSecs: parseTimeLimit(String(q.timeLimitSecs ?? q.time ?? "")),
      });
      continue;
    }

    let resolvedChoices = [...new Set(choices)];
    let correctChoices = correctList.flatMap((c) => resolveCorrectCell(c, resolvedChoices));
    const unresolved = correctChoices.filter((c) => !resolvedChoices.includes(c));
    if (unresolved.length > 0) {
      resolvedChoices = [...new Set([...resolvedChoices, ...unresolved])];
      correctChoices = correctList.flatMap((c) => resolveCorrectCell(c, resolvedChoices));
    }
    correctChoices = [...new Set(correctChoices)];

    questions.push({
      type: declaredType === "MULTI_SELECT" || correctChoices.length > 1 ? "MULTI_SELECT" : "MULTIPLE_CHOICE",
      question: questionText,
      choices: resolvedChoices,
      correctChoices,
      timeLimitSecs: parseTimeLimit(String(q.timeLimitSecs ?? q.time ?? "")),
    });
  }

  return { title, questions };
}

// --- structured plain text ---------------------------------------------

// An `A:` line immediately under a `Q:` line. `.` can't cross newlines
// (no dotAll flag at this TS target), which is exactly right here — the
// prompt is the rest of the Q line, the answer the rest of the next line —
// and blank lines between pairs are then a non-issue.
const QA_BLOCK_RE = /(?:^|\n)[ \t]*Q(?:uestion)?[ \t]*\d*[:.)][ \t]*(.+)\n[ \t]*A(?:nswer)?[ \t]*[:.)][ \t]*(.+)/gi;
const MCQ_LINE_RE = /^\s*(\*?)\s*([A-Za-z])[).]\s+(.*\S)\s*$/;
const MCQ_QUESTION_RE = /^\s*(?:\d+[).]|Q[:.)])\s*(.+\S)\s*$/i;

/**
 * Recognises two common hand-written formats with no LLM:
 *   Q: ... / A: ...  (one line each)
 *   1. Question?
 *      a) wrong
 *      *b) right      (asterisk, or a trailing "(correct)", marks the answer)
 * Returns `null` when neither shape is present so the caller can fall back
 * to the LLM.
 */
export function questionsFromStructuredText(text: string): ImportedQuestion[] | null {
  // Run both recognisers and merge — a file can mix lettered MCQ blocks with
  // Q:/A: pairs, and neither should mask the other. De-dupe by prompt,
  // preferring the multiple-choice version when both produced one.
  const byQuestion = new Map<string, ImportedQuestion>();
  for (const q of [...questionsFromLetteredMcq(text), ...questionsFromQaPairs(text)]) {
    const key = q.question.trim().toLowerCase();
    if (!byQuestion.has(key)) byQuestion.set(key, q);
  }

  return byQuestion.size > 0 ? [...byQuestion.values()] : null;
}

function questionsFromQaPairs(text: string): ImportedQuestion[] {
  const questions: ImportedQuestion[] = [];
  for (const match of text.matchAll(QA_BLOCK_RE)) {
    const questionText = match[1].trim().replace(/\s+/g, " ");
    const answer = match[2].trim().replace(/\s+/g, " ");
    if (!questionText || !answer) continue;

    if (isTrueFalseCell(answer)) {
      const tf = normalizeTrueFalse(answer);
      if (tf) {
        questions.push({
          type: "TRUE_FALSE",
          question: questionText,
          choices: [...TRUE_FALSE_CHOICES],
          correctChoices: [tf],
          timeLimitSecs: DEFAULT_TIME_LIMIT_SECS,
        });
        continue;
      }
    }
    // A bare Q/A pair with no distractors can't be a live multiple-choice
    // question — skip it rather than invent wrong answers.
  }
  return questions;
}

function questionsFromLetteredMcq(text: string): ImportedQuestion[] {
  const lines = text.split(/\r?\n/);
  const questions: ImportedQuestion[] = [];

  let currentQuestion: string | null = null;
  let choices: string[] = [];
  let correct: string[] = [];

  const flush = () => {
    if (currentQuestion && choices.length >= MIN_CHOICES) {
      questions.push({
        type: correct.length > 1 ? "MULTI_SELECT" : "MULTIPLE_CHOICE",
        question: currentQuestion,
        choices: [...choices],
        correctChoices: correct.length > 0 ? [...new Set(correct)] : [choices[0]],
        timeLimitSecs: DEFAULT_TIME_LIMIT_SECS,
      });
    }
    currentQuestion = null;
    choices = [];
    correct = [];
  };

  for (const line of lines) {
    const choiceMatch = line.match(MCQ_LINE_RE);
    if (choiceMatch && currentQuestion) {
      const markedByStar = choiceMatch[1] === "*";
      let choiceText = choiceMatch[3].trim();
      const markedByTag = /\(\s*correct\s*\)\s*$/i.test(choiceText) || /\s\[x\]\s*$/i.test(choiceText);
      choiceText = choiceText.replace(/\s*\(\s*correct\s*\)\s*$/i, "").replace(/\s*\[x\]\s*$/i, "").trim();
      if (!choiceText) continue;
      choices.push(choiceText);
      if (markedByStar || markedByTag) correct.push(choiceText);
      continue;
    }

    const questionMatch = line.match(MCQ_QUESTION_RE);
    if (questionMatch) {
      flush();
      currentQuestion = questionMatch[1].trim();
      continue;
    }

    // A blank line ends the current block.
    if (line.trim() === "") flush();
  }
  flush();

  return questions;
}

// --- PDF ---------------------------------------------------------------

export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    // `mergePages` collapses the per-page array into one string.
    const { text } = await extractText(pdf, { mergePages: true });
    return typeof text === "string" ? text : "";
  } catch (error) {
    throw new QuizImportError(
      `Couldn't read that PDF: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// --- LLM extraction --------------------------------------------------

const LLM_SYSTEM_PROMPT = `You extract quiz questions from a document. Rules:
- Use ONLY questions and answers that are explicitly present in the document. Never invent questions, answers, or distractors.
- If a question has no answer in the document, skip it.
- If the document contains no quiz questions with answers, return {"questions": []}.
- For each question provide 2-6 answer choices. If the document only gives the correct answer with no wrong options, skip that question (it can't be played as multiple choice).
- Mark every choice that is correct.
Respond with ONLY this JSON shape:
{"title": string, "questions": [{"question": string, "type": "MULTIPLE_CHOICE" | "TRUE_FALSE" | "MULTI_SELECT", "choices": string[], "correctChoices": string[]}]}`;

export async function extractQuestionsWithLlm(
  text: string
): Promise<{ title?: string; questions: ImportedQuestion[] }> {
  const trimmed = text.slice(0, MAX_LLM_INPUT_CHARS);
  const { primaryModel } = generationModels();

  let raw: string;
  try {
    raw = await completeChat(
      primaryModel,
      [
        { role: "system", content: LLM_SYSTEM_PROMPT },
        { role: "user", content: `Document:\n\n${trimmed}` },
      ],
      "unknown"
    );
  } catch (error) {
    if (error instanceof OpenRouterError) {
      throw new QuizImportError(
        `Couldn't reach the quiz-extraction model. Upload a CSV or JSON instead, or try again. (${error.message})`
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new QuizImportError("The extraction model didn't return usable JSON. Try a CSV or JSON file instead.");
  }

  const container = (parsed ?? {}) as Record<string, unknown>;
  const list = Array.isArray(container.questions) ? container.questions : [];
  const title = typeof container.title === "string" ? container.title : undefined;

  const questions: ImportedQuestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const questionText = String(q.question ?? "").trim();
    const choices = Array.isArray(q.choices) ? q.choices.map((c) => String(c).trim()).filter(Boolean) : [];
    const correct = Array.isArray(q.correctChoices)
      ? q.correctChoices.map((c) => String(c).trim()).filter(Boolean)
      : [];
    const declaredType = String(q.type ?? "").toUpperCase().replace(/[\s-]/g, "_");
    if (!questionText) continue;

    if (declaredType === "TRUE_FALSE") {
      const answer = normalizeTrueFalse(correct[0] ?? "");
      if (!answer) continue;
      questions.push({
        type: "TRUE_FALSE",
        question: questionText,
        choices: [...TRUE_FALSE_CHOICES],
        correctChoices: [answer],
        timeLimitSecs: DEFAULT_TIME_LIMIT_SECS,
      });
      continue;
    }

    questions.push({
      type: declaredType === "MULTI_SELECT" || correct.length > 1 ? "MULTI_SELECT" : "MULTIPLE_CHOICE",
      question: questionText,
      choices: [...new Set(choices)],
      correctChoices: [...new Set(correct)],
      timeLimitSecs: DEFAULT_TIME_LIMIT_SECS,
    });
  }

  return { title, questions };
}

// --- normalisation / validation --------------------------------------

/** Drops or repairs questions that can't be played live; throws if nothing
 * usable is left. Returned questions are guaranteed valid for `createQuiz`. */
export function normalizeQuestions(raw: ImportedQuestion[]): ImportedQuestion[] {
  const clean: ImportedQuestion[] = [];

  for (const q of raw) {
    const question = q.question.trim().replace(/\s+/g, " ").slice(0, MAX_QUESTION_CHARS);
    if (!question) continue;

    if (q.type === "TRUE_FALSE") {
      const answer = q.correctChoices.map((c) => normalizeTrueFalse(c)).find(Boolean);
      if (!answer) continue;
      clean.push({
        type: "TRUE_FALSE",
        question,
        choices: [...TRUE_FALSE_CHOICES],
        correctChoices: [answer],
        timeLimitSecs: clampTime(q.timeLimitSecs),
      });
      continue;
    }

    // De-dupe choices case-insensitively, keep first spelling, trim/cap.
    const seen = new Set<string>();
    const choices: string[] = [];
    for (const rawChoice of q.choices) {
      const choice = rawChoice.trim().replace(/\s+/g, " ").slice(0, MAX_CHOICE_CHARS);
      const key = choice.toLowerCase();
      if (!choice || seen.has(key)) continue;
      seen.add(key);
      choices.push(choice);
    }
    if (choices.length < MIN_CHOICES) continue;
    const trimmedChoices = choices.slice(0, MAX_CHOICES);

    const correctChoices = [
      ...new Set(
        q.correctChoices
          .map((c) => c.trim().replace(/\s+/g, " ").slice(0, MAX_CHOICE_CHARS))
          .map((c) => trimmedChoices.find((tc) => tc.toLowerCase() === c.toLowerCase()))
          .filter((c): c is string => Boolean(c))
      ),
    ];
    if (correctChoices.length === 0) continue;

    clean.push({
      type: correctChoices.length > 1 ? "MULTI_SELECT" : "MULTIPLE_CHOICE",
      question,
      choices: trimmedChoices,
      correctChoices,
      timeLimitSecs: clampTime(q.timeLimitSecs),
    });
  }

  if (clean.length === 0) {
    throw new QuizImportError(
      "Couldn't find any playable questions in that file. Each question needs a prompt, at least two answer choices, and a marked correct answer."
    );
  }

  return clean.slice(0, MAX_IMPORTED_QUESTIONS);
}

function clampTime(secs: number): number {
  if (!Number.isFinite(secs)) return DEFAULT_TIME_LIMIT_SECS;
  return Math.min(MAX_TIME_LIMIT_SECS, Math.max(MIN_TIME_LIMIT_SECS, Math.round(secs)));
}

// --- orchestrator ----------------------------------------------------

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const cleaned = base.replace(/\s+/g, " ");
  if (!cleaned) return "Imported quiz";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export type ImportResult = { title: string; questions: ImportedQuestion[]; usedLlm: boolean };

/**
 * Full pipeline: bytes + filename/mime -> a validated quiz draft payload.
 * Chooses the parser from the extension (falling back to the MIME type),
 * then normalises. `usedLlm` lets the route/telemetry note when the model
 * was involved.
 */
export async function importQuizFromFile(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<ImportResult> {
  const ext = extensionOf(input.filename);
  const mime = input.mimeType.toLowerCase();
  const isPdf = ext === "pdf" || mime.includes("pdf");
  const isCsv = ext === "csv" || mime === "text/csv";
  const isTsv = ext === "tsv" || mime === "text/tab-separated-values";
  const isJson = ext === "json" || mime === "application/json";

  let title: string | undefined;
  let questions: ImportedQuestion[];
  let usedLlm = false;

  if (isCsv || isTsv) {
    const text = new TextDecoder().decode(input.bytes);
    const delimiter = isTsv ? "\t" : detectDelimiter(text);
    questions = questionsFromRows(parseDelimited(text, delimiter));
    if (questions.length === 0) {
      throw new QuizImportError(
        "That spreadsheet didn't have any rows I could read as questions. Expected columns like: question, correct answer, wrong answer 1, wrong answer 2…"
      );
    }
  } else if (isJson) {
    const text = new TextDecoder().decode(input.bytes);
    ({ title, questions } = questionsFromJson(text));
  } else {
    // Plain text, Markdown, PDF, or an unknown type we'll try as text.
    const text = isPdf
      ? await extractTextFromPdf(input.bytes)
      : new TextDecoder().decode(input.bytes);

    if (!text.trim()) {
      throw new QuizImportError("That file looks empty — no text to pull questions from.");
    }

    const structured = questionsFromStructuredText(text);
    if (structured && structured.length > 0) {
      questions = structured;
    } else {
      ({ title, questions } = await extractQuestionsWithLlm(text));
      usedLlm = true;
    }
  }

  const normalized = normalizeQuestions(questions);
  return {
    title: (title && title.trim()) || titleFromFilename(input.filename),
    questions: normalized,
    usedLlm,
  };
}
