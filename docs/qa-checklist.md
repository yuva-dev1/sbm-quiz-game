# QA checklist

Working list against Feature 9 of `kahoot-dev-plan.md`. This is the long
pole on purpose — work through it until confident, not until a calendar
date. Items marked **done** were verified during the build itself (each
feature's PR description has the specific scenario and result); items
marked **needs a human** require real devices, real people, or a real
deployment that weren't available while building.

## 9.1 — Functional pass (single device, no load)

- [x] Full game flow start to finish, host + one player — verified
  repeatedly across Features 1-5 (session create → join → live questions →
  scoring → leaderboard → podium). Originally against Ably/Postgres/Redis;
  the stack is now Firestore (data + realtime listener) + Redis.
- [ ] **Needs a deployment**: re-verify that full flow against real Firestore
  (not the emulator) after the Ably→Firestore realtime move — listener
  delivery timing for `question_start` vs. the lead-time reveal, host roster
  updates, reconnect resume via `initialBroadcastSeq`. See
  `docs/firestore-migration.md` "Realtime" and `load-test/realtime-bot.mjs`.
- [x] Player joins mid-question — lands waiting for the next question, not
  broken (Feature 2's fix; the plan's literal Story 2.1 wording would have
  rejected this, QA 9.1 explicitly expects it to work).
- [x] Player answers exactly at the deadline — server rejects anything past
  `startedAt + timeLimitSecs` regardless of client state (Feature 3/4).
- [x] Player submits two answers rapidly — second rejected via a DB unique
  constraint, verified with a real double-fire from the same tab (Feature
  3).
- [x] Reconnect mid-question (refresh/dropped connection) — resumes the
  live question with an accurate remaining countdown, not "waiting"
  (Feature 7.1, verified: 17s → 6s across a real reload).
- [ ] **Needs a human**: same pass on an actual phone, on real wifi and
  real cellular. Everything above was verified in a desktop browser
  automation tool — it exercises the same API and realtime-listener wiring a
  phone would, but touch interactions, mobile Safari/Chrome quirks, and real
  network conditions are unverified.

## 9.2 — Multi-device pass (5-20 real people)

- [ ] **Needs a human**: recruit a small real group, ideally spanning at
  least two regions (e.g. one person in India/Singapore joining a session
  run from the US), to sanity-check the latency compensation formula
  against real-world RTT numbers before trusting it at 500-1000 scale.
- [ ] **Needs a human**: verify leaderboard ordering matches expectations
  given the group's actual observed reaction times.

What's already true going into this: the latency-compensation formula
itself is unit-tested and independently hand-verified against live runs
(see `docs/formula-audit.md`) — what this step specifically adds is
real network latency instead of the ~0-15ms loopback latency every
automated test in this repo necessarily has.

## 9.3 — Load test (simulated, before the real event)

- [x] Tooling built and sanity-checked (`load-test/`, see its README for
  the full writeup, including a real connection-limit finding from that
  sanity check).
- [ ] **Needs a real deployment**: the actual 500-1000 concurrent
  join-then-burst-answer run. Only meaningful against a real deployed
  environment (Feature 8) with a real Postgres/Redis, not local dev.

## 9.4 — Formula correctness audit

- [x] See `docs/formula-audit.md` — unit tests with hand-calculated fixed
  cases (Feature 4), plus two independent live-run verifications where the
  formula's output was hand-computed ahead of time and matched exactly
  (890 points and 521 points cases).

## 9.5 — Dress rehearsal

- [ ] **Needs a human**: full run-through with the actual quiz content, the
  actual host, and as many real remote testers as can be gathered, at
  least once before the live event. Nothing in this repo can substitute
  for this — it's the step that actually proves the whole system holds up
  end to end, under real people's actual behavior, not simulated load.
