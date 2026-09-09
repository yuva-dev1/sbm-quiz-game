"use client";

import { useState } from "react";
import { MIN_TIME_LIMIT_SECS, MAX_TIME_LIMIT_SECS, DEFAULT_TIME_LIMIT_SECS } from "@/lib/timeLimits";

type QuestionType = "MULTIPLE_CHOICE" | "TRUE_FALSE" | "MULTI_SELECT";

type CreatedQuestion = {
  id: string;
  type: "MULTIPLE_CHOICE" | "TRUE_FALSE" | "SHORT_ANSWER" | "MULTI_SELECT";
  question: string;
  choices: string[];
  correctChoices: string[];
  timeLimitSecs: number;
};

const EMPTY_CHOICES = ["", "", "", ""];

export function AddQuestionForm({
  quizId,
  onCreated,
}: {
  quizId: string;
  onCreated: (question: CreatedQuestion) => void;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [type, setType] = useState<QuestionType>("MULTIPLE_CHOICE");
  const [questionText, setQuestionText] = useState("");
  const [choices, setChoices] = useState(EMPTY_CHOICES);
  const [correctChoices, setCorrectChoices] = useState<string[]>([]);
  const [timeLimitSecs, setTimeLimitSecs] = useState(DEFAULT_TIME_LIMIT_SECS);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMultiSelect = type === "MULTI_SELECT";
  const hasEditableChoices = type === "MULTIPLE_CHOICE" || isMultiSelect;

  const trimmedChoices = choices.map((choice) => choice.trim());
  const choicesValid =
    type === "TRUE_FALSE" || (trimmedChoices.every((choice) => choice !== "") && new Set(trimmedChoices).size === 4);
  const correctValid = isMultiSelect ? correctChoices.length >= 2 : correctChoices.length === 1;
  const timeLimitValid =
    Number.isInteger(timeLimitSecs) && timeLimitSecs >= MIN_TIME_LIMIT_SECS && timeLimitSecs <= MAX_TIME_LIMIT_SECS;
  const canSave = questionText.trim() !== "" && choicesValid && correctValid && timeLimitValid;

  function reset() {
    setType("MULTIPLE_CHOICE");
    setQuestionText("");
    setChoices(EMPTY_CHOICES);
    setCorrectChoices([]);
    setTimeLimitSecs(DEFAULT_TIME_LIMIT_SECS);
    setError(null);
    setIsAdding(false);
  }

  function updateChoiceText(choiceIndex: number, value: string) {
    setError(null);
    setChoices((current) => {
      const previousValue = current[choiceIndex];
      const next = [...current];
      next[choiceIndex] = value;
      // Correct choices are tracked by text — keep them pointing at the same
      // choice as its text is edited underneath them.
      setCorrectChoices((currentCorrect) => currentCorrect.map((c) => (c === previousValue ? value : c)));
      return next;
    });
  }

  function toggleCorrect(choice: string) {
    setError(null);
    if (isMultiSelect) {
      setCorrectChoices((current) =>
        current.includes(choice) ? current.filter((c) => c !== choice) : [...current, choice]
      );
    } else {
      setCorrectChoices([choice]);
    }
  }

  function handleTypeChange(nextType: QuestionType) {
    setType(nextType);
    setCorrectChoices([]);
    setError(null);
  }

  async function handleSave() {
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      const body =
        type === "TRUE_FALSE"
          ? { type, question: questionText.trim(), correctChoices, timeLimitSecs }
          : {
              type,
              question: questionText.trim(),
              choices: trimmedChoices,
              correctChoices,
              timeLimitSecs,
            };
      const response = await fetch(`/api/quizzes/${quizId}/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not add this question.");
      onCreated(data);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this question.");
    } finally {
      setIsSaving(false);
    }
  }

  if (!isAdding) {
    return (
      <li>
        <button type="button" onClick={() => setIsAdding(true)} className="btn btn-secondary">
          Add Question
        </button>
      </li>
    );
  }

  const displayedChoices = type === "TRUE_FALSE" ? ["True", "False"] : choices;
  const answerHint = isMultiSelect
    ? "Select every correct answer (at least two) and edit choice text."
    : type === "MULTIPLE_CHOICE"
      ? "Select the correct answer and enter choice text."
      : "Select the correct answer.";

  return (
    <li className="rounded-2xl border border-line p-4 text-sm">
      <label className="flex items-center gap-2 text-xs text-ink-soft">
        Type
        <select
          value={type}
          onChange={(event) => handleTypeChange(event.target.value as QuestionType)}
          className="input-field w-auto py-1"
        >
          <option value="MULTIPLE_CHOICE">Multiple choice</option>
          <option value="TRUE_FALSE">True / False</option>
          <option value="MULTI_SELECT">Multi-select</option>
        </select>
      </label>

      <textarea
        value={questionText}
        onChange={(event) => {
          setQuestionText(event.target.value);
          setError(null);
        }}
        placeholder="Question text"
        maxLength={500}
        rows={2}
        className="input-field mt-2 w-full resize-y font-semibold text-ink"
      />

      <p className="mt-2 text-xs text-ink-soft">{answerHint}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {displayedChoices.map((choice, choiceIndex) => (
          <li key={choiceIndex} className="flex items-center gap-2">
            <input
              type={isMultiSelect ? "checkbox" : "radio"}
              name={isMultiSelect ? undefined : `new-question-answer-${quizId}`}
              checked={correctChoices.includes(choice) && choice !== ""}
              onChange={() => toggleCorrect(choice)}
              disabled={hasEditableChoices && choice.trim() === ""}
              aria-label={`Mark "${choice || `choice ${choiceIndex + 1}`}" as a correct answer`}
            />
            {hasEditableChoices ? (
              <input
                type="text"
                value={choice}
                onChange={(event) => updateChoiceText(choiceIndex, event.target.value)}
                placeholder={`Choice ${choiceIndex + 1}`}
                maxLength={200}
                className="input-field flex-1"
              />
            ) : (
              <span className={correctChoices.includes(choice) ? "font-semibold text-ink" : "text-ink-soft"}>
                {choice}
              </span>
            )}
          </li>
        ))}
      </ul>

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
          }}
          className="input-field w-20"
        />
        seconds
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={handleSave} disabled={!canSave || isSaving} className="btn btn-primary">
          {isSaving ? "Saving…" : "Save question"}
        </button>
        <button type="button" onClick={reset} disabled={isSaving} className="btn btn-secondary">
          Cancel
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </li>
  );
}
