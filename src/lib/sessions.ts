import { firestore } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { generateUniquePin } from "@/lib/pin";
import { publishToSession } from "@/lib/ably";
import { SessionEvent, type SettingsUpdatePayload } from "@/lib/events";
import { toPublicQuestion } from "@/lib/questions";
import { finalizeSession } from "@/lib/leaderboard";
import { buildQuoteAssignment } from "@/lib/swamijiQuotes";

export class QuizNotFoundError extends Error {
  constructor(quizId: string) {
    super(`Quiz ${quizId} not found or has no questions.`);
    this.name = "QuizNotFoundError";
  }
}

export class SessionNotStartableError extends Error {
  constructor(pin: string) {
    super(`Session ${pin} cannot be started (not in lobby, or no players joined).`);
    this.name = "SessionNotStartableError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(pin: string) {
    super(`No session found for PIN ${pin}.`);
    this.name = "SessionNotFoundError";
  }
}

/** choiceCounts is a map (string index -> count), not an array — Firestore
 * dotted-path updates address map fields, never array indices (see the
 * migration plan's Phase 2 spike notes). Seeded to 0 for every real choice
 * up front so submitAnswer's FieldValue.increment() calls always target an
 * existing key. */
function zeroChoiceCounts(choiceCount: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: choiceCount }, (_, i) => [String(i), 0]));
}

/**
 * Starts a live session from an existing quiz: generates a PIN and freezes a
 * snapshot of the quiz's current questions so later edits to the quiz don't
 * affect this session (Story 1.2). The batch write below is exactly the
 * pattern validated in the migration plan's Phase 2 spike
 * (scripts/firestore-spike/01-frozen-copy.ts) — nothing about the source
 * Question docs is ever referenced again once this commits.
 */
export async function createGameSession(quizId: string) {
  const quizRef = firestore.collection("quizzes").doc(quizId);
  const [quizSnap, questionsSnap] = await Promise.all([
    quizRef.get(),
    quizRef.collection("questions").orderBy("order").get(),
  ]);
  if (!quizSnap.exists || questionsSnap.empty) {
    throw new QuizNotFoundError(quizId);
  }
  const quiz = quizSnap.data()!;

  const pin = await generateUniquePin();
  // Fixed once per session, alongside the rest of the frozen question
  // snapshot, so a quote's position/text doesn't change if this is re-read.
  const quoteAssignment = buildQuoteAssignment(questionsSnap.size);

  const sessionRef = firestore.collection("gameSessions").doc();
  await sessionRef.set({
    pin,
    quizId,
    status: "LOBBY",
    createdAt: FieldValue.serverTimestamp(),
    startedAt: null,
    endedAt: null,
    currentQuestionIndex: -1,
    showLeaderboard: quiz.showLeaderboardDefault,
    showTimer: quiz.showTimerDefault,
    scoringMode: quiz.scoringMode,
    leadTimeSecs: quiz.leadTimeSecs,
  });

  // Named "sessionQuestions", not "questions" — Firestore collection-group
  // queries match by collection name across the whole database, and
  // generateQuizRequest.ts runs a collectionGroup("questions") query over
  // Quiz's own question banks. Sharing the name would silently pull these
  // frozen per-session copies into that query too.
  const gsQuestionsRef = sessionRef.collection("sessionQuestions");
  const batch = firestore.batch();
  const frozenQuestions: Array<{ id: string; order: number }> = [];
  questionsSnap.docs.forEach((doc) => {
    const question = doc.data();
    const ref = gsQuestionsRef.doc();
    frozenQuestions.push({ id: ref.id, order: question.order });
    batch.set(ref, {
      order: question.order,
      type: question.type,
      question: question.question,
      choices: question.choices,
      correctChoices: question.correctChoices,
      explanation: question.explanation,
      timeLimitSecs: question.timeLimitSecs,
      startedAt: null,
      optionsRevealedAt: null,
      lockedAt: null,
      answeredCount: 0,
      choiceCounts: zeroChoiceCounts((question.choices as string[]).length),
      correctCount: 0,
      incorrectCount: 0,
      quoteText: quoteAssignment.get(question.order)?.quote ?? null,
      quoteAttribution: quoteAssignment.get(question.order)?.attribution ?? null,
    });
  });
  await batch.commit();

  return { id: sessionRef.id, pin, status: "LOBBY" as const, questions: frozenQuestions };
}

