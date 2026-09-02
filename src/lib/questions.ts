import { firestore } from "@/lib/firestore";
import { FieldValue, Timestamp, type DocumentReference, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { redis } from "@/lib/redis";
import { publishToSession } from "@/lib/sessionBroadcast";
import { SessionEvent, type QuestionStartPayload } from "@/lib/events";
import {
  computeCorrectFraction,
  computePoints,
  computeRawReactionTimeMs,
  computeTrueReactionTimeMs,
} from "@/lib/scoring";
import { addPoints, publishLeaderboardUpdate } from "@/lib/leaderboard";

export class QuestionFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionFlowError";
  }
}

/** Public shape sent to clients — never includes `answer`/`explanation` (Story 3.2/3.4 integrity). */
export function toPublicQuestion(question: {
  id: string;
  order: number;
  type: QuestionStartPayload["type"];
  question: string;
  choices: string[];
  timeLimitSecs: number;
  startedAt: Date | null;
  optionsRevealedAt?: Date | null;
}): QuestionStartPayload {
  return {
    questionId: question.id,
    questionIndex: question.order,
    type: question.type,
    question: question.question,
    choices: question.choices,
    timeLimitSecs: question.timeLimitSecs,
    startedAt: question.startedAt?.getTime() ?? null,
    optionsRevealedAt: question.optionsRevealedAt?.getTime() ?? null,
  };
}

type GsQuestion = {
  ref: DocumentReference;
  id: string;
  order: number;
  type: QuestionStartPayload["type"];
  question: string;
  choices: string[];
  correctChoices: string[];
  timeLimitSecs: number;
  startedAt: Date | null;
  optionsRevealedAt: Date | null;
  lockedAt: Date | null;
  quoteText: string | null;
  quoteAttribution: string | null;
};

type ActiveSession = {
  ref: DocumentReference;
  id: string;
  currentQuestionIndex: number;
  leadTimeSecs: number;
  showTimer: boolean;
  scoringMode: "SPEED" | "ACCURACY";
  questions: GsQuestion[];
};

function toDateOrNull(value: Timestamp | null | undefined): Date | null {
  return value ? value.toDate() : null;
}

function toGsQuestion(doc: QueryDocumentSnapshot): GsQuestion {
  const data = doc.data();
  return {
    ref: doc.ref,
    id: doc.id,
    order: data.order,
    type: data.type,
    question: data.question,
    choices: data.choices,
    correctChoices: data.correctChoices,
    timeLimitSecs: data.timeLimitSecs,
    startedAt: toDateOrNull(data.startedAt),
    optionsRevealedAt: toDateOrNull(data.optionsRevealedAt),
    lockedAt: toDateOrNull(data.lockedAt),
    quoteText: data.quoteText ?? null,
    quoteAttribution: data.quoteAttribution ?? null,
  };
}

/** The repeated "active session + its ordered frozen questions" read used by
 * every function below — one place instead of hand-rolling it 4 times. */
async function findActiveSessionWithQuestions(pin: string): Promise<ActiveSession | null> {
  const sessionSnap = await firestore
    .collection("gameSessions")
    .where("pin", "==", pin)
    .where("status", "==", "ACTIVE")
    .limit(1)
    .get();
  if (sessionSnap.empty) return null;
  const sessionDoc = sessionSnap.docs[0];
  const data = sessionDoc.data();
  // "sessionQuestions", not "questions" — see the naming note in
  // createGameSession (src/lib/sessions.ts) for why the frozen per-session
  // copy uses a different subcollection name than the Quiz's own bank.
  const questionsSnap = await sessionDoc.ref.collection("sessionQuestions").orderBy("order").get();
  return {
    ref: sessionDoc.ref,
    id: sessionDoc.id,
    currentQuestionIndex: data.currentQuestionIndex,
    leadTimeSecs: data.leadTimeSecs,
    showTimer: data.showTimer,
    scoringMode: data.scoringMode,
    questions: questionsSnap.docs.map(toGsQuestion),
  };
}

