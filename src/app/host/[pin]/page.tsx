import { firestore } from "@/lib/firestore";
import { notFound } from "next/navigation";
import { HostLobby } from "./HostLobby";
import { sessionBroadcastRef } from "@/lib/sessionBroadcast";
import type { LeaderboardEntry, QuestionStartPayload } from "@/lib/events";

export const dynamic = "force-dynamic";

export default async function HostLobbyPage({
  params,
}: {
  params: Promise<{ pin: string }>;
}) {
  const { pin } = await params;
  // Most recent session for this PIN — a PIN can be reused across sessions
  // once the earlier one is COMPLETED (Story 1.3), so this is either the
  // live session or, once the game has ended, the one to show the podium
  // for on reload.
  const sessionSnap = await firestore
    .collection("gameSessions")
    .where("pin", "==", pin)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  if (sessionSnap.empty) notFound();
  const sessionDoc = sessionSnap.docs[0];
  const session = sessionDoc.data();

  // 5 reads total regardless of question count: quiz doc (title), the
  // frozen questions (answeredCount already maintained incrementally by
  // submitAnswer — no per-question count query needed here, unlike the
  // Prisma version's nested _count include), players, and the top-3
  // results. See the migration plan's Phase 1 "deep nested reads" design.
  const [quizSnap, questionsSnap, playersSnap, resultsSnap, broadcastSnap] = await Promise.all([
    firestore.collection("quizzes").doc(session.quizId).get(),
    sessionDoc.ref.collection("sessionQuestions").orderBy("order").get(),
    sessionDoc.ref.collection("players").orderBy("joinedAt", "asc").get(),
    sessionDoc.ref.collection("results").orderBy("rank", "asc").limit(3).get(),
    sessionBroadcastRef(pin).get(),
  ]);

  const questions = questionsSnap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      order: data.order as number,
      type: data.type,
      question: data.question as string,
      choices: data.choices as string[],
      timeLimitSecs: data.timeLimitSecs as number,
      startedAt: (data.startedAt?.toDate?.() as Date | null) ?? null,
      optionsRevealedAt: (data.optionsRevealedAt?.toDate?.() as Date | null) ?? null,
      lockedAt: (data.lockedAt?.toDate?.() as Date | null) ?? null,
      answeredCount: (data.answeredCount as number | undefined) ?? 0,
    };
  });
  const players = playersSnap.docs.map((doc) => ({ id: doc.id, nickname: doc.data().nickname as string }));

  const currentQuestionIndex = session.currentQuestionIndex as number;
  const current = currentQuestionIndex >= 0 ? questions[currentQuestionIndex] : null;

  const initialQuestion: QuestionStartPayload | null = current
    ? {
        questionId: current.id,
        questionIndex: current.order,
        type: current.type,
        question: current.question,
        choices: current.choices,
        timeLimitSecs: current.timeLimitSecs,
        startedAt: current.startedAt?.getTime() ?? null,
        optionsRevealedAt: current.optionsRevealedAt?.getTime() ?? null,
      }
    : null;

  const initialPodium: LeaderboardEntry[] | null =
    session.status === "COMPLETED"
      ? resultsSnap.docs.map((doc) => {
          const result = doc.data();
          return {
            playerId: doc.id,
            nickname: result.nickname as string,
            points: result.totalPoints as number,
            rank: result.rank as number,
          };
        })
      : null;

  return (
    <HostLobby
      pin={session.pin as string}
      sessionId={sessionDoc.id}
      initialBroadcastSeq={(broadcastSnap.data()?.seq as number | undefined) ?? 0}
      quizTitle={quizSnap.data()?.title as string}
      questionCount={questions.length}
      initialPlayers={players}
      joinUrl={`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/join`}
      initialStarted={session.status === "ACTIVE"}
      initialQuestion={initialQuestion}
      initialLocked={Boolean(current?.lockedAt)}
      initialAnsweredCount={current?.answeredCount ?? 0}
      initialPlayerCount={players.length}
      initialPodium={initialPodium}
      initialShowLeaderboard={session.showLeaderboard as boolean}
      initialShowTimer={session.showTimer as boolean}
    />
  );
}