/**
 * Moves a session from LOBBY to ACTIVE once the host clicks "Start Game"
 * (Story 2.3), and immediately advances straight into the first question —
 * the host shouldn't have to click "Start Game" and then a separate "Next
 * Question" just to reach question 1. The 2-statement update below is the
 * clean runTransaction port validated in the migration plan (Phase 1,
 * transaction pattern 1) — both doc paths are already known, no dynamic
 * sizing.
 */
export async function startGameSession(pin: string) {
  const sessionSnap = await firestore
    .collection("gameSessions")
    .where("pin", "==", pin)
    .where("status", "==", "LOBBY")
    .limit(1)
    .get();
  if (sessionSnap.empty) throw new SessionNotStartableError(pin);
  const sessionDoc = sessionSnap.docs[0];

  const [playerCountSnap, firstQuestionSnap] = await Promise.all([
    sessionDoc.ref.collection("players").count().get(),
    sessionDoc.ref.collection("sessionQuestions").where("order", "==", 0).limit(1).get(),
  ]);
  if (playerCountSnap.data().count < 1 || firstQuestionSnap.empty) {
    throw new SessionNotStartableError(pin);
  }
  const firstQuestionDoc = firstQuestionSnap.docs[0];
  const firstQuestion = firstQuestionDoc.data();

  const startedAt = new Date();
  const optionsRevealedAt = new Date(startedAt.getTime() + (sessionDoc.data().leadTimeSecs as number) * 1000);
  await firestore.runTransaction(async (tx) => {
    tx.update(sessionDoc.ref, { status: "ACTIVE", startedAt, currentQuestionIndex: 0 });
    tx.update(firstQuestionDoc.ref, { startedAt, optionsRevealedAt });
  });

  await publishToSession(pin, SessionEvent.GameStarted, {});
  const payload = toPublicQuestion({
    id: firstQuestionDoc.id,
    order: firstQuestion.order,
    type: firstQuestion.type,
    question: firstQuestion.question,
    choices: firstQuestion.choices,
    timeLimitSecs: firstQuestion.timeLimitSecs,
    startedAt,
    optionsRevealedAt,
  });
  await publishToSession(pin, SessionEvent.QuestionStart, payload);
  return payload;
}

/**
 * Lets the host end a session early from anywhere in the host flow — before
 * it's started, mid-question, or between questions. Reuses the same
 * finalize path a natural last-question lock takes, so players still get a
 * normal podium/"Game Over" screen instead of being left stuck waiting.
 * A no-op if the session already ended.
 */
export async function endGameSession(pin: string) {
  const sessionSnap = await firestore.collection("gameSessions").where("pin", "==", pin).limit(1).get();
  if (sessionSnap.empty) throw new SessionNotFoundError(pin);
  if (sessionSnap.docs[0].data().status === "COMPLETED") return null;
  return finalizeSession(pin);
}

/**
 * Force-ends every still-running (LOBBY/ACTIVE) session for a quiz — the
 * host's "Kill all live sessions" action, used to clear the way for deleting
 * a published quiz that has games in progress (the DELETE route blocks while
 * any non-COMPLETED session for the quiz exists). Reuses the same finalize
 * path a normal end-of-game takes, so any players still connected land on a
 * normal podium screen instead of being left stuck. Returns how many
 * sessions were killed.
 */
export async function killLiveSessionsForQuiz(quizId: string): Promise<number> {
  const liveSnap = await firestore
    .collection("gameSessions")
    .where("quizId", "==", quizId)
    .where("status", "in", ["LOBBY", "ACTIVE"])
    .get();
  await Promise.all(liveSnap.docs.map((doc) => finalizeSession(doc.data().pin as string)));
  return liveSnap.docs.length;
}

