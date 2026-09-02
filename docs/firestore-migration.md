# Postgres/Prisma → Firestore migration

Management wanted off Supabase Postgres and onto Firebase. Firestore (native mode) was chosen
over Firebase's Postgres-preserving "SQL Connect" product — the actual NoSQL document store, not
a relational swap. This required real data-modeling decisions, not a mechanical schema port; this
doc records them and why, since the reasoning isn't visible from the code alone.

## Collection layout

```
quizzes/{quizId}                                  Quiz
  questions/{questionId}                          Question (subcollection, ordered by `order` field)
  responses/{sha256(respondentRegNo)}              QuizResponse (doc ID = hashed regNo)

gameSessions/{sessionId}                          GameSession (top-level — looked up by pin)
  sessionQuestions/{gsQuestionId}                   GameSessionQuestion (frozen copy, batch-written at session creation)
    answers/{playerId}                                Answer (doc ID = playerId)
  players/{playerId}                                Player (doc ID = playerId)
  results/{playerId}                                SessionResult (doc ID = playerId)
```

## Key decisions

**`sessionQuestions`, not `questions`.** Firestore collection-group queries match by collection
name across the *entire* database. `generateQuizRequest.ts` runs a
`collectionGroup("questions")` query over Quiz's own question banks (for generation dedup) — if
the frozen per-session copy used the same subcollection name, that query would silently pull in
every session's frozen questions too. Different name, no collision, no filter needed to tell them
apart.

**Doc-ID-as-natural-key, not app-level unique-constraint checks.** `Answer` (doc ID = `playerId`
under its question), `SessionResult` (doc ID = `playerId` under its session), `QuizResponse` (doc
ID = `sha256(respondentRegNo)` — hashed because Firestore doc IDs reject `/` and have other
validity constraints a free-text registration number could violate). A `create()` at an existing
path fails atomically — this replaced what used to be a Prisma unique-constraint violation
(`P2002`) caught after the fact. Firestore's equivalent error is gRPC code 6 (`ALREADY_EXISTS`),
confirmed empirically against the emulator.

**Write-time denormalization over N+1 read-time aggregation.** The host page's live view (all
questions, each with an answer count) has no Firestore join equivalent. `answeredCount`,
`correctCount`, `incorrectCount`, and `choiceCounts` are maintained as incrementing fields on each
`sessionQuestions` doc, updated in the same transaction as every `submitAnswer` call. Reads
(`lockCurrentQuestion`, the host page) become a single-doc read instead of scanning every Answer.
This mirrors the philosophy the app already used for the Redis leaderboard (`ZINCRBY` per answer,
never aggregated at read time) — just applied to a second dimension.

**`choiceCounts` is a map (`{"0": n, "1": n, ...}`), not an array.** Confirmed empirically during
the Phase 2 spike: Firestore's dotted-path field updates (`choiceCounts.0`) only ever address map
fields. Pointing one at a field that was initialized as an array silently converts it to a map and
**drops every other element** — the array form looked correct until the first concurrent write
corrupted it. This is the single most important gotcha from this migration; watch for it in any
future array-like counter design.

**GameSession stays top-level, not nested under its Quiz.** It's looked up by `pin` independent of
`quizId` everywhere (host/play pages, the join flow) — nesting would force carrying `quizId`
through every PIN-keyed lookup for no benefit.

**Firestore transactions require all reads before any writes** — unlike Prisma's interactive
`$transaction`, which could interleave them freely. The question-reorder-on-delete logic (delete a
question, repack remaining `order` values to stay contiguous) had to be restructured: read every
question first, then delete + update within the same transaction. Validated under two concurrently
overlapping deletes — Firestore's optimistic-concurrency retry re-reads the already-shifted state
automatically and still converges on a correct result.

**Player/Answer docs carry redundant fields for collection-group lookups.** `Player` stores
`playerId` (= its own doc ID) and `gameSessionId`, so a bare `playerId` (all the client ever holds)
can be resolved back to its owning session via `collectionGroup("players").where("playerId", "==",
...)`, then `.ref.parent.parent` for the session doc. `Answer` stores `gameSessionId` and
`playerId` similarly, so `getPlayerProgress` can count a player's answers across an entire session
via `collectionGroup("answers")` without needing every question's doc ID.