/** Sets startedAt/optionsRevealedAt and broadcasts question_start with a
 * server timestamp clients use to sync their countdowns (Story 3.1, 3.3). */
async function startQuestion(pin: string, leadTimeSecs: number, question: GsQuestion) {
  const startedAt = new Date();
  const optionsRevealedAt = new Date(startedAt.getTime() + leadTimeSecs * 1000);
  await question.ref.update({ startedAt, optionsRevealedAt });
  const payload = toPublicQuestion({ ...question, startedAt, optionsRevealedAt });
  await publishToSession(pin, SessionEvent.QuestionStart, payload);
  return payload;
}

/**
 * Advances a session to its next question (or the first, from the lobby's
 * post-start state). If the next question has a Sri Swamiji quote assigned
 * (src/lib/swamijiQuotes.ts), this only broadcasts quote_display and
 * advances currentQuestionIndex to it — the question itself doesn't start
 * (no countdown, not visible) until the host explicitly reveals it via
 * revealQuestionAfterQuote below, so there's no auto-advance timer for the
 * host to race against. Returns null in that case; otherwise the question
 * starts immediately and this returns its question_start payload.
 */
export async function advanceToNextQuestion(pin: string): Promise<QuestionStartPayload | null> {
  const session = await findActiveSessionWithQuestions(pin);
  if (!session) throw new QuestionFlowError(`No active session for PIN ${pin}.`);

  // A quote is already showing for the current question and the host hasn't
  // revealed it yet — treat "Next" as "reveal it" instead of skipping past
  // it, which currentQuestionIndex + 1 below would otherwise do.
  const current = session.currentQuestionIndex >= 0 ? session.questions[session.currentQuestionIndex] : null;
  if (current && !current.startedAt) {
    return startQuestion(pin, session.leadTimeSecs, current);
  }

  const nextIndex = session.currentQuestionIndex + 1;
  const nextQuestion = session.questions[nextIndex];
  if (!nextQuestion) throw new QuestionFlowError("No more questions in this session.");

  await session.ref.update({ currentQuestionIndex: nextIndex });

  if (nextQuestion.quoteText && nextQuestion.quoteAttribution) {
    await publishToSession(pin, SessionEvent.QuoteDisplay, {
      quote: nextQuestion.quoteText,
      attribution: nextQuestion.quoteAttribution,
    });
    return null;
  }

  return startQuestion(pin, session.leadTimeSecs, nextQuestion);
}

/** Reveals the question waiting behind the current quote (host's "Next"
 * button on the quote overlay — see advanceToNextQuestion). Idempotent: a
 * question that's already started (e.g. a duplicate click) is just returned
 * as-is rather than re-started. */
export async function revealQuestionAfterQuote(pin: string): Promise<QuestionStartPayload> {
  const session = await findActiveSessionWithQuestions(pin);
  const current = session?.questions[session.currentQuestionIndex];
  if (!session || !current) throw new QuestionFlowError(`No live question for PIN ${pin}.`);
  if (current.startedAt) return toPublicQuestion(current);
  return startQuestion(pin, session.leadTimeSecs, current);
}

/**
 * Locks the session's current question so late taps are rejected client-side
 * too, and broadcasts question_locked. The server's deadline check in
 * submitAnswer is the real authority regardless of whether this ever runs
 * (Story 3.3) — this just gives clients a clean "time's up" signal, whether
 * triggered by the host's Lock Now button or their countdown hitting zero.
 *
 * Once locked, this is also the session's "grading window closed" moment
 * (Story 5.1): the leaderboard broadcasts here. Locking the last question
 * does NOT auto-finalize the session — the host explicitly reveals results
 * via the "Reveal results" button (POST /api/sessions/[pin]/end, same
 * finalize path as ending a game early), so the room doesn't get yanked to
 * the podium the instant the last answer is graded.
 *
 * correctCount/incorrectCount/choiceCounts are read directly off the
 * question doc rather than aggregated here — submitAnswer maintains them
 * incrementally on every answer (see below), turning what was an N-answer
 * read-and-tally into a single-doc read (migration plan, Phase 1).
 */
