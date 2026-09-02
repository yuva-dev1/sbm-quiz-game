import { firestore } from "@/lib/firestore";
import { FieldValue, type CollectionReference, type QueryDocumentSnapshot } from "firebase-admin/firestore";

export class SessionNotJoinableError extends Error {
  constructor(pin: string) {
    super(`No joinable session for PIN ${pin}.`);
    this.name = "SessionNotJoinableError";
  }
}

// The realtime transport no longer caps this (the old limit was Ably's
// 200-concurrent-connection plan ceiling). What still bounds it is
// submitAnswer's per-question transaction concurrency, verified safe at 190
// concurrent submits in the migration plan's Phase 2 spike but not beyond —
// so 190 stays until that's re-tested at higher load (see load-test/README.md
// and docs/firestore-migration.md).
export const MAX_PLAYERS_PER_SESSION = 190;

export class SessionFullError extends Error {
  constructor(pin: string) {
    super(`Session ${pin} is full (max ${MAX_PLAYERS_PER_SESSION} players).`);
    this.name = "SessionFullError";
  }
}

/** Any session that hasn't ended yet is joinable — mirrors the pin.ts uniqueness query. */
async function findJoinableSession(pin: string): Promise<QueryDocumentSnapshot | null> {
  const snap = await firestore
    .collection("gameSessions")
    .where("pin", "==", pin)
    .where("status", "in", ["LOBBY", "ACTIVE"])
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

/** Appends " (2)", " (3)", ... until the nickname is free within the session. */
async function uniqueNickname(playersRef: CollectionReference, requested: string): Promise<string> {
  const existing = await playersRef.get();
  const taken = new Set(existing.docs.map((doc) => doc.data().nickname as string));
  if (!taken.has(requested)) return requested;

  let suffix = 2;
  while (taken.has(`${requested} (${suffix})`)) suffix += 1;
  return `${requested} (${suffix})`;
}

/**
 * Joins a player to a session by PIN: any session that hasn't ended yet is
 * joinable, including one already in progress — a late joiner lands in a
 * waiting state until the next question (QA 9.1's mid-question join case),
 * rather than being rejected outright. Auto-suffixes colliding nicknames.
 * The host's live roster picks up the new player from a listener straight
 * onto this `players` subcollection (see subscribeToRoster), so there's no
 * player_joined event to publish here.
 */
export async function joinSession(pin: string, requestedNickname: string) {
  const sessionDoc = await findJoinableSession(pin);
  if (!sessionDoc) throw new SessionNotJoinableError(pin);

  const playersRef = sessionDoc.ref.collection("players");
  const existingCountSnap = await playersRef.count().get();
  if (existingCountSnap.data().count >= MAX_PLAYERS_PER_SESSION) throw new SessionFullError(pin);

  const nickname = await uniqueNickname(playersRef, requestedNickname);
  const playerRef = playersRef.doc();
  await playerRef.set({
    // Redundant with the doc ID, but needed as a real field so
    // src/app/api/players/[playerId]/route.ts can resolve a player by ID
    // alone via a collectionGroup("players") query, without the client
    // having to also know/send which session it belongs to.
    playerId: playerRef.id,
    gameSessionId: sessionDoc.id,
    nickname,
    estimatedLatencyMs: null,
    joinedAt: FieldValue.serverTimestamp(),
  });

  const session = sessionDoc.data();
  return {
    id: playerRef.id,
    gameSessionId: sessionDoc.id,
    nickname,
    estimatedLatencyMs: null,
    sessionStatus: session.status as string,
  };
}
