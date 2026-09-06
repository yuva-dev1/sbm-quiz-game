/**
 * One-off seeder for the Weeks tab. Reads scripts/weeks-seed.json and calls
 * the deployed Apps Script `upsertWeek` action for each week (idempotent — a
 * re-run updates title/summary/lessons on existing rows, never duplicates,
 * and never touches Status/ResponsesOpen). Quizzes are left empty; the host
 * builds + opens each one.
 *
 * Usage:
 *   SELF_PACED_SHEETS_ENDPOINT='{"url":"https://script.google.com/.../exec","apiKey":"..."}' \
 *     node apps/self-paced-course/scripts/seed.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const raw = process.env.SELF_PACED_SHEETS_ENDPOINT;
if (!raw) {
  console.error('SELF_PACED_SHEETS_ENDPOINT is not set.');
  process.exit(1);
}
const { url, apiKey } = JSON.parse(raw);
if (!url || !apiKey) {
  console.error('SELF_PACED_SHEETS_ENDPOINT must be {"url":"...","apiKey":"..."}.');
  process.exit(1);
}

const { weeks } = JSON.parse(await readFile(path.join(__dirname, 'weeks-seed.json'), 'utf8'));

for (const week of weeks) {
  const payload = {
    apiKey,
    action: 'upsertWeek',
    week: {
      weekNumber: week.weekNumber,
      title: week.title,
      summary: week.summary,
      lessons: week.lessons,
      quiz: [],
      opensAt: null,
      closesAt: null
    }
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({ ok: false, error: 'non-JSON response' }));
  console.log(`Week ${week.weekNumber}: ${result.ok ? 'ok' : `FAILED — ${result.error}`}`);
  if (!result.ok) process.exitCode = 1;
}

console.log('Done. Status/ResponsesOpen were left as-is; build + open each quiz from /host.');
