"use client";

import { useState } from "react";

type SessionHistoryEntry = {
  sessionId: string;
  pin: string;
  playedAt: string;
  playerCount: number;
  topPlayers: { playerId: string; nickname: string; rank: number; totalPoints: number }[];
};

const MEDALS = ["🥇", "🥈", "🥉"];

function formatPlayedAt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function QuizHistoryPanel({ quizId }: { quizId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionHistoryEntry[] | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (sessions !== null) return; // already loaded once — no need to refetch on re-expand
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/quizzes/${quizId}/history`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load history.");
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load history.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteSession(session: SessionHistoryEntry) {
    if (!window.confirm(`Delete the game played ${formatPlayedAt(session.playedAt)} (PIN ${session.pin})? This can't be undone.`))
      return;
    setDeletingSessionId(session.sessionId);
    setError(null);
    try {
      const response = await fetch(`/api/quizzes/${quizId}/history/${session.sessionId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not delete this game.");
      setSessions((current) => (current ?? []).filter((s) => s.sessionId !== session.sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this game.");
    } finally {
      setDeletingSessionId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={toggle} className="self-start text-sm font-semibold text-brand-ink">
        {expanded ? "Hide history" : "History"}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3">
          {loading && <p className="text-sm text-ink-soft">Loading past games…</p>}
          {error && <p className="text-sm text-danger">{error}</p>}
          {sessions !== null && sessions.length === 0 && (
            <p className="text-sm text-ink-soft">No completed games yet.</p>
          )}
          {sessions !== null && sessions.length > 0 && (
            <ol className="flex flex-col gap-4">
              {sessions.map((session) => (
                <li key={session.sessionId} className="card flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-brand-ink">{formatPlayedAt(session.playedAt)}</p>
                    <div className="flex items-center gap-3">
                      <p className="text-xs text-ink-soft">
                        PIN {session.pin} &middot; {session.playerCount} player
                        {session.playerCount === 1 ? "" : "s"}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleDeleteSession(session)}
                        disabled={deletingSessionId === session.sessionId}
                        className="text-xs font-semibold text-danger"
                      >
                        {deletingSessionId === session.sessionId ? "Deleting…" : "Delete game"}
                      </button>
                    </div>
                  </div>
                  {session.topPlayers.length === 0 ? (
                    <p className="text-sm text-ink-soft">No players finished this game.</p>
                  ) : (
                    <ol className="flex flex-col gap-1">
                      {session.topPlayers.map((player) => (
                        <li key={player.playerId} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-brand-ink">
                            {MEDALS[player.rank - 1] ?? `#${player.rank}`} {player.nickname}
                          </span>
                          <span className="font-semibold text-brand">{player.totalPoints}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
