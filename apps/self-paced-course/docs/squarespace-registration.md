# Registering from the Squarespace site

The self-paced course app exposes a cross-origin sign-up endpoint so a form on
`srimadbhagavatamcourse.org` can create accounts directly in the course's
Google Sheet.

- **Endpoint:** `POST https://self-paced.srimadbhagavatamcourse.org/api/public/register`
  (use `https://bhagavatham-self-paced-course-876193044983.us-central1.run.app/api/public/register`
  until the subdomain's DNS is live)
- **Body (JSON):** `{ "firstName", "lastName", "email", "password" }`
- **Responses:** `201 { "ok": true }` on success; `400 { "error": "..." }` for
  bad input; `409 { "error": "..." }` if the email is already registered.
- Password rules match the app: **8+ characters**. It's bcrypt-hashed
  server-side before it touches the Sheet.
- On success the Apps Script sends the branded welcome email. The person then
  logs into the course app with the **same email + password**.
- CORS is restricted to `https://www.srimadbhagavatamcourse.org` and
  `https://srimadbhagavatamcourse.org` (override with the `PUBLIC_CORS_ORIGINS`
  env var, comma-separated).

## Squarespace setup

Add a **Code Block** to the page where sign-up should live and paste the
contents of [`squarespace-registration-snippet.html`](./squarespace-registration-snippet.html).
Set `COURSE_APP` at the top of the snippet to the app's base URL.

Squarespace's own member-account sign-up can't be synced (no API/webhook) —
this custom form is the way to get Squarespace registrations into the Sheet.
