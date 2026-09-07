# Embedding a week's quiz in the Squarespace course

Each week's quiz replaces the Google Form on that week's Squarespace lesson
page. The member is already signed in to Squarespace; the embed reads their
`siteUserId` from the `SiteUserInfo` cookie and passes it to the quiz app,
which resolves their name + email via the Squarespace Profiles API and records
the attempt in the Sheet. No second sign-in.

## Per lesson

1. Open the "Week N Quiz" lesson in the Squarespace editor.
2. Remove the Google Form embed block.
3. Add a **Code Block** and paste [`squarespace-quiz-embed-snippet.html`](./squarespace-quiz-embed-snippet.html).
4. At the top of the snippet set:
   - `WEEK` — the week number (`1`, `2`, …).
   - `COURSE_APP` — the quiz app base URL
     (`https://self-paced.srimadbhagavatamcourse.org`, or the
     `bhagavatham-self-paced-course-…run.app` URL until DNS is live).

The snippet renders the quiz in an auto-resizing iframe and shows a friendly
message if the visitor isn't signed in.

## How identity flows

- `SiteUserInfo` cookie → `{ siteUserId, firstName, authenticated }` (client-side).
- iframe src: `COURSE_APP/q/<WEEK>?sid=<siteUserId>&back=<this lesson's URL>`.
- App server: `GET /api/q/:n` → `resolveMember(sid)` → Members sheet, else
  `GET https://api.squarespace.com/1.0/profiles/<sid>` (needs `SQUARESPACE_API_KEY`
  with Profiles read scope) → caches `{ email, firstName, lastName }`.
- Submit → `POST /api/q/:n/submit` → server grades, appends to `Attempts`.

## Caveat

`sid` is client-supplied and unsigned — Squarespace offers no way for an
external app to verify a member session. The snippet only renders the quiz for
`authenticated` visitors and the Profiles lookup confirms the id is a real
member, but a determined person could still submit as someone else. Fine for a
weekly self-check; not for high-stakes grading.
