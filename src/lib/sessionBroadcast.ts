import { firestore } from "@/lib/firestore";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Server-side realtime fan-out. Every live-session event (players + host)
 * flows through a per-session append-only log in Firestore that clients tail
 * with a realtime listener (see src/lib/sessionBroadcastClient.ts). This
 * replaces the previous Ably channel (`game:{pin}`) — same event
 * names/payloads (src/lib/events.ts), different transport.
 *
 * Shape:
 *   sessionBroadcasts/{pin}              -> { seq, updatedAt }
 *   sessionBroadcasts/{pin}/events/{seq} -> { seq, name, data, at, expireAt }
 *
 * `seq` is a per-session monotonic counter bumped in the same transaction as
 * each event write. Clients ask for "only events after N" (N seeded from the
 * server-rendered page), so a mid-game join or a reconnect resumes cleanly
 * with nothing lost and nothing replayed — a plain timestamp cutoff would
 * drop events that land in the hydration window, and Firestore's snapshot
 * coalescing would otherwise collapse events emitted in the same tick
 * (question_locked + leaderboard_update + answer_breakdown all fire together
 * when a question locks) into a single delivered state.
 *
 * The event log is deliberately host-paced: the only events on it are ones a
 * host action (or a per-question timer) triggers, at most three back-to-back,
 * so the single-doc `seq` counter never sees burst contention. The one
 * high-fan-in event, player_joined, is intentionally NOT here — the host
 * roster listens to the `players` subcollection directly instead.
 */

/** How long a session's event log lives before Firestore's TTL sweeper may
 * delete it (configure the policy on the `expireAt` field — see
 * docs/firestore-migration.md). Long enough to outlast the longest plausible
 * game plus late reconnects; deleteCompletedSession also clears it eagerly. */
const EVENT_TTL_MS = 6 * 60 * 60 * 1000;

/** Zero-padded so the doc ID sorts in seq order in the console too, and so a
 * retried transaction re-addresses the same doc rather than creating a
 * duplicate (an auto-ID would not). 6 digits covers far more events than any
 * real game produces. */
function eventDocId(seq: number): string {
  return String(seq).padStart(6, "0");
}

export function sessionBroadcastRef(pin: string) {
  return firestore.collection("sessionBroadcasts").doc(pin);
}

/**
 * Appends a named event to a session's broadcast log. Never throws: by the
 * time anything calls this, the actual state change (DB write, score update,
 * session finalization) has already succeeded, and a broadcast hiccup must
 * not fail the request or strand the session.
 */
export async function publishToSession(
  pin: string,
  eventName: string,
  data: unknown
): Promise<void> {
  const parentRef = sessionBroadcastRef(pin);
  try {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(parentRef);
      const seq = ((snap.data()?.seq as number | undefined) ?? 0) + 1;
      tx.set(parentRef, { seq, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(parentRef.collection("events").doc(eventDocId(seq)), {
        seq,
        name: eventName,
        data,
        at: FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + EVENT_TTL_MS),
      });
    });
  } catch (error) {
    console.error(`Session broadcast failed for ${pin}/${eventName}:`, error);
  }
}
