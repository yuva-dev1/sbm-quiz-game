# Formula correctness audit (Story 9.4)

Re-verifying the scoring formula (Story 4.3) and latency compensation
(Story 4.2) is called out in the plan as the one area where a subtle bug
directly translates into "the game was unfair" — the worst failure mode
for this audience. This is a record of the verification done so far, not a
substitute for periodically re-running it as the code changes.

## The formula

```
trueReactionTime = clamp(rawReactionTime - estimatedLatencyMs / 2, 0, timeLimit)
points = correct ? round(1000 * (1 - (trueReactionTime / timeLimit) / 2)) : 0
```

Implementation: `src/lib/scoring.ts`. Deliberately pure functions with no
I/O, so they can be tested in complete isolation from the DB/realtime/network.

## Layer 1 — unit tests (`src/lib/scoring.test.ts`)

11 cases against hand-calculated expected values, run as part of `npm test`
in CI-equivalent form on every branch:

- Correct answer, instant response → full 1000 points
- Correct answer, exactly at the deadline → 500 points (half)
- Correct answer, exactly halfway → 750 points
- Incorrect answer at any speed → always 0
- A non-round-number case (15s limit, 6s reaction) → 800 points, computed
  by hand as `round(1000 * (1 - (6000/15000)/2)) = round(800) = 800`
- Latency compensation subtracting correctly, and clamping in both
  directions (negative-after-compensation → 0; still-over-limit → clamped
  to timeLimit)

## Layer 2 — live verification against the real pipeline

Two independent cases, computed by hand *before* looking at what the
running app produced, then checked against it:

**Case 1** (Feature 4 PR): 20s time limit, player latency set to a known
2000ms, real observed raw reaction time 5385ms.
`trueReactionTime = 5385 - 1000 = 4385ms`.
`points = round(1000 * (1 - (4385/20000)/2)) = round(890.375) = 890`.
The app produced exactly 890 — confirmed in both the `Answer` row and the
Redis leaderboard (`ZREVRANGE`).

**Case 2** (Feature 9 load-test sanity check): 20s time limit, three
players answering near-simultaneously close to the deadline. All three
scored identically (521 points) for the same correct choice, and the two
incorrect answers both scored exactly 0 — consistent with the formula
(same reaction time → same score) and with "incorrect is always 0"
regardless of speed.

## What this doesn't cover yet

Real-world network latency. Every case above ran over loopback in one
process — `estimatedLatencyMs` was either set explicitly for the test or was
a real but small (~10-15ms) local measurement. Note scoring never depends on
realtime-transport delivery time anyway (reaction time is `serverReceivedAt`
minus the server-set `optionsRevealedAt`); the transport only has to deliver
`question_start` before the lead-time reveal, which the Firestore listener
does well within the default 5s lead. The formula's actual real-world fairness claim — that a
player in India isn't penalized relative to one in the US — can only be
confirmed with real cross-region latency, which is QA 9.2's job, not this
audit's.
