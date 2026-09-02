import { redis } from "@/lib/redis";
import { firestore } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { publishToSession } from "@/lib/sessionBroadcast";
import { SessionEvent, type LeaderboardEntry as PublicLeaderboardEntry } from "@/lib/events";

const TOP_N = 10;
const PODIUM_SIZE = 3;

/** Cumulative score across the whole session, per Story 5.1's leaderboard reads. */
export function leaderboardKey(pin: string): string {
  return `game:${pin}:leaderboard`;
}

/** Immediately reflects a graded answer's points in the live leaderboard (Story 4.4). */
export async function addPoints(pin: string, playerId: string, points: number): Promise<void> {
  await redis.zincrby(leaderboardKey(pin), points, playerId);
}

type LeaderboardEntry = { playerId: string; points: number; rank: number };

function parseWithScores(flat: string[]): { playerId: string; points: number }[] {
  const entries: { playerId: string; points: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    entries.push({ playerId: flat[i], points: Number(flat[i + 1]) });
  }
  return entries;
}

/** Highest-score-first, via ZREVRANGE (Story 5.1). `n: "all"` for the whole leaderboard. */
async function getTopN(pin: string, n: number | "all"): Promise<LeaderboardEntry[]> {
  const stop = n === "all" ? -1 : n - 1;
  const flat = await redis.zrevrange(leaderboardKey(pin), 0, stop, "WITHSCORES");
  return parseWithScores(flat).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/** The player's own rank even when outside the top N, via ZREVRANK (Story 5.2).
 * Also returns totalPlayers (size of the same ZSET) so callers can derive a
 * percentile without a second round trip. */
export async function getPlayerRank(
  pin: string,
  playerId: string
): Promise<{ rank: number; points: number; totalPlayers: number } | null> {
  const [rank, points, totalPlayers] = await Promise.all([
    redis.zrevrank(leaderboardKey(pin), playerId),
    redis.zscore(leaderboardKey(pin), playerId),
    redis.zcard(leaderboardKey(pin)),
  ]);
  if (rank === null || points === null) return null;
  return { rank: rank + 1, points: Number(points), totalPlayers };
}

/** Any session at this pin, matching the original Prisma query's own lack of
 * a status filter (findFirst with no orderBy) — not something this port
 * needs to tighten. */
async function findSessionByPin(pin: string) {
  const snap = await firestore.collection("gameSessions").where("pin", "==", pin).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

/** How many of the player's answers this session were correct, out of how
 * many they've answered so far — the "X/Y correct" summary shown alongside
 * rank (Story: show right/total regardless of whether the leaderboard is on).
 * Answer docs live at gameSessions/{id}/questions/{qid}/answers/{playerId} —
 * gameSessionId and playerId are denormalized fields on each Answer doc
 * (see submitAnswer in questions.ts) specifically so this collection-group
 * query can scope across every question in the session without needing the
 * per-question doc IDs. */
export async function getPlayerProgress(
  pin: string,
  playerId: string
): Promise<{ correctCount: number; answeredCount: number } | null> {
  const sessionDoc = await findSessionByPin(pin);
  if (!sessionDoc) return null;

  const answersGroup = firestore.collectionGroup("answers");
  const [correctSnap, answeredSnap] = await Promise.all([
    answersGroup
      .where("gameSessionId", "==", sessionDoc.id)
      .where("playerId", "==", playerId)
      .where("correct", "==", true)
      .count()
      .get(),
    answersGroup.where("gameSessionId", "==", sessionDoc.id).where("playerId", "==", playerId).count().get(),
  ]);
  return { correctCount: correctSnap.data().count, answeredCount: answeredSnap.data().count };
}

async function withNicknames(entries: LeaderboardEntry[], sessionId: string) {
  if (!entries.length) return [];
  const playersRef = firestore.collection("gameSessions").doc(sessionId).collection("players");
  const docs = await firestore.getAll(...entries.map((entry) => playersRef.doc(entry.playerId)));
  const nicknameById = new Map(docs.map((doc) => [doc.id, doc.exists ? (doc.data()!.nickname as string) : undefined]));
  return entries.map((entry) => ({
    ...entry,
    nickname: nicknameById.get(entry.playerId) ?? "Unknown",
  }));
}

/** Broadcasts the top-N leaderboard after a question's grading window closes (Story 5.1). */
export async function publishLeaderboardUpdate(pin: string): Promise<void> {
  const sessionDoc = await findSessionByPin(pin);
  if (!sessionDoc) return;
  const top = await withNicknames(await getTopN(pin, TOP_N), sessionDoc.id);
  await publishToSession(pin, SessionEvent.LeaderboardUpdate, { leaderboard: top });
}

/**
 * Ends the session: snapshots the full Redis leaderboard into SessionResult
 * docs (so standings survive Redis eventually expiring the key), marks the
 * session COMPLETED, and broadcasts the top-3 podium (Story 5.3). The N
 * SessionResult upserts have no read-your-own-write dependency on each
 * other (the Redis snapshot is already fully computed before any Firestore
 * write starts) and always fit Firestore's 500-doc batch limit given the
 * 190-player session cap, so a WriteBatch is the right primitive here, not
 * runTransaction (see the migration plan's Phase 2 spike notes).
 */
export async function finalizeSession(pin: string): Promise<PublicLeaderboardEntry[]> {
  const sessionDoc = await findSessionByPin(pin);
  if (!sessionDoc) return [];
  const session = sessionDoc.data();

  const full = await withNicknames(await getTopN(pin, "all"), sessionDoc.id);

  const batch = firestore.batch();
  batch.update(sessionDoc.ref, { status: "COMPLETED", endedAt: FieldValue.serverTimestamp() });
  const resultsRef = sessionDoc.ref.collection("results");
  for (const entry of full) {
    // doc ID = playerId gives the [gameSessionId, playerId] uniqueness for
    // free — every write here is an unconditional set(), not a real
    // create/update branch, since there's nothing to conditionally check.
    batch.set(resultsRef.doc(entry.playerId), {
      nickname: entry.nickname,
      rank: entry.rank,
      totalPoints: entry.points,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  const podium = full.slice(0, PODIUM_SIZE);
  // showLeaderboard as of the last question (nothing changes it after the
  // session ends) tells clients whether to show rank badges or fall back to
  // percentile-only standings (Story: percentile when leaderboard is off).
  await publishToSession(pin, SessionEvent.Podium, {
    podium,
    totalPlayers: full.length,
    showLeaderboard: session.showLeaderboard as boolean,
  });
  return podium;
}
