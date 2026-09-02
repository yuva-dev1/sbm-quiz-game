import { afterEach, describe, expect, it } from "vitest";
import { publishToSession, sessionBroadcastRef } from "@/lib/sessionBroadcast";
import { firestore } from "@/lib/firestore";

const pins: string[] = [];

function testPin(): string {
  const pin = String(100000 + Math.floor(Math.random() * 900000));
  pins.push(pin);
  return pin;
}

afterEach(async () => {
  await Promise.all(pins.splice(0).map((pin) => firestore.recursiveDelete(sessionBroadcastRef(pin))));
});

describe("publishToSession", () => {
  it("appends events under a per-session, 1-based monotonic seq", async () => {
    const pin = testPin();

    await publishToSession(pin, "game_started", {});
    await publishToSession(pin, "question_start", { questionIndex: 0 });
    await publishToSession(pin, "question_locked", { questionId: "q1" });

    const parentSnap = await sessionBroadcastRef(pin).get();
    expect(parentSnap.data()?.seq).toBe(3);

    const eventsSnap = await sessionBroadcastRef(pin).collection("events").orderBy("seq").get();
    expect(eventsSnap.docs.map((doc) => doc.data().seq)).toEqual([1, 2, 3]);
    expect(eventsSnap.docs.map((doc) => doc.data().name)).toEqual([
      "game_started",
      "question_start",
      "question_locked",
    ]);
    // Payload round-trips untouched — this is the client's event data.
    expect(eventsSnap.docs[1].data().data).toEqual({ questionIndex: 0 });
    // TTL sweeper target is set on every event.
    expect(eventsSnap.docs[0].data().expireAt).toBeDefined();
  });

  it("keeps two sessions' seq counters independent", async () => {
    const a = testPin();
    const b = testPin();

    await publishToSession(a, "game_started", {});
    await publishToSession(b, "game_started", {});
    await publishToSession(a, "question_start", {});

    expect((await sessionBroadcastRef(a).get()).data()?.seq).toBe(2);
    expect((await sessionBroadcastRef(b).get()).data()?.seq).toBe(1);
  });

  it("assigns a distinct seq to every event in a same-tick burst", async () => {
    const pin = testPin();

    // The lock path fires three events back-to-back with no await between
    // them at the call site — they must still land as 1/2/3, not collide.
    await Promise.all([
      publishToSession(pin, "question_locked", {}),
      publishToSession(pin, "leaderboard_update", {}),
      publishToSession(pin, "answer_breakdown", {}),
    ]);

    const eventsSnap = await sessionBroadcastRef(pin).collection("events").orderBy("seq").get();
    expect(eventsSnap.docs.map((doc) => doc.data().seq)).toEqual([1, 2, 3]);
    expect(new Set(eventsSnap.docs.map((doc) => doc.id)).size).toBe(3);
  });

  it("never throws when the write fails (broadcast is best-effort)", async () => {
    // A path segment can't exceed 1500 bytes — force the transaction to
    // reject and confirm publishToSession swallows it.
    await expect(publishToSession("x".repeat(2000), "game_started", {})).resolves.toBeUndefined();
  });
});
