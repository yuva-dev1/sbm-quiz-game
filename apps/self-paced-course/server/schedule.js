/**
 * Ported from the Kahoot app's src/lib/quizSchedule.ts. A week's quiz accepts
 * submissions only while it is PUBLISHED, the host's manual switch is on, and
 * (if a window is set) `now` falls inside it.
 */

/** @param {{ status, responsesOpen, opensAt: Date|null, closesAt: Date|null }} week */
export function isAcceptingResponses(week, now = new Date()) {
  if (week.status !== 'PUBLISHED' || !week.responsesOpen) return false;
  if (week.opensAt && now < week.opensAt) return false;
  if (week.closesAt && now > week.closesAt) return false;
  return true;
}

/** Explains *why* a week isn't open, for the student UI. */
export function describeWindowState(week, now = new Date()) {
  if (week.status !== 'PUBLISHED' || !week.responsesOpen) return 'closed_by_host';
  if (week.opensAt && now < week.opensAt) return 'not_open_yet';
  if (week.closesAt && now > week.closesAt) return 'closed_by_window';
  return 'open';
}
