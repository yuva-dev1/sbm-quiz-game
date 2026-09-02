// Real players, not HTTP-only VUs: each bot joins over the API, then opens a
// genuine Firestore listener on the session's broadcast event log — the same
// transport the browser client uses (src/lib/sessionBroadcastClient.ts).
// Use this to exercise the realtime path itself: listener fan-out, and the
// delivery gap between `question_start` landing and the question's own
// `optionsRevealedAt` (the lead-time reveal — the jitter budget that keeps
// latency-compensated scoring fair; see docs/formula-audit.md).
//
// Usage:
//   node load-test/realtime-bot.mjs <pin> [count] [baseUrl]
//
// Needs the Firebase web config in the environment (same vars the app build
// uses) — loaded from .env here:
//   NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_PROJECT_ID,
//   NEXT_PUBLIC_FIREBASE_APP_ID, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
//   NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST (optional — point at the emulator)
//
// Then drive the game from another terminal (advance-session.mjs) and watch
// the per-question delivery-gap summary this prints.

import "dotenv/config";
import { initializeApp } from "firebase/app";
import {
  collection,
  connectFirestoreEmulator,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";

const [, , pin, countArg = "50", baseUrl = "http://localhost:3000"] = process.argv;
const count = Number(countArg);

if (!pin || Number.isNaN(count)) {
  console.error("Usage: node load-test/realtime-bot.mjs <pin> [count] [baseUrl]");
  process.exit(1);
}

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
if (!firebaseConfig.projectId) {
  console.error("Missing NEXT_PUBLIC_FIREBASE_* env — see this file's header.");
  process.exit(1);
}

const db = getFirestore(initializeApp(firebaseConfig));
const emulatorHost = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
if (emulatorHost) {
  const [host, port] = emulatorHost.split(":");
  connectFirestoreEmulator(db, host, Number(port));
  console.log(`(emulator ${emulatorHost})`);
}

/** Join over the real API so the bot is an actual Player in the session. */
async function join(index) {
  const res = await fetch(`${baseUrl}/api/players`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin, nickname: `RealtimeBot-${index}` }),
  });
  if (!res.ok) throw new Error(`join ${index} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).playerId;
}

// seq the bot starts tailing from — like a fresh page load, everything after
// "now". Read the parent doc once via a short-lived listener.
function currentSeq() {
  return new Promise((resolve) => {
    const unsub = onSnapshot(
      query(collection(db, "sessionBroadcasts", pin, "events"), orderBy("seq", "desc")),
      (snap) => {
        unsub();
        resolve(snap.empty ? 0 : snap.docs[0].data().seq);
      }
    );
  });
}

const gaps = []; // ms between question_start delivery and optionsRevealedAt

function startBot(sinceSeq) {
  let lastSeq = sinceSeq;
  return onSnapshot(
    query(
      collection(db, "sessionBroadcasts", pin, "events"),
      where("seq", ">", sinceSeq),
      orderBy("seq", "asc")
    ),
    (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        const event = change.doc.data();
        if (event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        if (event.name === "question_start" && event.data?.optionsRevealedAt) {
          gaps.push(event.data.optionsRevealedAt - Date.now());
        }
      }
    }
  );
}

console.log(`Joining ${count} bots to ${pin}…`);
await Promise.all(Array.from({ length: count }, (_, i) => join(i)));
const sinceSeq = await currentSeq();
const unsubs = Array.from({ length: count }, () => startBot(sinceSeq));
console.log(`${count} listeners open (from seq ${sinceSeq}). Drive the game now; Ctrl-C to stop.`);

function summarize() {
  if (!gaps.length) {
    console.log("\nNo question_start events observed.");
    return;
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const negative = sorted.filter((g) => g < 0).length;
  console.log(
    `\nquestion_start delivery vs optionsRevealedAt (${sorted.length} samples across ${count} bots):`
  );
  console.log(`  lead remaining at delivery — min ${sorted[0]}ms  p50 ${pct(50)}ms  p95 ${pct(95)}ms  max ${sorted.at(-1)}ms`);
  console.log(
    `  ${negative} sample(s) arrived AFTER the reveal (negative lead) — those players lost reaction time.`
  );
}

process.on("SIGINT", () => {
  unsubs.forEach((u) => u());
  summarize();
  process.exit(0);
});
