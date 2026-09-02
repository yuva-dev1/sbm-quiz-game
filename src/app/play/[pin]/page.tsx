import { firestore } from "@/lib/firestore";
import { notFound } from "next/navigation";
import { PlayerLobby } from "./PlayerLobby";
import { DynamicRejoinFromStorage as RejoinFromStorage } from "./DynamicRejoin";
import { toPublicQuestion } from "@/lib/questions";
import { sessionBroadcastRef } from "@/lib/sessionBroadcast";
import type { LeaderboardEntry, QuestionStartPayload } from "@/lib/events";

export const dynamic = "force-dynamic";

// Plain (non-component) helper so this request-time Date.now() read doesn't
// trip the "impure call during render" lint rule, which scans component
// bodies — decided once per request, passed down as a literal prop, rather
// than re-derived from Date.now() again during the client's own render/
// hydration (see PlayerLobby's optionsVisible comment for why that races).
function computeInitialOptionsVisible(locked: boolean, optionsRevealedAt: Date | null): boolean {
  return locked || (optionsRevealedAt !== null && optionsRevealedAt.getTime() <= Date.now());
}

export default async function PlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ pin: string }>;
  searchParams: Promise<{ playerId?: string; nickname?: string }>;
}) {
  const { pin } = await params;
  const { playerId, nickname } = await searchParams;

  if (!playerId || !nickname) {
    return <RejoinFromStorage pin={pin} />;
  }

  // The player's own id already pins down which session they belong to —
  // no ambiguity from a reused PIN the way the host's PIN-only lookup has
  // to handle. Resolved via the redundant playerId field on the Player doc
  // (see src/lib/players.ts) since a bare playerId alone doesn't say which
  // session's subcollection it lives in.
  const playerSnap = await firestore.collectionGroup("players").where("playerId", "==", playerId).limit(1).get();
  if (playerSnap.empty) notFound();
  const playerDoc = playerSnap.docs[0];
  const sessionRef = playerDoc.ref.parent.parent!;
  const sessionSnap = await sessionRef.get();
  const session = sessionSnap.data()!;
  if (session.pin !== pin) notFound();

  const [questionsSnap, resultsSnap, broadcastSnap] = await Promise.all([
    sessionRef.collection("sessionQuestions").orderBy("order").get(),
    sessionRef.collection("results").orderBy("rank", "asc").limit(3).get(),
    sessionBroadcastRef(pin).get(),
  ]);
  const questions = questionsSnap.docs.map((doc) => {
    const data = doc.data();
    return {
      ref: doc.ref,
      id: doc.id,
      order: data.order as number,
      type: data.type,
      question: data.question as string,
      choices: data.choices as string[],
      correctChoices: data.correctChoices as string[],
      timeLimitSecs: data.timeLimitSecs as number,
      startedAt: (data.startedAt?.toDate?.() as Date | null) ?? null,
      optionsRevealedAt: (data.optionsRevealedAt?.toDate?.() as Date | null) ?? null,
      lockedAt: (data.lockedAt?.toDate?.() as Date | null) ?? null,
    };
  });

  const currentQuestionIndex = session.currentQuestionIndex as number;
  const current = currentQuestionIndex >= 0 ? questions[currentQuestionIndex] : null;

  // Story 7.1: resume the live question on reconnect — don't drop the
  // player back to "waiting" mid-question just because their connection did.
  let initialQuestion: QuestionStartPayload | null = null;
  let initialLocked = false;
  let initialMyChoices: number[] = [];
  let initialRevealedAnswers: string[] | null = null;
  let initialOptionsVisible = false;
  if (session.status === "ACTIVE" && current) {
    initialQuestion = toPublicQuestion(current);
    initialLocked = Boolean(current.lockedAt);
    initialRevealedAnswers = initialLocked ? current.correctChoices : null;
    const myAnswerSnap = await current.ref.collection("answers").doc(playerId).get();
    initialMyChoices = (myAnswerSnap.data()?.choiceIndices as number[] | undefined) ?? [];
    initialOptionsVisible = computeInitialOptionsVisible(initialLocked, current.optionsRevealedAt);
  }

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
    <PlayerLobby
      pin={pin}
      playerId={playerId}
      nickname={nickname}
      initialBroadcastSeq={(broadcastSnap.data()?.seq as number | undefined) ?? 0}
      questionCount={questions.length}
      initialGameStarted={session.status === "ACTIVE"}
      initialPodium={initialPodium}
      initialQuestion={initialQuestion}
      initialLocked={initialLocked}
      initialMyChoices={initialMyChoices}
      initialRevealedAnswers={initialRevealedAnswers}
      initialOptionsVisible={initialOptionsVisible}
      initialShowLeaderboard={session.showLeaderboard as boolean}
      initialShowTimer={session.showTimer as boolean}
    />
  );
}
