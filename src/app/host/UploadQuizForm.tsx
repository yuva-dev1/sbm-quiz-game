"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const ACCEPT = ".csv,.tsv,.json,.txt,.md,.pdf,text/csv,application/json,text/plain,application/pdf";

export function UploadQuizForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file to upload first.");
      return;
    }

    setIsUploading(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/quizzes/upload", { method: "POST", body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Could not import that file.");

      const extra = data.usedLlm ? " (extracted with the quiz model — double-check it below)" : "";
      const capped = data.truncated ? ` Only the first ${data.questionCount} were kept.` : "";
      setNotice(
        `Imported "${data.title}" with ${data.questionCount} question${data.questionCount === 1 ? "" : "s"}${extra}.${capped} Review it in Drafts and publish when ready.`
      );
      setFileName(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import that file.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card flex flex-col gap-4 p-6">
      <div>
        <p className="font-serif text-xl text-brand-ink">Upload a quiz</p>
        <p className="text-sm text-ink-soft">
          Turn a file you already have into a playable quiz. Works with CSV/TSV spreadsheets, JSON,
          plain text, and PDFs — as long as it has questions and their answers. Structured files
          (CSV/JSON) are read directly; prose and PDFs are run through the quiz model.
        </p>
      </div>

      <label className="flex flex-col gap-2 text-sm font-semibold text-ink-soft">
        File
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          onChange={(event) => {
            setFileName(event.target.files?.[0]?.name ?? null);
            setError(null);
            setNotice(null);
          }}
          className="text-sm font-normal text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-paper-deep file:px-3 file:py-2 file:text-sm file:font-semibold file:text-brand-ink"
        />
      </label>

      <button type="submit" disabled={isUploading || !fileName} className="btn btn-primary self-start">
        {isUploading ? "Importing…" : "Upload"}
      </button>

      <details className="text-xs text-ink-soft">
        <summary className="cursor-pointer font-semibold">CSV format</summary>
        <p className="mt-2">
          One question per row. Either add a header row with <code>question</code>,{" "}
          <code>correct answer</code>, and <code>option 1…</code> columns, or skip the header and use{" "}
          the order <code>question, correct answer, wrong answer 1, wrong answer 2, …</code>. A{" "}
          <code>type</code> column set to <code>true_false</code> makes a True/False question.
        </p>
      </details>

      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm font-semibold text-success">{notice}</p>}
    </form>
  );
}
