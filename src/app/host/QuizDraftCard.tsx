"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EditableQuestion } from "./EditableQuestion";
import { AddQuestionForm } from "./AddQuestionForm";

type DraftQuestion = {
  id: string;
  type: "MULTIPLE_CHOICE" | "TRUE_FALSE" | "SHORT_ANSWER" | "MULTI_SELECT";
  question: string;
  choices: string[];
  correctChoices: string[];
  timeLimitSecs: number;
};

export function QuizDraftCard({
  quiz,
}: {
  quiz: {
    id: string;
    title: string;
    questions: DraftQuestion[];
    showLeaderboardDefault: boolean;
    showTimerDefault: boolean;
    scoringMode: "SPEED" | "ACCURACY";
    leadTimeSecs: number;
  };
}) {
  const router = useRouter();
  const [title, setTitle] = useState(quiz.title);
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Lifted out of EditableQuestion so a saved edit survives collapsing and
  // re-expanding the "Preview questions" panel.
  const [questions, setQuestions] = useState(quiz.questions);
  const [showLeaderboardDefault, setShowLeaderboardDefault] = useState(quiz.showLeaderboardDefault);
  const [showTimerDefault, setShowTimerDefault] = useState(quiz.showTimerDefault);
  const [scoringMode, setScoringMode] = useState(quiz.scoringMode);
  const [leadTimeSecs, setLeadTimeSecs] = useState(quiz.leadTimeSecs);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  async function patch(body: {
    title?: string;
    publish?: boolean;
    showLeaderboardDefault?: boolean;
    showTimerDefault?: boolean;
    scoringMode?: "SPEED" | "ACCURACY";
    leadTimeSecs?: number;
  }) {
    const response = await fetch(`/api/quizzes/${quiz.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Something went wrong.");
    return data;
  }

  async function handleSaveName() {
    setIsSaving(true);
    setError(null);
    try {
      await patch({ title });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the name.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handlePublish() {
    setIsPublishing(true);
    setError(null);
    try {
      await patch({ title, publish: true });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish this quiz.");
      setIsPublishing(false);
    }
  }

  async function handleSettingsChange(next: {
    showLeaderboardDefault?: boolean;
    showTimerDefault?: boolean;
    scoringMode?: "SPEED" | "ACCURACY";
    leadTimeSecs?: number;
  }) {
    const prev = { showLeaderboardDefault, showTimerDefault, scoringMode, leadTimeSecs };
    if (next.showLeaderboardDefault !== undefined) setShowLeaderboardDefault(next.showLeaderboardDefault);
    if (next.showTimerDefault !== undefined) setShowTimerDefault(next.showTimerDefault);
    if (next.scoringMode !== undefined) setScoringMode(next.scoringMode);
    if (next.leadTimeSecs !== undefined) setLeadTimeSecs(next.leadTimeSecs);
    setIsSavingSettings(true);
    setError(null);
    try {
      await patch(next);
    } catch (err) {
      setShowLeaderboardDefault(prev.showLeaderboardDefault);
      setShowTimerDefault(prev.showTimerDefault);
      setScoringMode(prev.scoringMode);
      setLeadTimeSecs(prev.leadTimeSecs);
      setError(err instanceof Error ? err.message : "Could not save that setting.");
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${title}"? This can't be undone.`)) return;
    setIsDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/quizzes/${quiz.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not delete this quiz.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this quiz.");
      setIsDeleting(false);
    }
  }

  return (
    <li className="card flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          className="input-field flex-1 min-w-[12rem]"
        />
        <button type="button" onClick={handleSaveName} disabled={isSaving} className="btn btn-secondary">
          {isSaving ? "Saving…" : "Save name"}
        </button>
        <button type="button" onClick={handlePublish} disabled={isPublishing} className="btn btn-primary">
          {isPublishing ? "Publishing…" : "Publish"}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting}
          className="btn btn-secondary text-danger"
        >
          {isDeleting ? "Deleting…" : "Delete"}
        </button>
      </div>

      <div className="flex items-center justify-between text-sm text-ink-soft">
        <span>
          {questions.length} question{questions.length === 1 ? "" : "s"} · Draft
        </span>
        <button type="button" onClick={() => setExpanded((v) => !v)} className="font-semibold text-brand-ink">
          {expanded ? "Hide questions" : "Preview questions"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showLeaderboardDefault}
            disabled={isSavingSettings}
            onChange={(event) => handleSettingsChange({ showLeaderboardDefault: event.target.checked })}
          />
          Show leaderboard
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showTimerDefault}
            disabled={isSavingSettings}
            onChange={(event) => handleSettingsChange({ showTimerDefault: event.target.checked })}
          />
          Show timer
        </label>
        <label className="flex items-center gap-2">
          Scoring:
          <select
            value={scoringMode}
            disabled={isSavingSettings}
            onChange={(event) => handleSettingsChange({ scoringMode: event.target.value as "SPEED" | "ACCURACY" })}
            className="input-field w-auto py-1"
          >
            <option value="SPEED">Speed (faster = more points)</option>
            <option value="ACCURACY">Accuracy only (correct = full points)</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Lead time (secs):
          <input
            type="number"
            min={0}
            max={30}
            value={leadTimeSecs}
            disabled={isSavingSettings}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= 30) {
                handleSettingsChange({ leadTimeSecs: value });
              }
            }}
            className="input-field w-16 py-1"
          />
        </label>
      </div>

      {expanded && (
        <ol className="flex flex-col gap-3">
          {questions.map((question, index) => (
            <EditableQuestion
              key={question.id}
              quizId={quiz.id}
              question={question}
              index={index}
              canDelete={questions.length > 1}
              onSaved={(updated) =>
                setQuestions((current) =>
                  current.map((q) => (q.id === question.id ? { ...q, ...updated } : q))
                )
              }
              onDeleted={() =>
                setQuestions((current) => current.filter((q) => q.id !== question.id))
              }
            />
          ))}
          <AddQuestionForm
            quizId={quiz.id}
            onCreated={(created) => setQuestions((current) => [...current, created])}
          />
        </ol>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </li>
  );
}
