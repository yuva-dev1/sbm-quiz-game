# Topic-scoped grounding for quiz generation

## The problem

`getSourceText` used to take only week ids and return the concatenation of
**every** source document for **every** selected week. That whole blob was then
handed to `generateQuiz`, which passes it unchanged into every model call —
every draft, every repair, and every judge call (`scoreFaithfulness`,
`checkAnswerable`). A 25-question quiz makes 100–300 such calls, so picking a
single topic still re-uploaded the entire week (or, for "all weeks", the entire
~21k-token course corpus) hundreds of times. That was the dominant cost in
300-second generations.

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

## How `getSourceText` uses it

`getSourceText(weeks, weekIds, topics?)`:

- No `topics` (host picked "All topics") → full notes for each selected week,
  exactly as before.
- `topics` given → for each week, concatenate just the excerpts for that week's
  selected topics. A week falls back to its full notes when **every** one of its
  topics was selected anyway, when it has no index block, or when the selected
  topics resolve to less than `MIN_TOPIC_SCOPE_CHARS` (4000) of text.

`MIN_TOPIC_SCOPE_CHARS` is deliberately high. A handful of topics from a single
week still clears the week's own full-notes size, so scoping only actually
narrows anything for large selections (many topics, or several weeks at once) —
which is the only case where the un-scoped text was ever a real latency problem.
An earlier value of 600 let a two-topic pick hand the model a few hundred
characters and still ask for 8 questions; it came back with 5 shallow ones.

`generateQuizRequest.ts` only passes the resolved `scopeTopics` when
**`mode === "SELF_PACED"`** and the request actually named topics. A `LIVE`
(Kahoot) quiz always gets the full week's notes — topic-scoping can never change
what a live session serves. An empty topic list ("all topics") stays on the
full-week path in both modes.