**190-player concurrent-write safety, confirmed not just assumed.** Plain `runTransaction` +
`FieldValue.increment()` handled 190 simultaneous `submitAnswer` calls against one parent question
doc with zero failures and correct final counts in the Phase 2 spike (`scripts/firestore-spike/`).
Firestore's documented sharded-counter pattern for hot documents was not needed at this app's real
scale.

**Every Quiz-creation site must set every default field explicitly.** Firestore has no
schema-level defaults the way Prisma's `@default(...)` did — a missing field reads back as
`undefined`, and `.set()`/`.update()` reject `undefined` outright. `src/lib/quizzes.ts`'s
`createQuiz()` is the one place this is handled, used by quiz generation, the seed script, and the
load-test fixture script, specifically so this can't drift across call sites again.

**Firestore has no cascade delete, at all.** The only place this mattered in practice: deleting a
Quiz needs `firestore.recursiveDelete()` to also remove its `questions`/`responses`
subcollections. `GameSession`/`Player`/`Answer`/`SessionResult` are never deleted anywhere in the
app, so no other cascade-delete handling was needed.

## What's still Redis, unchanged

The live leaderboard (`ZINCRBY`/`ZREVRANGE`) was out of scope for this migration and was not
touched. `finalizeSession` still reads the full Redis leaderboard once and snapshots it into
`results` docs — meaning a player who joined but never answered a single question never enters the
Redis sorted set, and therefore never gets a `SessionResult` doc. This is original, pre-migration
behavior, not something this migration changed.

## Realtime: Ably → Firestore listener (follow-up migration)

The `game:{pin}` Ably channel was later replaced with a per-session append-only event log in
Firestore, consolidating onto one backend and removing Ably's 200-concurrent-connection plan
ceiling.

- **Write side** (`src/lib/sessionBroadcast.ts`): `publishToSession(pin, name, data)` keeps its
  signature and its never-throws contract. It now runs one transaction per event — bump a
  per-session monotonic `seq` on `sessionBroadcasts/{pin}`, write the payload to
  `sessionBroadcasts/{pin}/events/{seq}`. The log is host-paced (at most three events back-to-back,
  at question-lock), so the single-doc `seq` counter never sees burst contention. `player_joined`
  was removed from the log entirely — see below.
- **Read side** (`src/lib/sessionBroadcastClient.ts`): browser `onSnapshot` on
  `events where seq > sinceSeq`. `sinceSeq` is the counter value the server rendered into the page
  (both `page.tsx` files read it and pass `initialBroadcastSeq`), so a mid-game mount or a
  reconnect resumes with nothing lost (a wall-clock cutoff would drop events landing in the
  hydration window) and nothing replayed against fresher SSR state.
- **Host roster**: `subscribeToRoster` listens straight to `gameSessions/{id}/players` — the
  source of truth — instead of a replayed `player_joined` stream. This also keeps the highest-fan-in
  event (a join burst) off the `seq` counter doc.
- **Rules**: `firestore.rules` grants public read on `sessionBroadcasts/**` and
  `gameSessions/{id}/players/**` — both hold only data Ably already delivered to any PIN holder.
  No Firebase Auth. All writes stay server-only.
- **Cleanup**: `deleteCompletedSession` recursively deletes `sessionBroadcasts/{pin}` alongside the
  session tree. Event docs also carry `expireAt` for a Firestore TTL policy as a backstop for
  abandoned logs — set it once per environment:
  ```bash
  gcloud firestore fields ttls update expireAt \
    --collection-group=events --enable-ttl --project=namabiksha-v1
  ```

**`MAX_PLAYERS_PER_SESSION`** was raised 190 → 1000 once realtime stopped being the bottleneck (190
was Ably's plan ceiling). The only remaining constraint is `submitAnswer`'s per-question transaction
concurrency — every answer increments counters on the one `sessionQuestions/{qid}` doc — which the
Phase 2 spike proved only to 190, on the emulator. Validate against real Firestore with
`load-test/` before trusting a full-size room; if counter contention degrades there, shard the
per-question tally doc.
