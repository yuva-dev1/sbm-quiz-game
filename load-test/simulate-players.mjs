// Simulates up to ~1000 virtual players against a live session from one
// machine — the join burst, a real Firestore listener per player, and an
// answer burst timed to fire in the last ~1.5s before each question's
// deadline (Story 9.3's worst case).
//
// Usage:
//   node load-test/simulate-players.mjs <pin> <count> [baseUrl] [options]
//
// Options:
//   --answer            also submit an answer per question (default: listen only)
//   --duration <secs>   auto-print the summary and exit after N seconds
//   --label <str>       prefix for log lines (use when running several copies)
//   --fire-before <ms>  answer this many ms before the deadline (default 1500, jittered 0..this)
//
// Env: NEXT_PUBLIC_FIREBASE_* (from .env). Set NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=
// empty to hit real Firestore.
//
// The Firestore JS SDK collapses identical listeners within ONE process to a
// single server-side target, so for a faithful fan-out measurement run
// several copies in parallel (e.g. 10 × count 50) rather than one big one.
// For the join/answer/counter-contention path, one process at full count is
// faithful — those are independent HTTP requests.

import "dotenv/config";
import { initializeApp } from "firebase/app";
import { collection, connectFirestoreEmulator, getFirestore, onSnapshot, orderBy, query, where } from "firebase/firestore";

try {
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new Agent({ connections: 2000, pipelining: 1 }));
} catch {
  console.warn("(undici not importable — answer burst limited to the default socket pool)");
}

const args = process.argv.slice(2);
const [pin, countStr, maybeBase] = args.filter((a) => !a.startsWith("--"));
const baseUrl = maybeBase && maybeBase.startsWith("http") ? maybeBase : "http://localhost:3000";
const count = Number(countStr);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1] ?? true;
};
const doAnswer = args.includes("--answer");
const durationSecs = Number(opt("--duration", 0));
const label = opt("--label", "");
const fireBefore = Number(opt("--fire-before", 1500));
const tag = label ? `[${label}] ` : "";

if (!pin || Number.isNaN(count)) {
  console.error("Usage: node load-test/simulate-players.mjs <pin> <count> [baseUrl] [--answer] [--duration N] [--label X]");
  process.exit(1);
}

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
if (!firebaseConfig.projectId) {
  console.error("Missing NEXT_PUBLIC_FIREBASE_* — see .env / this file's header.");
  process.exit(1);
}
const db = getFirestore(initializeApp(firebaseConfig, `sim-${label || Date.now()}`));
const emu = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
if (emu) {
  const [h, p] = emu.split(":");
  connectFirestoreEmulator(db, h, Number(p));
}

const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN);
const now = () => Date.now();

// ---- metrics ---------------------------------------------------------------
const joinLatencies = [];
let joinOk = 0;
const joinErrors = {};
const answersByQ = new Map(); // questionId -> { sent, ok, rejected:{reason:n}, errored, latencies:[] }
const deliveryByQ = new Map(); // questionId -> { optionsRevealedAt, receiveGaps:[ms remaining] }
let lockEventsSeen = 0;
let answerCountUpdates = 0;

// ---- 1. join burst -------------------------------------------------------
console.log(`${tag}joining ${count} players to ${pin} at ${baseUrl}…`);
const players = [];
await Promise.all(
  Array.from({ length: count }, async (_, i) => {
    const t0 = now();
    try {
      const res = await fetch(`${baseUrl}/api/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, nickname: `Sim${label || ""}-${i}` }),
      });
      joinLatencies.push(now() - t0);
      if (res.ok) {
        const body = await res.json();
        players.push({ id: body.playerId, choicesSeen: false });
        joinOk++;
      } else {
        const b = await res.json().catch(() => ({}));
        joinErrors[`${res.status}: ${b.error ?? "?"}`] = (joinErrors[`${res.status}: ${b.error ?? "?"}`] ?? 0) + 1;
      }
    } catch (e) {
      joinErrors[`fetch: ${e.message}`] = (joinErrors[`fetch: ${e.message}`] ?? 0) + 1;
    }
  })
);
console.log(`${tag}joined ${joinOk}/${count}  (latency p50 ${pct(joinLatencies, 50)}ms  p95 ${pct(joinLatencies, 95)}ms  max ${Math.max(...joinLatencies, 0)}ms)`);
if (Object.keys(joinErrors).length) console.log(`${tag}join errors:`, joinErrors);
if (!players.length) { summarize(); process.exit(0); }

// ---- 2. one listener per player (SDK may collapse within this process) ---
function submitAnswer(player, q) {
  const rec = answersByQ.get(q.questionId);
  rec.sent++;
  const t0 = now();
  fetch(`${baseUrl}/api/sessions/${pin}/answers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: player.id, questionId: q.questionId, choiceIndices: [Math.floor(Math.random() * Math.max(1, (q.choices?.length ?? 4)))] }),
  })
    .then(async (res) => {
      rec.latencies.push(now() - t0);
      if (res.ok) rec.ok++;
      else {
        const b = await res.json().catch(() => ({}));
        const key = `${res.status}: ${b.error ?? "?"}`;
        rec.rejected[key] = (rec.rejected[key] ?? 0) + 1;
      }
    })
    .catch((e) => {
      rec.latencies.push(now() - t0);
      rec.errored++;
      rec.rejected[`fetch: ${e.message}`] = (rec.rejected[`fetch: ${e.message}`] ?? 0) + 1;
    });
}

