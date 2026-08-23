"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getPlayerSession, savePlayerSession } from "@/lib/playerSession";

export default function JoinPage() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [nickname, setNickname] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [isNoSession, setIsNoSession] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsJoining(true);
    setError(null);
    try {
      // Already joined this PIN this session (refreshed, went back, or
      // reconnected after a dropped connection) — reuse the existing
      // Player record instead of creating a duplicate (Story 7.1).
      const existing = getPlayerSession(pin);
      if (existing) {
        router.push(
          `/play/${pin}?playerId=${existing.playerId}&nickname=${encodeURIComponent(existing.nickname)}`
        );
        return;
      }

      const response = await fetch("/api/players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, nickname }),
      });
      if (response.status === 409) {
        setIsFull(true);
        setIsJoining(false);
        return;
      }
      if (response.status === 404) {
        setIsNoSession(true);
        setIsJoining(false);
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not join.");
      savePlayerSession(pin, { playerId: data.playerId, nickname: data.nickname });
      router.push(`/play/${pin}?playerId=${data.playerId}&nickname=${encodeURIComponent(data.nickname)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join.");
      setIsJoining(false);
    }
  }

  if (isFull) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
        <span className="text-6xl" aria-hidden>
          😢
        </span>
        <div>
          <h1 className="text-3xl">Max Players Reached!</h1>
          <p className="mt-2 text-ink-soft">Sorry about that — this game is already full. Ask the host to start a new one.</p>
        </div>
        <button type="button" onClick={() => setIsFull(false)} className="btn btn-primary">
          Try another PIN
        </button>
      </div>
    );
  }

  if (isNoSession) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
        <span className="text-6xl" aria-hidden>
          🕰️
        </span>
        <div>
          <h1 className="text-3xl">No session currently active!</h1>
          <p className="mt-2 text-ink-soft">Please try again later.</p>
        </div>
        <button type="button" onClick={() => setIsNoSession(false)} className="btn btn-primary">
          Try another PIN
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 text-center">
      <div>
        <span className="pill-badge">Join</span>
        <h1 className="mt-3 text-4xl">Enter the game</h1>
      </div>
      <form onSubmit={handleSubmit} className="card flex w-full max-w-xs flex-col gap-4 p-7">
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          placeholder="Game PIN"
          inputMode="numeric"
          maxLength={6}
          className="input-field text-center font-serif text-2xl tracking-widest text-brand-ink"
          required
        />
        <input
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="Nickname"
          maxLength={30}
          className="input-field text-center text-lg"
          required
        />
        <button type="submit" disabled={isJoining} className="btn btn-primary w-full">
          {isJoining ? "Joining…" : "Join"}
        </button>
        {error && <p className="text-center text-sm text-danger">{error}</p>}
      </form>
    </div>
  );
}
