/**
 * Event names on a session's broadcast log (`sessionBroadcasts/{pin}/events`,
 * see src/lib/sessionBroadcast.ts). Central list so producers (API routes)
 * and consumers (host/player UI) agree on spelling; individual features add
 * payload types as they land.
 *
 * Note there's no player_joined here — the host roster listens to the
 * session's `players` subcollection directly (subscribeToRoster).
 */
export const SessionEvent = {
  GameStarted: "game_started",
  QuoteDisplay: "quote_display",
  QuestionStart: "question_start",
  AnswerCountUpdate: "answer_count_update",
  QuestionLocked: "question_locked",
  LeaderboardUpdate: "leaderboard_update",
  Podium: "podium",
  SettingsUpdate: "settings_update",
  AnswerBreakdown: "answer_breakdown",
} as const;

export type SessionEventName = (typeof SessionEvent)[keyof typeof SessionEvent];

/** Payload for SessionEvent.QuestionStart. Sent to host and players alike —
 * player UI just chooses not to render `question`/`choices` as text (Story 3.2). */
export type QuestionStartPayload = {
  questionId: string;
  questionIndex: number;
  type: "MULTIPLE_CHOICE" | "TRUE_FALSE" | "SHORT_ANSWER" | "MULTI_SELECT";
  question: string;
  choices: string[];
  timeLimitSecs: number;
  startedAt: number | null;
  /** Answer choices stay hidden/disabled until this moment (lead-time reveal). */
  optionsRevealedAt: number | null;
};

/** Sent right before question_start when the upcoming question has a quote
 * assigned (see src/lib/swamijiQuotes.ts). Stays on screen until the host
 * clicks "Next" on it (POST /api/sessions/[pin]/reveal-question) — there's
 * no auto-advance timer, so this carries no display duration. */
export type QuoteDisplayPayload = { quote: string; attribution: string };

export type AnswerCountUpdatePayload = { answeredCount: number; playerCount: number };
/** `correctChoices` are the correct choice text(s) — safe to reveal now that answering is closed. */
export type QuestionLockedPayload = { questionId: string; correctChoices: string[] };

export type LeaderboardEntry = { playerId: string; nickname: string; points: number; rank: number };
export type LeaderboardUpdatePayload = { leaderboard: LeaderboardEntry[] };
/** `totalPlayers` and `showLeaderboard` (the setting's value as of the last
 * question) let clients show a percentile instead of a raw rank when the
 * leaderboard was toggled off (Story: percentile when leaderboard is off). */
export type PodiumPayload = { podium: LeaderboardEntry[]; totalPlayers: number; showLeaderboard: boolean };

/** Broadcast whenever the host flips a live setting mid-game (Story: game settings toggles). */
export type SettingsUpdatePayload = { showLeaderboard: boolean; showTimer: boolean };

/** Broadcast alongside QuestionLocked — how many answered correctly vs
 * incorrectly (host-only chart), plus a per-choice tally in the same order
 * as the question's choices (host-only "answers by choice" bar graph). */
export type AnswerBreakdownPayload = { correctCount: number; incorrectCount: number; choiceCounts: number[] };
