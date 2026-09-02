import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirestoreClient } from "@/lib/firebaseClient";

export type BroadcastEvent = { seq: number; name: string; data: unknown };

/**
 * Tails a session's broadcast event log, replacing the old Ably channel
 * subscription. Calls `onEvent` once for every event with `seq > sinceSeq`,
 * in order. Returns an unsubscribe function.
 *
 * `sinceSeq` is the seq the server rendered into the page (SSR), so a
 * mid-game mount or a reconnect resumes exactly where the server-rendered
 * state left off — nothing replayed, and no hydration-window gap the way a
 * wall-clock cutoff would leave.
 *
 * Firestore re-delivers already-seen docs as `added` after some
 * offline→online transitions; the `lastSeq` guard makes a resumed listener
 * idempotent regardless.
 */
export function subscribeToSession(
  pin: string,
  sinceSeq: number,
  onEvent: (event: BroadcastEvent) => void
): () => void {
  const db = getFirestoreClient();
  let lastSeq = sinceSeq;

  const eventsQuery = query(
    collection(db, "sessionBroadcasts", pin, "events"),
    where("seq", ">", sinceSeq),
    orderBy("seq", "asc")
  );

  return onSnapshot(eventsQuery, (snap) => {
    for (const change of snap.docChanges()) {
      if (change.type !== "added") continue;
      const event = change.doc.data() as BroadcastEvent;
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      onEvent({ seq: event.seq, name: event.name, data: event.data });
    }
  });
}

export type RosterPlayer = { id: string; nickname: string };

/**
 * Live player roster for the host lobby — a listener straight onto the
 * session's `players` subcollection (the source of truth), rather than a
 * replayed stream of player_joined events. Fires `onRoster` with the full
 * ordered list on every change.
 */
export function subscribeToRoster(
  sessionId: string,
  onRoster: (players: RosterPlayer[]) => void
): () => void {
  const db = getFirestoreClient();
  const rosterQuery = query(
    collection(db, "gameSessions", sessionId, "players"),
    orderBy("joinedAt", "asc")
  );

  return onSnapshot(rosterQuery, (snap) => {
    onRoster(snap.docs.map((doc) => ({ id: doc.id, nickname: doc.data().nickname as string })));
  });
}
