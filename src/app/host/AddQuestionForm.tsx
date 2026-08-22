"use client";

import { useState } from "react";
import { MIN_TIME_LIMIT_SECS, MAX_TIME_LIMIT_SECS, DEFAULT_TIME_LIMIT_SECS } from "@/lib/timeLimits";

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
  const [type, setType] = useState<"MULTIPLE_CHOICE" | "TRUE_FALSE">("MULTIPLE_CHOICE");
  const [questionText, setQuestionText] = useState("");
  const [choices, setChoices] = useState(EMPTY_CHOICES);
  const [correctChoice, setCorrectChoice] = useState("");
  const [timeLimitSecs, setTimeLimitSecs] = useState(DEFAULT_TIME_LIMIT_SECS);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedChoices = choices.map((choice) => choice.trim());
  const choicesValid =
    type === "TRUE_FALSE" || (trimmedChoices.every((choice) => choice !== "") && new Set(trimmedChoices).size === 4);
  const timeLimitValid =
    Number.isInteger(timeLimitSecs) && timeLimitSecs >= MIN_TIME_LIMIT_SECS && timeLimitSecs <= MAX_TIME_LIMIT_SECS;
  const canSave = questionText.trim() !== "" && choicesValid && correctChoice !== "" && timeLimitValid;

  function reset() {
    setType("MULTIPLE_CHOICE");
    setQuestionText("");
    setChoices(EMPTY_CHOICES);
    setCorrectChoice("");
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
      if (correctChoice === previousValue) setCorrectChoice(value);
      return next;
    });
  }

  function handleTypeChange(nextType: "MULTIPLE_CHOICE" | "TRUE_FALSE") {
    setType(nextType);
    setCorrectChoice("");
    setError(null);
  }

  async function handleSave() {
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      const body =
        type === "TRUE_FALSE"
          ? { type, question: questionText.trim(), correctChoices: [correctChoice], timeLimitSecs }
          : {
              type,
              question: questionText.trim(),
              choices: trimmedChoices,
              correctChoices: [correctChoice],
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

  return (
    <li className="rounded-2xl border border-line p-4 text-sm">
      <label className="flex items-center gap-2 text-xs text-ink-soft">
        Type
        <select
          value={type}
          onChange={(event) => handleTypeChange(event.target.value as "MULTIPLE_CHOICE" | "TRUE_FALSE")}
          className="input-field w-auto py-1"
        >
          <option value="MULTIPLE_CHOICE">Multiple choice</option>
          <option value="TRUE_FALSE">True / False</option>
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

      <p className="mt-2 text-xs text-ink-soft">Select the correct answer{type === "MULTIPLE_CHOICE" ? " and enter choice text" : ""}.</p>
      <ul className="mt-2 flex flex-col gap-2">
        {displayedChoices.map((choice, choiceIndex) => (
          <li key={choiceIndex} className="flex items-center gap-2">
            <input
              type="radio"
              name={`new-question-answer-${quizId}`}
              checked={type === "TRUE_FALSE" ? correctChoice === choice : correctChoice === choice && choice !== ""}
              onChange={() => setCorrectChoice(choice)}
              disabled={type === "MULTIPLE_CHOICE" && choice.trim() === ""}
              aria-label={`Mark "${choice || `choice ${choiceIndex + 1}`}" as the correct answer`}
            />
            {type === "MULTIPLE_CHOICE" ? (
              <input
                type="text"
                value={choice}
                onChange={(event) => updateChoiceText(choiceIndex, event.target.value)}
                placeholder={`Choice ${choiceIndex + 1}`}
                maxLength={200}
                className="input-field flex-1"
              />
            ) : (
              <span className={correctChoice === choice ? "font-semibold text-ink" : "text-ink-soft"}>{choice}</span>
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
