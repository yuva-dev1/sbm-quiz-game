"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeToSession } from "@/lib/sessionBroadcastClient";
import {
  SessionEvent,
  type AnswerBreakdownPayload,
  type LeaderboardEntry,
  type LeaderboardUpdatePayload,
  type PodiumPayload,
  type QuestionLockedPayload,
  type QuestionStartPayload,
  type QuoteDisplayPayload,
  type SettingsUpdatePayload,
} from "@/lib/events";
import { measureLatency } from "@/lib/latency";
import { useCountdown } from "@/lib/useCountdown";
import { ANSWER_TILE_COLORS } from "@/lib/answerShapes";
import { QuoteOverlay } from "@/components/QuoteOverlay";
import { savePlayerSession } from "@/lib/playerSession";
import { Confetti } from "@/components/Confetti";

const LATENCY_REFRESH_MS = 45_000;
const MEDALS = ["🥇", "🥈", "🥉"];

type MyRank = { rank: number; points: number; totalPlayers: number; correctCount: number; answeredCount: number };

export function PlayerLobby({
  pin,
  playerId,
  nickname,
  initialBroadcastSeq,
  questionCount,
  initialGameStarted,
  initialPodium,
  initialQuestion,
  initialLocked,
  initialMyChoices,
  initialRevealedAnswers,
  initialOptionsVisible,
  initialShowLeaderboard,
  initialShowTimer,
}: {
  pin: string;
  playerId: string;
  nickname: string;
  initialBroadcastSeq: number;
  questionCount: number;
  initialGameStarted: boolean;
  initialPodium: LeaderboardEntry[] | null;
  initialQuestion: QuestionStartPayload | null;
  initialLocked: boolean;
  initialMyChoices: number[];
  initialRevealedAnswers: string[] | null;
  initialOptionsVisible: boolean;
  initialShowLeaderboard: boolean;
  initialShowTimer: boolean;
}) {
  const [gameStarted, setGameStarted] = useState(initialGameStarted);
  const [question, setQuestion] = useState<QuestionStartPayload | null>(initialQuestion);
  const [locked, setLocked] = useState(initialLocked);
  const [revealedAnswers, setRevealedAnswers] = useState<string[] | null>(initialRevealedAnswers);
  // Submitted choices (locks the answer in). Separate from `selectedIndices`
  // below, which tracks in-progress multi-select taps before submission.
  const [myChoices, setMyChoices] = useState<number[]>(initialMyChoices);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [myRank, setMyRank] = useState<MyRank | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const [podium, setPodium] = useState<LeaderboardEntry[] | null>(initialPodium);
  const [showLeaderboard, setShowLeaderboard] = useState(initialShowLeaderboard);
  const [showTimer, setShowTimer] = useState(initialShowTimer);
  const [activeQuote, setActiveQuote] = useState<QuoteDisplayPayload | null>(null);
  const [answerBreakdown, setAnswerBreakdown] = useState<AnswerBreakdownPayload | null>(null);
  // Whether the choice grid should actually be visible. Deliberately NOT
  // derived inline from Date.now() during render — that raced between the
  // server's render-time snapshot and the client's later hydration-time
  // snapshot and could let the grid flash visible for a frame before
  // settling back to hidden. Instead this is seeded from a value the server
  // computed once (initialOptionsVisible) and from then on is only ever
  // flipped by the effect below, which runs client-side post-commit.
  const [optionsVisible, setOptionsVisible] = useState(initialOptionsVisible);

  const isMultiSelect = question?.type === "MULTI_SELECT";

  const leadDurationSecs =
    question?.startedAt != null && question?.optionsRevealedAt != null
      ? (question.optionsRevealedAt - question.startedAt) / 1000
      : 0;
  const leadRemaining = useCountdown(question?.startedAt ?? null, leadDurationSecs);

  const remaining = useCountdown(question?.optionsRevealedAt ?? null, question?.timeLimitSecs ?? 0);

  // Schedules the exact client-side moment the grid becomes visible, rather
  // than polling Date.now() on every render (see optionsVisible's comment
  // above). Reacts to the question itself so every new question_start
  // re-schedules against its own optionsRevealedAt. The hide side of this
  // (a new question arriving) is handled synchronously in onQuestionStart
  // below, not here — this effect only ever needs to schedule the reveal,
  // always via the setTimeout callback rather than a direct call, even for
  // an already-elapsed lead time (delay clamped to 0).
  useEffect(() => {
    if (!question || question.optionsRevealedAt === null) return;
    const msUntilReveal = question.optionsRevealedAt - Date.now();
    const timer = setTimeout(() => setOptionsVisible(true), Math.max(0, msUntilReveal));
    return () => clearTimeout(timer);
  }, [question]);

  // Keep sessionStorage in sync even when this page was reached directly
  // (a shared link, a bookmark) rather than through /join, so a later
  // refresh or re-visit to /join for this PIN still re-associates instead
  // of creating a duplicate Player (Story 7.1).
  useEffect(() => {
    savePlayerSession(pin, { playerId, nickname });
  }, [pin, playerId, nickname]);

  // Back/forward navigation during a live game (accidental swipe-back,
  // trackpad gesture) can land on a stale bfcache'd render of this screen —
  // force a full reload instead so state always comes fresh from the server.
  useEffect(() => {
    function handlePopState() {
      window.location.reload();
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Synchronous re-entrancy guard for submitChoices — see its own comment
  // for why a React-state-based check alone isn't quite enough.
  const submittingRef = useRef(false);

  useEffect(() => {
    return subscribeToSession(pin, initialBroadcastSeq, ({ name, data }) => {
      switch (name) {
        case SessionEvent.GameStarted:
          setGameStarted(true);
          break;
        case SessionEvent.QuoteDisplay:
          setActiveQuote(data as QuoteDisplayPayload);
          break;
        case SessionEvent.QuestionStart:
          setQuestion(data as QuestionStartPayload);
          setLocked(false);
          setRevealedAnswers(null);
          setMyChoices([]);
          setSelectedIndices([]);
          setSubmitError(null);
          setMyRank(null);
          setLeaderboard(null);
          setActiveQuote(null);
          setAnswerBreakdown(null);
          // Hide immediately (same commit as the new question) — the effect
          // above only handles scheduling the eventual reveal, not this reset.
          setOptionsVisible(false);
          submittingRef.current = false;
          break;
        case SessionEvent.QuestionLocked:
          setLocked(true);
          setRevealedAnswers((data as QuestionLockedPayload).correctChoices);
          break;
        case SessionEvent.LeaderboardUpdate:
          setLeaderboard((data as LeaderboardUpdatePayload).leaderboard);
          break;
        case SessionEvent.Podium:
          setPodium((data as PodiumPayload).podium);
          break;
        case SessionEvent.SettingsUpdate:
          setShowLeaderboard((data as SettingsUpdatePayload).showLeaderboard);
          setShowTimer((data as SettingsUpdatePayload).showTimer);
          break;
        case SessionEvent.AnswerBreakdown:
          setAnswerBreakdown(data as AnswerBreakdownPayload);
          break;
      }
    });
  }, [pin, initialBroadcastSeq]);

  // No auto-clear timer here — the quote stays up until the host reveals
  // the question, and the resulting question_start broadcast is what
  // actually clears activeQuote (see onQuestionStart above).

  // Story 5.2: fetch our own rank once a question locks — a plain
  // authenticated GET is as private as this needs to be (see the rank
  // route's own comment for why this beats a per-player realtime channel). This
  // still backs the mid-question "Your rank" line further down — it's a
  // separate feature from the end-of-game screen, which no longer shows rank.
  useEffect(() => {
    if (!locked) return;
    let cancelled = false;
    fetch(`/api/sessions/${pin}/rank?playerId=${playerId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.rank !== null) setMyRank(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [locked, pin, playerId]);

  useEffect(() => {
    let cancelled = false;

    async function reportLatency() {
      const latency = await measureLatency();
      if (cancelled) return;
      await fetch(`/api/players/${playerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimatedLatencyMs: Math.round(latency) }),
      });
    }

    reportLatency();
    const interval = setInterval(reportLatency, LATENCY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [playerId]);

  async function submitChoices(indices: number[]) {
    // submittingRef is checked-and-set synchronously, before any state
    // reads/updates, so two taps landing before a re-render commits the
    // disabled state to the DOM (a fast double-tap, a stray duplicate
    // event) can't both slip past the myChoices-based guard below.
    if (submittingRef.current || myChoices.length > 0 || locked || !question || !optionsVisible || indices.length === 0) {
      return;
    }
    submittingRef.current = true;
    setMyChoices(indices);
    setSubmitError(null);
    try {
      const response = await fetch(`/api/sessions/${pin}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, questionId: question.questionId, choiceIndices: indices }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setSubmitError(data.error ?? "Too late — that answer wasn't counted.");
      }
    } catch {
      setSubmitError("Couldn't reach the server — that answer wasn't counted.");
    }
  }

  function toggleSelected(index: number) {
    if (myChoices.length > 0 || locked || !optionsVisible) return;
    setSelectedIndices((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index]
    );
  }

  function handleTileClick(index: number) {
    if (isMultiSelect) {
      toggleSelected(index);
    } else {
      submitChoices([index]);
    }
  }

  if (podium) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
        <Confetti />
        {activeQuote && <QuoteOverlay quote={activeQuote.quote} attribution={activeQuote.attribution} />}
        <h1 className="text-4xl">Game Over</h1>
        <p className="font-serif text-2xl text-brand-ink">Thank you for playing! Radhe Radhe!</p>
      </div>
    );
  }

  if (question) {
    const correctPicks = myChoices.filter(
      (i) => revealedAnswers !== null && revealedAnswers.includes(question.choices[i])
    ).length;
    const isFullyCorrect =
      revealedAnswers !== null && correctPicks === revealedAnswers.length && myChoices.length === revealedAnswers.length;

    const postRevealStatus =
      myChoices.length > 0 && submitError ? (
        <p className="pill-badge">{submitError}</p>
      ) : myChoices.length > 0 && locked && revealedAnswers !== null ? (
        isFullyCorrect ? (
          <p className="pill-badge bg-success-soft text-success">Correct! ✓</p>
        ) : correctPicks > 0 ? (
          <p className="pill-badge bg-success-soft text-success">
            {correctPicks}/{revealedAnswers.length} correct
          </p>
        ) : (
          <p className="pill-badge bg-danger-soft text-danger">Incorrect ✗</p>
        )
      ) : myChoices.length > 0 ? (
        <p className="pill-badge">Answer locked in!</p>
      ) : locked ? (
        <p className="pill-badge">{showTimer ? "Time's up!" : "Locked!"}</p>
      ) : isMultiSelect ? (
        <p className="pill-badge">Select all that apply</p>
      ) : (
        <p className="pill-badge">Tap your answer</p>
      );

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
        {activeQuote && <QuoteOverlay quote={activeQuote.quote} attribution={activeQuote.attribution} />}
        <span className="pill-badge">
          Question {question.questionIndex + 1} of {questionCount}
        </span>
        {/* Always mounted whenever the timer is on at all (toggled invisible,
            not unmounted) so its line always reserves the same vertical
            space — otherwise it pops in the instant options reveal and
            shifts everything below it. */}
        {showTimer && (
          <p
            className={`font-serif text-5xl font-bold text-brand ${optionsVisible ? "" : "invisible"}`}
            aria-hidden={!optionsVisible}
          >
            {remaining}
          </p>
        )}
        <h1 className="max-w-md text-2xl break-words lg:max-w-xl">{question.question}</h1>
        {/* Both the "Get Ready" countdown and the post-reveal status pill are
            always mounted, stacked in the same grid cell, and toggled via
            visibility — never conditionally mounted — so the cell's height
            (the taller of the two) never changes across the reveal
            transition and the question above never re-centers. */}
        <div className="grid place-items-center">
          <div
            className={`col-start-1 row-start-1 flex flex-col items-center gap-2 ${optionsVisible ? "invisible" : ""}`}
            aria-hidden={optionsVisible}
          >
            <p className="text-xs font-bold tracking-wide text-ink-soft uppercase">Get Ready</p>
            <p className="font-serif text-7xl font-bold text-brand">{leadRemaining}</p>
          </div>
          <div className={`col-start-1 row-start-1 ${optionsVisible ? "" : "invisible"}`} aria-hidden={!optionsVisible}>
            {postRevealStatus}
          </div>
        </div>
        {/* Always mounted at full size (even before options reveal) and just
            toggled invisible, rather than conditionally mounted — so reveal
            never changes this screen's total height and re-triggers the
            surrounding flex column's justify-center recentering, which used
            to visibly jerk the question up the moment choices appeared. */}
        <div
          className={`grid w-full max-w-sm grid-cols-2 gap-4 lg:max-w-xl ${optionsVisible ? "" : "invisible"}`}
          aria-hidden={!optionsVisible}
        >
          {question.choices.map((choice, index) => {
            const disabled = myChoices.length > 0 || locked;
            const isRevealed = revealedAnswers !== null;
            const isCorrectChoice = isRevealed && revealedAnswers.includes(choice);
            const mySelected = isMultiSelect
              ? myChoices.length > 0
                ? myChoices.includes(index)
                : selectedIndices.includes(index)
              : myChoices.includes(index);
            // My own pick that turned out wrong, once the answer's revealed
            // (Show what the player selected when the question locks: ✓ on
            // the correct tile, ✗ on their own wrong pick).
            const isMyWrongPick = isRevealed && mySelected && !isCorrectChoice;
            const dimClass = isRevealed
              ? isCorrectChoice || isMyWrongPick
                ? ""
                : "opacity-30"
              : disabled && !mySelected
                ? "opacity-40"
                : "";
            // Neutral (never red/green) pre-lock "you tapped this" affordance.
            const selectedPreLockClass = mySelected && !isRevealed ? "ring-4 ring-white scale-105" : "";
            // Green/red are reserved for exactly this moment — the answer
            // reveal — and nowhere else on this screen. A solid fill of the
            // whole tile, not just a ring, per QA feedback.
            const revealFillClass = isCorrectChoice ? "bg-success" : isMyWrongPick ? "bg-danger" : "";
            return (
              <button
                key={index}
                type="button"
                disabled={disabled}
                onClick={() => handleTileClick(index)}
                className={`flex min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-2xl px-3 py-4 text-center text-xl font-semibold text-white shadow-lg transition-all duration-500 ${dimClass} ${selectedPreLockClass} ${revealFillClass}`}
                style={revealFillClass ? undefined : { backgroundColor: ANSWER_TILE_COLORS[index % ANSWER_TILE_COLORS.length] }}
                aria-label={`Option ${index + 1}: ${choice}`}
                aria-pressed={isMultiSelect ? mySelected : undefined}
              >
                <span className="answer-tile-text min-w-0 break-words">{choice}</span>
                {isCorrectChoice && <span>✓</span>}
                {isMyWrongPick && <span>✗</span>}
              </button>
            );
          })}
        </div>
        {isMultiSelect && optionsVisible && myChoices.length === 0 && (
          <button
            type="button"
            onClick={() => submitChoices(selectedIndices)}
            disabled={selectedIndices.length === 0}
            className="btn btn-primary"
          >
            Submit Answer
          </button>
        )}
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
        {showLeaderboard && locked && leaderboard && (
          <div className="w-full max-w-sm lg:max-w-md">
            <p className="mb-2 text-sm font-bold tracking-wide text-ink-soft uppercase">Top 10</p>
            <ol className="flex flex-col gap-2">
              {leaderboard.map((entry) => (
                <li
                  key={entry.playerId}
                  className={`card flex items-center justify-between gap-3 px-5 py-3 ${
                    entry.playerId === playerId ? "ring-2 ring-brand" : ""
                  }`}
                >
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
        {showLeaderboard && locked && myRank && !leaderboard?.some((entry) => entry.playerId === playerId) && (
          <p className="pill-badge">
            Your rank: #{myRank.rank} &middot; {myRank.points} points
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      {activeQuote && <QuoteOverlay quote={activeQuote.quote} attribution={activeQuote.attribution} />}
      <p className="font-serif text-2xl text-brand-ink">Hi, {nickname}!</p>
      {gameStarted ? (
        <p className="text-ink-soft">Game in progress — waiting for the next question…</p>
      ) : (
        <>
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand"
            aria-hidden
          />
          <p className="text-ink-soft">Waiting for the host to start the game…</p>
        </>
      )}
    </div>
  );
}
