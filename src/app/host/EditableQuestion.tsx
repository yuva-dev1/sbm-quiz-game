"use client";

import { useState } from "react";
import { MIN_TIME_LIMIT_SECS, MAX_TIME_LIMIT_SECS } from "@/lib/timeLimits";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "TRUE_FALSE" | "SHORT_ANSWER" | "MULTI_SELECT";
  question: string;
  choices: string[];
  correctChoices: string[];
  timeLimitSecs: number;
  /** Verbatim quote from the course notes the generator backed this
   * question with — absent for manually-added questions. Shown as-is (not
   * re-derived from any in-progress edits) since it describes where the
   * originally-generated version came from. */
  sourceExcerpt?: string | null;
};

function sameChoices(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((choice, i) => choice === sortedB[i]);
}

export function EditableQuestion({
  quizId,
  question,
  index,
  canDelete,
  onSaved,
  onDeleted,
  showTimeLimit = true,
}: {
  quizId: string;
  question: Question;
  index: number;
  canDelete: boolean;
  onSaved: (updated: { question: string; choices: string[]; correctChoices: string[]; timeLimitSecs: number }) => void;
  onDeleted: () => void;
  /** Live quizzes use this as the per-question countdown; self-paced quizzes
   * have no timer, so callers there pass false to hide it entirely. */
  showTimeLimit?: boolean;
}) {
  const [savedQuestionText, setSavedQuestionText] = useState(question.question);
  const [savedChoices, setSavedChoices] = useState(question.choices);
  const [savedCorrectChoices, setSavedCorrectChoices] = useState(question.correctChoices);
  const [savedTimeLimitSecs, setSavedTimeLimitSecs] = useState(question.timeLimitSecs);
  const [questionText, setQuestionText] = useState(question.question);
  const [choices, setChoices] = useState(question.choices);
  const [correctChoices, setCorrectChoices] = useState(question.correctChoices);
  const [timeLimitSecs, setTimeLimitSecs] = useState(question.timeLimitSecs);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMultiSelect = question.type === "MULTI_SELECT";
  const editableChoiceText = question.type === "MULTIPLE_CHOICE" || isMultiSelect;
  const timeLimitValid =
    !showTimeLimit ||
    (Number.isInteger(timeLimitSecs) &&
      timeLimitSecs >= MIN_TIME_LIMIT_SECS &&
      timeLimitSecs <= MAX_TIME_LIMIT_SECS);
  const dirty =
    questionText.trim() !== savedQuestionText ||
    !sameChoices(correctChoices, savedCorrectChoices) ||
    timeLimitSecs !== savedTimeLimitSecs ||
    choices.some((choice, i) => choice !== savedChoices[i]);
  const canSave =
    dirty && timeLimitValid && questionText.trim() !== "" && correctChoices.length >= (isMultiSelect ? 2 : 1);

  function updateChoiceText(choiceIndex: number, value: string) {
    setError(null);
    setJustSaved(false);
    setChoices((current) => {
      const previousValue = current[choiceIndex];
      const next = [...current];
      next[choiceIndex] = value;
      // Correct choices are stored by text, not index — keep them pointing
      // at the same choice as its text changes underneath it.
      setCorrectChoices((currentCorrect) =>
        currentCorrect.map((c) => (c === previousValue ? value : c))
      );
      return next;
    });
  }

  function toggleCorrect(choice: string) {
    setError(null);
    setJustSaved(false);
    if (isMultiSelect) {
      setCorrectChoices((current) =>
        current.includes(choice) ? current.filter((c) => c !== choice) : [...current, choice]
      );
    } else {
      setCorrectChoices([choice]);
    }
  }

  async function handleSave() {
    if (!timeLimitValid) {
      setError(`Time limit must be between ${MIN_TIME_LIMIT_SECS} and ${MAX_TIME_LIMIT_SECS} seconds.`);
      return;
    }
    if (questionText.trim() === "") {
      setError("Question text can't be empty.");
      return;
    }
    if (correctChoices.length < (isMultiSelect ? 2 : 1)) {
      setError(isMultiSelect ? "Select at least two correct choices." : "Select the correct answer.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const body: { question: string; choices?: string[]; correctChoices: string[]; timeLimitSecs?: number } = {
        question: questionText.trim(),
        correctChoices,
        ...(showTimeLimit ? { timeLimitSecs } : {}),
        ...(editableChoiceText ? { choices } : {}),
      };
      const response = await fetch(`/api/quizzes/${quizId}/questions/${question.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save this question.");
      setQuestionText(data.question);
      setChoices(data.choices);
      setCorrectChoices(data.correctChoices);
      setTimeLimitSecs(data.timeLimitSecs);
      setSavedQuestionText(data.question);
      setSavedChoices(data.choices);
      setSavedCorrectChoices(data.correctChoices);
      setSavedTimeLimitSecs(data.timeLimitSecs);
      setJustSaved(true);
      onSaved({
        question: data.question,
        choices: data.choices,
        correctChoices: data.correctChoices,
        timeLimitSecs: data.timeLimitSecs,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this question.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this question? This can't be undone.")) return;
    setIsDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/quizzes/${quizId}/questions/${question.id}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not delete this question.");
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this question.");
      setIsDeleting(false);
    }
  }

  return (
    <li className="rounded-2xl border border-line p-4 text-sm">
      <label className="flex items-start gap-2">
        <span className="mt-2.5 font-semibold text-ink">{index + 1}.</span>
        <textarea
          value={questionText}
          onChange={(event) => {
            setQuestionText(event.target.value);
            setError(null);
            setJustSaved(false);
          }}
          maxLength={500}
          rows={2}
          className="input-field flex-1 resize-y font-semibold text-ink"
        />
      </label>
      {question.sourceExcerpt && (
        <p className="mt-1 pl-5 text-xs text-ink-soft italic">
          Source: “{question.sourceExcerpt}”
        </p>
      )}
      <p className="mt-1 text-xs text-ink-soft">
        {isMultiSelect ? "Select all correct answers" : "Select the correct answer"}
        {editableChoiceText ? " and edit choice text" : ""}.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {choices.map((choice, choiceIndex) => (
          <li key={choiceIndex} className="flex items-center gap-2">
            <input
              type={isMultiSelect ? "checkbox" : "radio"}
              name={isMultiSelect ? undefined : `answer-${question.id}`}
              checked={correctChoices.includes(choice)}
              onChange={() => toggleCorrect(choice)}
              aria-label={`Mark "${choice}" as a correct answer`}
            />
            {editableChoiceText ? (
              <textarea
                value={choice}
                onChange={(event) => updateChoiceText(choiceIndex, event.target.value)}
                maxLength={200}
                rows={2}
                className="input-field flex-1 resize-y"
              />
            ) : (
              <span className={correctChoices.includes(choice) ? "font-semibold text-ink" : "text-ink-soft"}>
                {choice}
              </span>
            )}
          </li>
        ))}
      </ul>
      {showTimeLimit && (
        <label className="mt-3 flex items-center gap-2 text-xs text-ink-soft">
          Time limit
          <input
            type="number"
            min={MIN_TIME_LIMIT_SECS}
            max={MAX_TIME_LIMIT_SECS}
            value={timeLimitSecs}
            onChange={(event) => {
              setTimeLimitSecs(Number(event.target.value));
              setError(null);
              setJustSaved(false);
            }}
            className="input-field w-20"
          />
          seconds
        </label>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave || isSaving}
          className="btn btn-secondary"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting || !canDelete}
          title={canDelete ? undefined : "A quiz must have at least one question."}
          className="btn btn-secondary text-danger"
        >
          {isDeleting ? "Deleting…" : "Delete"}
        </button>
        {justSaved && !dirty && <span className="text-xs font-semibold text-success">Saved</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </li>
  );
}
