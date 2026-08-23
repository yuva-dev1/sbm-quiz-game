"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StartGameButton } from "./StartGameButton";
import { EditableQuestion } from "./EditableQuestion";
import { AddQuestionForm } from "./AddQuestionForm";

type PublishedQuestion = {
  id: string;
  type: "MULTIPLE_CHOICE" | "TRUE_FALSE" | "SHORT_ANSWER" | "MULTI_SELECT";
  question: string;
  choices: string[];
  correctChoices: string[];
  timeLimitSecs: number;
  sourceExcerpt?: string | null;
};

export function PublishedQuizCard({
  quiz,
}: {
  quiz: { id: string; title: string; questionCount: number; questions: PublishedQuestion[] };
}) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [isKillingSessions, setIsKillingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Lifted out of EditableQuestion so a saved edit survives collapsing and
  // re-expanding the "Review questions" panel. Editing a published quiz's
  // questions is safe for any session already underway — GameSession
  // snapshots question data at creation time, so this only affects
  // sessions started after the edit.
  const [questions, setQuestions] = useState(quiz.questions);

  async function handleDelete() {
    if (!window.confirm(`Delete "${quiz.title}"? This can't be undone.`)) return;
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

  async function handleUnpublish() {
    setIsUnpublishing(true);
    setError(null);
    try {
      const response = await fetch(`/api/quizzes/${quiz.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unpublish: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not unpublish this quiz.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unpublish this quiz.");
      setIsUnpublishing(false);
    }
  }

  async function handleKillSessions() {
    if (
      !window.confirm(
        `End all live sessions of "${quiz.title}"? Anyone still playing will be moved to the final results screen.`
      )
    )
      return;
    setIsKillingSessions(true);
    setError(null);
    try {
      const response = await fetch(`/api/quizzes/${quiz.id}/kill-sessions`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not end this quiz's live sessions.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end this quiz's live sessions.");
    } finally {
      setIsKillingSessions(false);
    }
  }

  return (
    <li className="card flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-serif text-xl text-brand-ink break-words">{quiz.title}</p>
          <p className="text-sm text-ink-soft">
            {questions.length} question
            {questions.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <button type="button" onClick={handleUnpublish} disabled={isUnpublishing} className="btn btn-secondary">
            {isUnpublishing ? "Unpublishing…" : "Unpublish"}
          </button>
          <button
            type="button"
            onClick={handleKillSessions}
            disabled={isKillingSessions}
            className="btn btn-secondary text-danger"
          >
            {isKillingSessions ? "Ending sessions…" : "Kill all live sessions"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            className="btn btn-secondary text-danger"
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </button>
          <StartGameButton quizId={quiz.id} />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="self-start text-sm font-semibold text-brand-ink"
      >
        {expanded ? "Hide questions" : "Review / edit questions"}
      </button>

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
              onDeleted={() => setQuestions((current) => current.filter((q) => q.id !== question.id))}
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
