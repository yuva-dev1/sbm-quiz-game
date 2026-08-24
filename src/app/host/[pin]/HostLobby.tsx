"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createSessionRealtimeClient } from "@/lib/ably-client";
import {
  SessionEvent,
  type AnswerBreakdownPayload,
  type AnswerCountUpdatePayload,
  type LeaderboardEntry,
  type LeaderboardUpdatePayload,
  type PodiumPayload,
  type QuestionLockedPayload,
  type QuestionStartPayload,
  type QuoteDisplayPayload,
  type SettingsUpdatePayload,
} from "@/lib/events";
import { useCountdown } from "@/lib/useCountdown";
import { ANSWER_TILE_COLORS } from "@/lib/answerShapes";
import { QuoteOverlay } from "@/components/QuoteOverlay";
import { Confetti } from "@/components/Confetti";
import type { InboundMessage } from "ably";

type Player = { id: string; nickname: string };

const MEDALS = ["🥇", "🥈", "🥉"];

export function HostLobby({
  pin,
  quizTitle,
  questionCount,
  initialPlayers,
  joinUrl,
  initialStarted,
  initialQuestion,
  initialLocked,
  initialAnsweredCount,
  initialPlayerCount,
  initialPodium,
  initialShowLeaderboard,
  initialShowTimer,
}: {
  pin: string;
  quizTitle: string;
  questionCount: number;
  initialPlayers: Player[];
  joinUrl: string;
  initialStarted: boolean;
  initialQuestion: QuestionStartPayload | null;
  initialLocked: boolean;
  initialAnsweredCount: number;
  initialPlayerCount: number;
  initialPodium: LeaderboardEntry[] | null;
  initialShowLeaderboard: boolean;
  initialShowTimer: boolean;
}) {
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
  const [started, setStarted] = useState(initialStarted);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenPlayerIds = useRef(new Set(initialPlayers.map((player) => player.id)));

  const [question, setQuestion] = useState<QuestionStartPayload | null>(initialQuestion);
  const [locked, setLocked] = useState(initialLocked);
  const [revealedAnswers, setRevealedAnswers] = useState<string[] | null>(null);
  const [answeredCount, setAnsweredCount] = useState(initialAnsweredCount);
  const [playerCount, setPlayerCount] = useState(initialPlayerCount);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const [podium, setPodium] = useState<LeaderboardEntry[] | null>(initialPodium);
  const [isEnding, setIsEnding] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(initialShowLeaderboard);
  const [showTimer, setShowTimer] = useState(initialShowTimer);
  const [isTogglingSettings, setIsTogglingSettings] = useState(false);
  const [answerBreakdown, setAnswerBreakdown] = useState<AnswerBreakdownPayload | null>(null);
  const [activeQuote, setActiveQuote] = useState<QuoteDisplayPayload | null>(null);

  // Sound effects: lobby music loops in the waiting room, a jingle plays each
  // time a question locks, and a fanfare plays once the final results are
  // revealed. Created once in an effect (never during render, per the
  // project's React Compiler purity rule) and driven imperatively — simpler
  // than routing them through React state for a one-shot side effect.
  const lobbyMusicRef = useRef<HTMLAudioElement | null>(null);
  const questionRevealSoundRef = useRef<HTMLAudioElement | null>(null);
  const resultsFanfareRef = useRef<HTMLAudioElement | null>(null);
  const hasPlayedResultsFanfare = useRef(false);

  useEffect(() => {
    const lobbyMusic = new Audio("/audio/lobby-music.mp3");
    lobbyMusic.loop = true;
    lobbyMusic.volume = 0.5;
    lobbyMusicRef.current = lobbyMusic;
    questionRevealSoundRef.current = new Audio("/audio/question-reveal.mp3");
    resultsFanfareRef.current = new Audio("/audio/results-fanfare.mp3");
    return () => {
      lobbyMusic.pause();
    };
  }, []);

  // Stops the instant the quiz starts (first question appears) rather than
  // running through the whole game — it's lobby/waiting-room music, not a
  // game soundtrack.
  useEffect(() => {
    const lobbyMusic = lobbyMusicRef.current;
    if (!lobbyMusic) return;
    if (started) {
      lobbyMusic.pause();
    } else {
      lobbyMusic.play().catch(() => {});
    }
  }, [started]);

  // Browsers reject play() without a prior user gesture on the page — caught
  // and ignored everywhere below since a missed sound effect isn't worth
  // surfacing as an error to the host.
  useEffect(() => {
    if (!podium || hasPlayedResultsFanfare.current) return;
    hasPlayedResultsFanfare.current = true;
    resultsFanfareRef.current?.play().catch(() => {});
  }, [podium]);

  // Lead-time countdown: seconds until answer choices reveal. Reuses
  // useCountdown with startedAt as the base and the lead-time gap (derived
  // from the two server timestamps) as the duration.
  const leadDurationSecs =
    question?.startedAt != null && question?.optionsRevealedAt != null
      ? (question.optionsRevealedAt - question.startedAt) / 1000
      : 0;
  const leadRemaining = useCountdown(question?.startedAt ?? null, leadDurationSecs);
  const optionsVisible = question !== null && leadRemaining <= 0;

  const liveRemaining = useCountdown(question?.optionsRevealedAt ?? null, question?.timeLimitSecs ?? 0);
  // Frozen the instant the question locks (captured in the onQuestionLocked
  // handler below), so the displayed number stops instead of continuing to
  // tick down off the wall clock after answering has closed.
  const [frozenRemaining, setFrozenRemaining] = useState<number | null>(null);
  // Kept in sync via effect (not read during render) so the lock handler
  // below can read the latest value without a stale closure.
  const liveRemainingRef = useRef(liveRemaining);
  useEffect(() => {
    liveRemainingRef.current = liveRemaining;
  }, [liveRemaining]);

  const remaining = locked ? (frozenRemaining ?? liveRemaining) : liveRemaining;
  const isLastQuestion = question !== null && question.questionIndex === questionCount - 1;

  useEffect(() => {
    const client = createSessionRealtimeClient(pin, "host");
    const channel = client.channels.get(`game:${pin}`);

    const onPlayerJoined = (message: InboundMessage) => {
      const data = message.data as { playerId: string; nickname: string; playerCount: number };
      if (!seenPlayerIds.current.has(data.playerId)) {
        seenPlayerIds.current.add(data.playerId);
        setPlayers((prev) => [...prev, { id: data.playerId, nickname: data.nickname }]);
      }
      setPlayerCount(data.playerCount);
    };
    const onQuestionStart = (message: InboundMessage) => {
      const data = message.data as QuestionStartPayload;
      setQuestion(data);
      setLocked(false);
      setRevealedAnswers(null);
      setFrozenRemaining(null);
      setAnsweredCount(0);
      setLeaderboard(null);
      setAnswerBreakdown(null);
      setActiveQuote(null);
    };
    const onQuoteDisplay = (message: InboundMessage) => {
      setActiveQuote(message.data as QuoteDisplayPayload);
    };
    const onAnswerCountUpdate = (message: InboundMessage) => {
      const data = message.data as AnswerCountUpdatePayload;
      setAnsweredCount(data.answeredCount);
      setPlayerCount(data.playerCount);
    };
    const onQuestionLocked = (message: InboundMessage) => {
      const data = message.data as QuestionLockedPayload;
      setLocked(true);
      setFrozenRemaining(liveRemainingRef.current);
      setRevealedAnswers(data.correctChoices);
      const jingle = questionRevealSoundRef.current;
      if (jingle) {
        jingle.currentTime = 0;
        jingle.play().catch(() => {});
      }
    };
    const onLeaderboardUpdate = (message: InboundMessage) => {
      setLeaderboard((message.data as LeaderboardUpdatePayload).leaderboard);
    };
    const onPodium = (message: InboundMessage) => {
      setPodium((message.data as PodiumPayload).podium);
    };
    const onSettingsUpdate = (message: InboundMessage) => {
      const data = message.data as SettingsUpdatePayload;
      setShowLeaderboard(data.showLeaderboard);
      setShowTimer(data.showTimer);
    };
    const onAnswerBreakdown = (message: InboundMessage) => {
      setAnswerBreakdown(message.data as AnswerBreakdownPayload);
    };

    channel.subscribe(SessionEvent.PlayerJoined, onPlayerJoined);
    channel.subscribe(SessionEvent.QuoteDisplay, onQuoteDisplay);
    channel.subscribe(SessionEvent.QuestionStart, onQuestionStart);
    channel.subscribe(SessionEvent.AnswerCountUpdate, onAnswerCountUpdate);
    channel.subscribe(SessionEvent.QuestionLocked, onQuestionLocked);
    channel.subscribe(SessionEvent.LeaderboardUpdate, onLeaderboardUpdate);
    channel.subscribe(SessionEvent.Podium, onPodium);
    channel.subscribe(SessionEvent.SettingsUpdate, onSettingsUpdate);
    channel.subscribe(SessionEvent.AnswerBreakdown, onAnswerBreakdown);

    return () => {
      channel.unsubscribe(SessionEvent.PlayerJoined, onPlayerJoined);
      channel.unsubscribe(SessionEvent.QuoteDisplay, onQuoteDisplay);
      channel.unsubscribe(SessionEvent.QuestionStart, onQuestionStart);
      channel.unsubscribe(SessionEvent.AnswerCountUpdate, onAnswerCountUpdate);
      channel.unsubscribe(SessionEvent.QuestionLocked, onQuestionLocked);
      channel.unsubscribe(SessionEvent.LeaderboardUpdate, onLeaderboardUpdate);
      channel.unsubscribe(SessionEvent.Podium, onPodium);
      channel.unsubscribe(SessionEvent.SettingsUpdate, onSettingsUpdate);
      channel.unsubscribe(SessionEvent.AnswerBreakdown, onAnswerBreakdown);
      client.close();
    };
  }, [pin]);

  // No auto-clear timer here — the quote stays up until the host clicks
  // "Next" (see handleNextQuote), which reveals the question and the
  // resulting question_start broadcast is what actually clears activeQuote
  // (see onQuestionStart above).

  // Auto-lock once the host's own countdown hits zero, so the UI moves on
  // even if no one clicks "Lock Now". The server deadline is authoritative
  // either way (Story 3.3) — but only when the timer is on. With it off,
  // this is a free-time question: only "Lock Now" (or Next Question, via
  // the lock endpoint's own callers) ends it.
  useEffect(() => {
    if (showTimer && question && remaining === 0 && !locked) {
      fetch(`/api/sessions/${pin}/lock`, { method: "POST" }).catch(() => {});
    }
  }, [remaining, question, pin, locked, showTimer]);

  async function handleStart() {
    setIsStarting(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${pin}/start`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start the game.");
      setStarted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the game.");
    } finally {
      setIsStarting(false);
    }
  }

  async function handleNext() {
    setIsAdvancing(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${pin}/next`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not advance the question.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not advance the question.");
    } finally {
      setIsAdvancing(false);
    }
  }

  async function handleLock() {
    await fetch(`/api/sessions/${pin}/lock`, { method: "POST" }).catch(() => {});
  }

  async function handleNextQuote() {
    // Doesn't clear activeQuote optimistically — the resulting
    // question_start broadcast (see onQuestionStart above) is what actually
    // clears it, for every client including the host, so a failed request
    // here doesn't leave the quote overlay covering a question that never started.
    await fetch(`/api/sessions/${pin}/reveal-question`, { method: "POST" }).catch(() => {});
  }

  async function handleToggleSetting(setting: "showLeaderboard" | "showTimer") {
    const next = setting === "showLeaderboard" ? !showLeaderboard : !showTimer;
    setIsTogglingSettings(true);
    try {
      const response = await fetch(`/api/sessions/${pin}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [setting]: next }),
      });
      if (response.ok) {
        if (setting === "showLeaderboard") setShowLeaderboard(next);
        else setShowTimer(next);
      }
    } catch {
      // Ably's SettingsUpdate broadcast is the fallback source of truth if this request fails.
    } finally {
      setIsTogglingSettings(false);
    }
  }

  async function handleEndGame() {
    if (!window.confirm("End this game for everyone and show the final results?")) return;
    await revealResults();
  }

  // Shared by the last-question "Reveal Results" button and the "End Game"
  // early-termination button — both just finalize the session (see
  // finalizeSession in src/lib/leaderboard.ts) via the same endpoint.
  async function revealResults() {
    setIsEnding(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${pin}/end`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not reveal the results.");
      if (data.podium) setPodium(data.podium);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reveal the results.");
    } finally {
      setIsEnding(false);
    }
  }

  // Available on every host screen — pin-sharing, mid-question, and podium —
  // so the host is never stuck without a way back to /host. A normal
  // in-flow button at the bottom, not fixed, so it never overlaps content.
  const endGameButton = (
    <button
      type="button"
      onClick={handleEndGame}
      disabled={isEnding}
      className="btn btn-secondary text-danger"
    >
      {isEnding ? "Ending…" : "End Game"}
    </button>
  );

  if (podium) {
    return (
      <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-8 px-6 text-center lg:max-w-2xl xl:max-w-3xl">
        <Confetti />
        {activeQuote && (
          <QuoteOverlay quote={activeQuote.quote} attribution={activeQuote.attribution} onNext={handleNextQuote} />
        )}
        <span className="pill-badge">{quizTitle}</span>
        {showLeaderboard ? (
          <>
            <h1 className="text-5xl">Final Results</h1>
            <p className="pill-badge">Game has ended</p>
          </>
        ) : (
          <h1 className="text-4xl">Radhe Radhe! Game has ended!</h1>
        )}
        {showLeaderboard ? (
          <ol className="flex w-full flex-col gap-3">
            {podium.map((entry) => (
              <li key={entry.playerId} className="card flex items-center justify-between gap-4 px-6 py-5">
                <span className="flex items-center gap-3 font-serif text-xl text-brand-ink">
                  <span className="text-2xl">{MEDALS[entry.rank - 1] ?? `#${entry.rank}`}</span>
                  {entry.nickname}
                </span>
                <span className="font-serif text-2xl font-bold text-brand">{entry.points}</span>
              </li>
            ))}
          </ol>
        ) : (
          // Leaderboard was off for the last question — keep names/points/
          // rank off the host's own screen too, not just the players', since
          // this is often what's projected for the whole room.
          <p className="card px-6 py-5 text-ink-soft">
            {playerCount} player{playerCount === 1 ? "" : "s"} played — results were kept private (leaderboard was off).
          </p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <Link href="/host" className="btn btn-primary">
          Go back to home page
        </Link>
      </div>
    );
  }

  if (started && question) {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center gap-6 px-6 py-16 text-center lg:max-w-5xl xl:max-w-6xl">
        {activeQuote && (
          <QuoteOverlay quote={activeQuote.quote} attribution={activeQuote.attribution} onNext={handleNextQuote} />
        )}
        <div className="flex w-full items-center justify-between gap-3">
          <span className="pill-badge">
            Question {question.questionIndex + 1} of {questionCount}
          </span>
          <div className="flex items-center gap-3 text-xs font-semibold text-ink-soft">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showLeaderboard}
                disabled={isTogglingSettings}
                onChange={() => handleToggleSetting("showLeaderboard")}
              />
              Leaderboard
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showTimer}
                disabled={isTogglingSettings}
                onChange={() => handleToggleSetting("showTimer")}
              />
              Timer
            </label>
          </div>
        </div>
        <h1 className="max-w-2xl text-4xl break-words lg:max-w-4xl">{question.question}</h1>
        {!optionsVisible ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs font-bold tracking-wide text-ink-soft uppercase">Get Ready</p>
            <p className="font-serif text-8xl font-bold text-brand">{leadRemaining}</p>
          </div>
        ) : (
          <>
            {showTimer && <p className="font-serif text-6xl font-bold text-brand">{remaining}</p>}
            <ul className="grid w-full grid-cols-2 gap-3">
              {question.choices.map((choice, index) => {
                const isRevealed = revealedAnswers !== null;
                const isCorrect = isRevealed && revealedAnswers.includes(choice);
                return (
                  <li
                    key={index}
                    className={`flex min-w-0 items-center gap-3 rounded-2xl px-5 py-4 text-left text-2xl font-semibold text-white shadow-lg transition-all duration-500 md:text-3xl ${
                      isRevealed && !isCorrect ? "opacity-30" : ""
                    } ${isCorrect ? "ring-4 ring-success" : ""}`}
                    style={{ backgroundColor: ANSWER_TILE_COLORS[index % ANSWER_TILE_COLORS.length] }}
                  >
                    <span className="answer-tile-text min-w-0 break-words">{choice}</span>
                    {isCorrect && <span className="ml-1">✓</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="pill-badge">
          {answeredCount} / {playerCount} answered
        </p>

        {locked && answerBreakdown && (answerBreakdown.correctCount > 0 || answerBreakdown.incorrectCount > 0) && (
          <div className="w-full max-w-sm lg:max-w-md">
            <p className="mb-2 text-sm font-bold tracking-wide text-ink-soft uppercase">Correct vs Incorrect</p>
            {(() => {
              const total = answerBreakdown.correctCount + answerBreakdown.incorrectCount;
              const correctPct = Math.round((answerBreakdown.correctCount / total) * 100);
              const incorrectPct = 100 - correctPct;
              return (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-left text-sm font-semibold text-success">Correct</span>
                    <div className="h-6 flex-1 overflow-hidden rounded-full bg-paper-deep">
                      <div
                        className="h-full rounded-full bg-success transition-all duration-500"
                        style={{ width: `${correctPct}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-sm font-semibold">{answerBreakdown.correctCount}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-left text-sm font-semibold text-danger">Incorrect</span>
                    <div className="h-6 flex-1 overflow-hidden rounded-full bg-paper-deep">
                      <div
                        className="h-full rounded-full bg-danger transition-all duration-500"
                        style={{ width: `${incorrectPct}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-sm font-semibold">{answerBreakdown.incorrectCount}</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {locked && answerBreakdown && answerBreakdown.choiceCounts.some((count) => count > 0) && (
          <div className="w-full max-w-sm lg:max-w-md">
            <p className="mb-2 text-sm font-bold tracking-wide text-ink-soft uppercase">Answers by Choice</p>
            {(() => {
              const maxCount = Math.max(...answerBreakdown.choiceCounts, 1);
              return (
                <div className="flex h-32 items-end justify-center gap-3">
                  {answerBreakdown.choiceCounts.map((count, index) => (
                    <div key={index} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                      <span className="text-xs font-semibold text-ink-soft">{count}</span>
                      <div
                        className="w-full rounded-t-lg transition-all duration-500"
                        style={{
                          height: `${(count / maxCount) * 100}%`,
                          minHeight: count > 0 ? "6%" : "2%",
                          backgroundColor: ANSWER_TILE_COLORS[index % ANSWER_TILE_COLORS.length],
                        }}
                      />
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {showLeaderboard && locked && leaderboard && (
          <div className="w-full max-w-sm lg:max-w-md">
            <p className="mb-2 text-sm font-bold tracking-wide text-ink-soft uppercase">Top 10</p>
            <ol className="flex flex-col gap-2">
              {leaderboard.map((entry) => (
                <li key={entry.playerId} className="card flex items-center justify-between gap-3 px-5 py-3">
                  <span className="flex items-center gap-3 font-medium text-brand-ink">
                    <span className="w-6 text-lg">{MEDALS[entry.rank - 1] ?? `#${entry.rank}`}</span>
                    {entry.nickname}
                  </span>
                  <span className="font-serif text-lg font-bold text-brand">{entry.points}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {locked ? (
          isLastQuestion ? (
            <button type="button" onClick={revealResults} disabled={isEnding} className="btn btn-primary">
              {isEnding ? "Revealing…" : "Reveal Results"}
            </button>
          ) : (
            <button type="button" onClick={handleNext} disabled={isAdvancing} className="btn btn-primary">
              {isAdvancing ? "Loading…" : "Next Question"}
            </button>
          )
        ) : (
          <button type="button" onClick={handleLock} className="btn btn-secondary">
            Lock Now
          </button>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        {endGameButton}
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center gap-8 px-6 py-16 text-center lg:max-w-4xl xl:max-w-5xl">
      {activeQuote && <QuoteOverlay quote={activeQuote.quote} attribution={activeQuote.attribution} />}
      <div>
        <span className="pill-badge">{quizTitle}</span>
        <p className="mt-3 text-sm text-ink-soft">Join at {joinUrl}</p>
      </div>
      <p className="font-serif text-8xl font-bold tracking-widest text-brand">{pin}</p>

      {started ? (
        <button type="button" onClick={handleNext} disabled={isAdvancing} className="btn btn-primary">
          {isAdvancing ? "Loading…" : "Next Question"}
        </button>
      ) : (
        <button type="button" onClick={handleStart} disabled={players.length === 0 || isStarting} className="btn btn-primary">
          {isStarting ? "Starting…" : "Start Game"}
        </button>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="w-full">
        <p className="mb-3 text-sm font-bold tracking-wide text-ink-soft uppercase">
          {players.length} player{players.length === 1 ? "" : "s"} joined
        </p>
        <ul className="flex flex-wrap justify-center gap-2">
          {players.map((player) => (
            <li key={player.id} className="pill-badge">
              {player.nickname}
            </li>
          ))}
        </ul>
      </div>

      {endGameButton}
    </div>
  );
}