export async function lockCurrentQuestion(pin: string) {
  const session = await findActiveSessionWithQuestions(pin);
  const current = session?.questions[session.currentQuestionIndex];
  if (!session || !current) throw new QuestionFlowError(`No live question for PIN ${pin}.`);

  if (!current.lockedAt) {
    await current.ref.update({ lockedAt: new Date() });
  }
  await publishToSession(pin, SessionEvent.QuestionLocked, {
    questionId: current.id,
    correctChoices: current.correctChoices,
  });
  await publishLeaderboardUpdate(pin);

  // Re-read for the freshest counters — lockedAt above doesn't block
  // already-in-flight submissions (it's a UI signal, not the deadline
  // authority; see submitAnswer's own deadline check), so a submission can
  // still land between the update above and this read.
  const freshSnap = await current.ref.get();
  const fresh = freshSnap.data() ?? {};
  const correctCount = (fresh.correctCount as number | undefined) ?? 0;
  const incorrectCount = (fresh.incorrectCount as number | undefined) ?? 0;
  const choiceCountsMap = (fresh.choiceCounts as Record<string, number> | undefined) ?? {};
  const choiceCounts = current.choices.map((_, i) => choiceCountsMap[String(i)] ?? 0);

  await publishToSession(pin, SessionEvent.AnswerBreakdown, { correctCount, incorrectCount, choiceCounts });
}

const ANSWER_COUNT_THROTTLE_MS = 300;

/**
 * At most one answer_count_update broadcast per session every 300ms. Without
 * this, a burst of answers landing in the same second (everyone tapping just
 * before the deadline) publishes once per answer — each an
 * append-to-the-event-log transaction contending on the same per-session
 * `seq` counter doc, which serializes and blows past Firestore's ~1
 * write/sec sustained per-document ceiling. A Redis NX lock makes the
 * throttle hold across Cloud Run instances, not just within one.
 */
async function shouldPublishAnswerCountUpdate(pin: string): Promise<boolean> {
  const key = `game:${pin}:answer-count-throttle`;
  const acquired = await redis.set(key, "1", "PX", ANSWER_COUNT_THROTTLE_MS, "NX");
  return acquired === "OK";
}

export class AnswerRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerRejectedError";
  }
}

/**
 * Records and grades a player's answer for the session's current question.
 * Rejects anything after the server-computed deadline regardless of client
 * state (Story 3.3) — unless the host has the timer off, in which case the
 * question is free-time and only an explicit lock closes it — and rejects a
 * second submission for the same question (Story 3.4 / QA 9.1
 * rapid-double-submit case). Grading uses only server-received timestamps
 * (Story 4.1) — nothing client-submitted about timing is ever trusted.
 *
 * The Answer doc's ID is the playerId, so the create() below fails
 * atomically if this player already answered — replacing the old unique-
 * constraint-violation catch with Firestore's own doc-ID uniqueness. It's
 * written in the same transaction as the question doc's counter increments
 * (answeredCount/correctCount/incorrectCount/choiceCounts) so a lock-time
 * read of those counters (see lockCurrentQuestion) is never out of sync
 * with the actual Answer docs. Confirmed safe at this app's real worst case
 * (190 concurrent submits to one question) in the migration plan's Phase 2
 * spike — plain transactions, no sharded counters needed.
 */
