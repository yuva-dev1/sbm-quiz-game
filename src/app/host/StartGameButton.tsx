"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startLobbyMusic, stopLobbyMusic } from "@/lib/lobbyMusic";

export function StartGameButton({ quizId }: { quizId: string }) {
  const router = useRouter();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    // Must be the first thing that happens in this handler — browsers only
    // reliably allow audio-with-sound autoplay when play() runs synchronously
    // inside the user gesture itself (see src/lib/lobbyMusic.ts).
    startLobbyMusic();
    setIsStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quizId }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to start the game.");
      }
      router.push(`/host/${data.pin}`);
    } catch (err) {
      stopLobbyMusic();
      setError(err instanceof Error ? err.message : "Failed to start the game.");
      setIsStarting(false);
    }
  }

  return (
    <div className="flex flex-shrink-0 flex-col items-end gap-1">
      <button type="button" onClick={handleClick} disabled={isStarting} className="btn btn-primary">
        {isStarting ? "Starting…" : "Start Live Game"}
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
