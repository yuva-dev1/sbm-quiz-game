# Uploading a file as a live quiz

`/host` has an **Upload a quiz** card next to **Generate a new quiz**. It takes
a file the host already has and turns it into a `LIVE`, `DRAFT` quiz (same
shape `createQuiz` produces for the generator), which then shows under
**Drafts** for review and publish.

- Route: `POST /api/quizzes/upload` (multipart, field `file`; 8 MB cap).
  Host-gated by `src/proxy.ts` like the rest of `/api/quizzes/*`.
- Parsing lives in `src/lib/quizImport.ts` (`importQuizFromFile`), unit-tested
  in `src/lib/quizImport.test.ts`. Everything funnels through
  `normalizeQuestions`, which drops anything unplayable (no prompt, < 2
  choices, no resolvable correct answer) and caps the import at
  `MAX_IMPORTED_QUESTIONS` (100).

## What each file type does

| Type | How it's read | LLM? |
| --- | --- | --- |
| `.csv`, `.tsv` | `parseDelimited` + `questionsFromRows` | no |
| `.json` | `questionsFromJson` | no |
| `.txt`, `.md`, unknown | `questionsFromStructuredText`, else the LLM | only on fallback |
| `.pdf` | text via `unpdf`, then the text path above | usually (prose) |

The LLM path uses the configured backend (`src/lib/llmBackend.ts` —
self-hosted `local` by default, `openrouter` opt-in) with a strict
"extract only, never invent" instruction. The structured paths need no
backend at all, so CSV/JSON imports work with nothing configured.

## CSV / TSV format

One question per row. Either:

- **With a header row** — a `question` column, a `correct` / `answer` column,
  and one or more option columns (`option 1`, `choice`, `wrong 2`, or just any
  extra column). Optional `type` (`true_false` → a True/False question) and
  `time` / `seconds` columns. The correct cell may be a letter (`C`), a
  1-based index (`3`), or the exact option text; several of those separated by
  `,` `;` `|` `/` make it `MULTI_SELECT`.
- **Headerless positional** — `question, correct answer, wrong 1, wrong 2, …`.
  A two-column row whose answer is `true`/`false`/`yes`/`no` becomes a
  True/False question.

A correct answer that isn't among the option columns is folded in as an extra
choice, so `question, correct, wrong1, wrong2, wrong3` works too.

## JSON format

```json
{
  "title": "optional",
  "questions": [
    { "question": "…", "choices": ["a", "b", "c"], "correctChoices": ["b"] },
    { "question": "…", "type": "TRUE_FALSE", "correct": "true" },
    { "question": "…", "options": ["x", "y", "z"], "answer": ["x", "z"] }
  ]
}
```

A bare top-level array of those question objects is also accepted. Key aliases:
`prompt`/`q`/`text` for `question`, `options`/`answers` for `choices`,
`correct`/`answer`/`correctAnswer`/`correctAnswers` for `correctChoices`.

## Plain-text formats recognised without the LLM

```
1. Question text?
a) a wrong option
*b) the correct option        <- asterisk, or a trailing "(correct)"
c) another wrong option

Q: A statement to judge true or false.
A: True
```

A bare `Q:` / `A:` pair with no distractors is skipped unless the answer is
true/false — it can't be played as multiple choice.