export async function submitAnswer(pin: string, playerId: string, questionId: string, choiceIndices: number[]) {
  const session = await findActiveSessionWithQuestions(pin);
  const current = session?.questions[session.currentQuestionIndex];
  if (!session || !current || current.id !== questionId) {
    throw new AnswerRejectedError("That question is not currently live.");
  }
  if (!current.startedAt) {
    throw new AnswerRejectedError("That question hasn't started yet.");
  }
  // Reaction time and the answer deadline are both relative to when options
  // actually became visible (startedAt + leadTimeSecs), not when the
  // question text first appeared — falls back to startedAt for any row from
  // before lead-time reveal existed.
  const revealAt = current.optionsRevealedAt ?? current.startedAt;
  const serverReceivedAt = new Date();
  if (serverReceivedAt.getTime() < revealAt.getTime()) {
    throw new AnswerRejectedError("Answer options aren't open yet.");
  }
  const deadline = revealAt.getTime() + current.timeLimitSecs * 1000;
  const timeExpired = session.showTimer && serverReceivedAt.getTime() > deadline;
  if (current.lockedAt || timeExpired) {
    throw new AnswerRejectedError("The question is locked.");
  }
  const uniqueIndices = new Set(choiceIndices);
  if (
    choiceIndices.length === 0 ||
    uniqueIndices.size !== choiceIndices.length ||
    choiceIndices.some((i) => i < 0 || i >= current.choices.length) ||
    (current.type !== "MULTI_SELECT" && choiceIndices.length > 1)
  ) {
    throw new AnswerRejectedError("choiceIndices is invalid for this question.");
  }

  const playerSnap = await session.ref.collection("players").doc(playerId).get();
  if (!playerSnap.exists) {
    throw new AnswerRejectedError("Player does not belong to this session.");
  }
  const estimatedLatencyMs = (playerSnap.data()?.estimatedLatencyMs as number | null | undefined) ?? 0;

  const timeLimitMs = current.timeLimitSecs * 1000;
  const rawReactionTimeMs = computeRawReactionTimeMs(serverReceivedAt.getTime(), revealAt.getTime());
  const trueReactionTimeMs = computeTrueReactionTimeMs(rawReactionTimeMs, estimatedLatencyMs, timeLimitMs);
  const correctFraction = computeCorrectFraction(current.choices, current.correctChoices, choiceIndices);
  const correct = correctFraction >= 1;
  const points = computePoints(correctFraction, trueReactionTimeMs, timeLimitMs, session.scoringMode);

  const answerRef = current.ref.collection("answers").doc(playerId);
  try {
    await firestore.runTransaction(async (tx) => {
      tx.create(answerRef, {
        gameSessionId: session.id,
        playerId,
        choiceIndices,
        serverReceivedAt,
        correct,
        points,
        rawReactionTimeMs,
        trueReactionTimeMs,
      });
      const increments: Record<string, FirebaseFirestore.FieldValue> = {
        answeredCount: FieldValue.increment(1),
        [correct ? "correctCount" : "incorrectCount"]: FieldValue.increment(1),
      };
      // choiceCounts is a MAP (string index -> count), not an array —
      // Firestore dotted-path updates address map fields, never array
      // indices; pointing one at an array field silently converts it to a
      // map and drops the other elements (confirmed in the Phase 2 spike).
      for (const choiceIndex of choiceIndices) {
        increments[`choiceCounts.${choiceIndex}`] = FieldValue.increment(1);
      }
      tx.update(current.ref, increments);
    });
  } catch {
    throw new AnswerRejectedError("You already answered this question.");
  }

  await addPoints(pin, playerId, points);

  const [freshQuestionSnap, playerCountSnap] = await Promise.all([
    current.ref.get(),
    session.ref.collection("players").count().get(),
  ]);
  const answeredCount = (freshQuestionSnap.data()?.answeredCount as number | undefined) ?? 0;
  const playerCount = playerCountSnap.data().count;
  if (await shouldPublishAnswerCountUpdate(pin)) {
    await publishToSession(pin, SessionEvent.AnswerCountUpdate, { answeredCount, playerCount });
  }
}
