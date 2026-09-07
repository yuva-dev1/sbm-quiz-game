/**
 * Turns the flat Attempts sheet (one row per submission, every retake kept)
 * into the shapes the host UI needs:
 *
 *  - summarizeAttempts: a students x weeks grid. Each cell keeps the LATEST
 *    attempt's score plus `attemptCount` / `best` / `firstAt` so a retake is
 *    visible without opening the full list.
 *  - listAttemptsNewestFirst: every attempt, flattened and sorted, for the
 *    "All attempts" page.
 *
 * Pure functions, no I/O — unit-tested in attemptsSummary.test.js.
 */

function memberKey(attempt) {
  return String(attempt.siteUserId || attempt.email || '').toLowerCase();
}

function submittedTime(attempt) {
  const t = new Date(attempt.submittedAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** @returns Array<{ name, email, cells: Record<weekNumber, cell> }> sorted by name/email. */
export function summarizeAttempts(attempts) {
  const byMemberWeek = new Map();
  for (const a of attempts || []) {
    const key = memberKey(a);
    if (!key) continue;
    const cellKey = `${key}::${Number(a.weekNumber)}`;
    if (!byMemberWeek.has(cellKey)) byMemberWeek.set(cellKey, []);
    byMemberWeek.get(cellKey).push(a);
  }

  const members = new Map();
  for (const [cellKey, group] of byMemberWeek) {
    group.sort((x, y) => submittedTime(x) - submittedTime(y));
    const latest = group[group.length - 1];
    const earliest = group[0];
    const key = cellKey.slice(0, cellKey.lastIndexOf('::'));

    if (!members.has(key)) {
      members.set(key, { name: latest.name || '', email: latest.email || '', cells: {} });
    }
    members.get(key).cells[Number(latest.weekNumber)] = {
      percentage: Number(latest.percentage) || 0,
      correctCount: Number(latest.correctCount) || 0,
      totalQuestions: Number(latest.totalQuestions) || 0,
      submittedAt: latest.submittedAt,
      attemptCount: group.length,
      best: Math.max(...group.map((a) => Number(a.percentage) || 0)),
      firstAt: earliest.submittedAt
    };
  }

  return [...members.values()].sort((x, y) =>
    (x.name || x.email).localeCompare(y.name || y.email)
  );
}

/** Every attempt, newest first — the flat list behind the "All attempts" page. */
export function listAttemptsNewestFirst(attempts) {
  return [...(attempts || [])]
    .map((a) => ({
      id: String(a.id || ''),
      siteUserId: String(a.siteUserId || ''),
      name: String(a.name || ''),
      email: String(a.email || ''),
      weekNumber: Number(a.weekNumber) || 0,
      submittedAt: a.submittedAt || '',
      correctCount: Number(a.correctCount) || 0,
      totalQuestions: Number(a.totalQuestions) || 0,
      percentage: Number(a.percentage) || 0,
      quizVersion: a.quizVersion != null && a.quizVersion !== '' ? Number(a.quizVersion) : null
    }))
    .sort((x, y) => new Date(y.submittedAt).getTime() - new Date(x.submittedAt).getTime());
}