const HISTORY_SESSION_LIMIT = 10;
const HISTORY_TOP_PLAYERS = 3;

export type SessionHistoryEntry = {
  sessionId: string;
  pin: string;
  playedAt: Date;
  playerCount: number;
  topPlayers: { playerId: string; nickname: string; rank: number; totalPoints: number }[];
};

/**
 * Past completed games for a quiz, most recent first, capped at 10 (the host
 * page's "History" panel) — each with its top-3 finishers. `results` docs
 * only exist once a session is finalized (see finalizeSession in
 * leaderboard.ts), so this naturally excludes anything still LOBBY/ACTIVE.
 */
export async function getQuizSessionHistory(quizId: string): Promise<SessionHistoryEntry[]> {
  const sessionsSnap = await firestore
    .collection("gameSessions")
    .where("quizId", "==", quizId)
    .where("status", "==", "COMPLETED")
    .orderBy("createdAt", "desc")
    .limit(HISTORY_SESSION_LIMIT)
    .get();

  return Promise.all(
    sessionsSnap.docs.map(async (doc) => {
      const session = doc.data();
      const [resultsSnap, playerCountSnap] = await Promise.all([
        doc.ref.collection("results").orderBy("rank", "asc").limit(HISTORY_TOP_PLAYERS).get(),
        doc.ref.collection("players").count().get(),
      ]);
      return {
        sessionId: doc.id,
        pin: session.pin as string,
        playedAt: (session.createdAt as FirebaseFirestore.Timestamp).toDate(),
        playerCount: playerCountSnap.data().count,
        topPlayers: resultsSnap.docs.map((resultDoc) => {
          const result = resultDoc.data();
          return {
            playerId: resultDoc.id,
            nickname: result.nickname as string,
            rank: result.rank as number,
            totalPoints: result.totalPoints as number,
          };
        }),
      };
    })
  );
}

export class SessionHistoryNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No session found with id ${sessionId}.`);
    this.name = "SessionHistoryNotFoundError";
  }
}

export class SessionNotCompletedError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} hasn't finished yet — use "Kill all live sessions" instead.`);
    this.name = "SessionNotCompletedError";
  }
}

/**
 * Deletes one past game from a quiz's history (the host page's per-entry
 * "Delete" button) — only COMPLETED sessions, so this can't be used to tear
 * down a game still in progress ("Kill all live sessions" is the path for
 * that). recursiveDelete() removes the GameSession doc and every
 * subcollection under it (sessionQuestions, its nested answers, players,
 * results) in one call.
 */
export async function deleteCompletedSession(sessionId: string): Promise<void> {
  const sessionRef = firestore.collection("gameSessions").doc(sessionId);
  const snap = await sessionRef.get();
  if (!snap.exists) throw new SessionHistoryNotFoundError(sessionId);
  if (snap.data()!.status !== "COMPLETED") throw new SessionNotCompletedError(sessionId);
  await firestore.recursiveDelete(sessionRef);
}

/**
 * Live mid-game override for the leaderboard/timer visibility toggles the
 * host sees on the question screen — separate from the Quiz's authoring-time
 * defaults, so flipping this never rewrites the quiz itself.
 */
export async function updateSessionSettings(pin: string, settings: Partial<SettingsUpdatePayload>) {
  const sessionSnap = await firestore.collection("gameSessions").where("pin", "==", pin).limit(1).get();
  if (sessionSnap.empty) throw new SessionNotFoundError(pin);
  const sessionRef = sessionSnap.docs[0].ref;

  await sessionRef.update({ ...settings });
  const updatedSnap = await sessionRef.get();
  const updated = {
    showLeaderboard: updatedSnap.data()!.showLeaderboard as boolean,
    showTimer: updatedSnap.data()!.showTimer as boolean,
  };

  await publishToSession(pin, SessionEvent.SettingsUpdate, updated);
  return updated;
}