function handleEvent(player, ev, seenSeq) {
  if (ev.seq <= seenSeq.v) return;
  seenSeq.v = ev.seq;
  if (ev.name === "question_start") {
    const q = ev.data;
    if (!answersByQ.has(q.questionId)) answersByQ.set(q.questionId, { sent: 0, ok: 0, rejected: {}, errored: 0, latencies: [] });
    if (!deliveryByQ.has(q.questionId)) deliveryByQ.set(q.questionId, { optionsRevealedAt: q.optionsRevealedAt, receiveGaps: [] });
    deliveryByQ.get(q.questionId).receiveGaps.push(q.optionsRevealedAt - now());
    if (doAnswer && !player.answeredQ?.[q.questionId]) {
      player.answeredQ = player.answeredQ ?? {};
      player.answeredQ[q.questionId] = true;
      const deadline = q.optionsRevealedAt + (q.timeLimitSecs ?? 20) * 1000;
      const at = deadline - Math.random() * fireBefore;
      setTimeout(() => submitAnswer(player, q), Math.max(0, at - now()));
    }
  } else if (ev.name === "question_locked") {
    lockEventsSeen++;
  } else if (ev.name === "answer_count_update") {
    answerCountUpdates++;
  }
}

// start each listener from the log's current head
async function currentSeq() {
  return new Promise((resolve) => {
    const u = onSnapshot(query(collection(db, "sessionBroadcasts", pin, "events"), orderBy("seq", "desc")), (s) => {
      u();
      resolve(s.empty ? 0 : s.docs[0].data().seq);
    });
  });
}
const sinceSeq = await currentSeq();
const unsubs = players.map((player) => {
  const seenSeq = { v: sinceSeq };
  return onSnapshot(
    query(collection(db, "sessionBroadcasts", pin, "events"), where("seq", ">", sinceSeq), orderBy("seq", "asc")),
    (snap) => { for (const c of snap.docChanges()) if (c.type === "added") handleEvent(player, c.doc.data(), seenSeq); }
  );
});
console.log(`${tag}${unsubs.length} listeners open from seq ${sinceSeq}. ${doAnswer ? "Will answer each question." : "Listen-only."}  Drive the game now.`);

// ---- 3. summary ----------------------------------------------------------
function summarize() {
  console.log(`\n${tag}===== SUMMARY =====`);
  console.log(`${tag}join: ${joinOk}/${count} ok · latency p50 ${pct(joinLatencies, 50)}ms p95 ${pct(joinLatencies, 95)}ms max ${Math.max(...joinLatencies, 0)}ms`);
  if (Object.keys(joinErrors).length) console.log(`${tag}join errors:`, joinErrors);
  const allGaps = [];
  for (const [qid, d] of deliveryByQ) {
    allGaps.push(...d.receiveGaps);
    const g = d.receiveGaps;
    console.log(`${tag}q ${qid.slice(0, 6)} question_start delivered ${g.length}× · lead remaining min ${pct(g, 0)}ms p50 ${pct(g, 50)}ms max ${pct(g, 100)}ms · ${g.filter((x) => x < 0).length} after reveal`);
  }
  if (allGaps.length) console.log(`${tag}delivery ALL: p50 ${pct(allGaps, 50)}ms p95 ${pct(allGaps, 95)}ms worst ${pct(allGaps, 0)}ms · ${allGaps.filter((x) => x < 0).length}/${allGaps.length} late`);
  for (const [qid, r] of answersByQ) {
    console.log(`${tag}q ${qid.slice(0, 6)} answers: sent ${r.sent} · 200 ${r.ok} · rejected ${JSON.stringify(r.rejected)} · errored ${r.errored} · latency p50 ${pct(r.latencies, 50)}ms p95 ${pct(r.latencies, 95)}ms p99 ${pct(r.latencies, 99)}ms max ${Math.max(...r.latencies, 0)}ms`);
  }
  console.log(`${tag}events seen: question_locked ${lockEventsSeen} · answer_count_update ${answerCountUpdates}`);
}

process.on("SIGINT", () => { unsubs.forEach((u) => u()); summarize(); process.exit(0); });
if (durationSecs > 0) {
  setTimeout(() => { unsubs.forEach((u) => u()); summarize(); process.exit(0); }, durationSecs * 1000);
}
