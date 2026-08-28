# Topic-scoped grounding for quiz generation

## The problem

`getSourceText` used to take only week ids and return the concatenation of
**every** source document for **every** selected week. That whole blob was then
handed to `generateQuiz`, which passed it unchanged into every model call —
every draft, every repair, and every judge call. A 25-question quiz makes
100–300 such calls, so picking a single topic still re-uploaded the entire week
(or, for "all weeks", the entire ~21k-token course corpus) hundreds of times.
That was the dominant cost in 300-second generations.

The topic picker on `/host` narrowed the *topic labels* fed to the prompt
(`resolveGenerationScope`) but not the grounding text. This change makes topic
selection actually shrink the grounding text.

## The index

`src/data/courseTopicText.json` — `{ weekId: { "<exact catalog topic>": "<excerpt>" } }`.

Each excerpt is hand-authored from that week's own course notes
(`content/course-notes/<week>/`), following the same "curated, committed,
reviewed" pattern the repo already uses for the infographic transcriptions and
the `courseCatalog.json` topic lists. The keys must match the topic strings in
`src/data/courseCatalog.json` exactly; `courseCatalog.test.ts` fails if any
catalog topic is missing an excerpt or any index key is stale.

Adding a new week: after curating its topic list in `courseCatalog.json`, add a
`courseTopicText.json` block for it — one excerpt per topic, drawn only from
that week's notes. An excerpt can be reused across two closely-related topics;
`getSourceText` de-dupes identical passages when it concatenates.

## Two consumers

### `getSourceText(weeks, weekIds, topics?)` — the run-wide fallback

- No `topics` (host picked "All topics") → full notes for each selected week.
- `topics` given → for each week, concatenate just the excerpts for that week's
  selected topics. A week falls back to its full notes when **every** one of its
  topics was selected anyway, when it has no index block, or when the selected
  topics resolve to less than `MIN_TOPIC_SCOPE_CHARS` (4000) of text.

`generateQuizRequest.ts` now always calls this with `topics: null` — it's the
whole-selection text handed to `generateQuiz` as `sourceText`, used only as the
fallback when a slot's focus topic has no index entry.

### `getTopicSourceText(weeks, weekIds, topics?)` — per-slot grounding

Returns `{ <exact catalog topic>: <excerpt> }` for every in-scope topic. Unlike
`getSourceText` it does **not** collapse to full-week text when every topic is
selected — the point is that each generation and judge call sees only its one
slot's passage. `localQuizGenerator` builds each slot's grounding text from its
`focusTopic`'s entry (plus a sibling passage or two to clear a small floor),
and the unpinned relaxed top-up from the union of all in-scope passages.

`generateQuizRequest.ts` passes this for **every** quiz, LIVE and SELF_PACED
alike. A slot still sees real, on-topic source text, and the verbatim /
faithfulness checks run against exactly that per-slot text, so grounding is
narrowed per question, never weakened. See `docs/self-hosted-llm.md` for why
this is the single biggest latency lever on the self-hosted backend.
