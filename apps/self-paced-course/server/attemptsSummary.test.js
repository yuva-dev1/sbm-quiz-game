import { describe, expect, it } from 'vitest';
import { listAttemptsNewestFirst, summarizeAttempts } from './attemptsSummary.js';

const attempt = (over) => ({
  id: crypto.randomUUID(),
  siteUserId: 'u1',
  name: 'Asha R',
  email: 'asha@example.com',
  weekNumber: 1,
  submittedAt: '2026-09-01T10:00:00.000Z',
  correctCount: 3,
  totalQuestions: 5,
  percentage: 60,
  ...over
});

describe('summarizeAttempts', () => {
  it('keeps the latest attempt per student+week but counts every retake', () => {
    const rows = [
      attempt({ submittedAt: '2026-09-01T10:00:00.000Z', percentage: 40 }),
      attempt({ submittedAt: '2026-09-02T10:00:00.000Z', percentage: 100 }),
      attempt({ submittedAt: '2026-09-03T09:00:00.000Z', percentage: 80 })
    ];
    const [student] = summarizeAttempts(rows);
    const cell = student.cells[1];
    expect(cell.attemptCount).toBe(3);
    expect(cell.percentage).toBe(80); // latest
    expect(cell.best).toBe(100); // highest across retakes
    expect(cell.firstAt).toBe('2026-09-01T10:00:00.000Z');
    expect(cell.submittedAt).toBe('2026-09-03T09:00:00.000Z');
  });

  it('separates weeks and members', () => {
    const rows = [
      attempt({ weekNumber: 1, percentage: 50 }),
      attempt({ weekNumber: 2, percentage: 70 }),
      attempt({ siteUserId: 'u2', name: 'Bala', email: 'bala@example.com', percentage: 90 })
    ];
    const students = summarizeAttempts(rows);
    expect(students).toHaveLength(2);
    const asha = students.find((s) => s.email === 'asha@example.com');
    expect(Object.keys(asha.cells).sort()).toEqual(['1', '2']);
    expect(asha.cells[1].attemptCount).toBe(1);
  });

  it('falls back to email when there is no siteUserId, and ignores rows with neither', () => {
    const rows = [
      attempt({ siteUserId: '', email: 'noid@example.com' }),
      attempt({ siteUserId: '', email: '' })
    ];
    const students = summarizeAttempts(rows);
    expect(students).toHaveLength(1);
    expect(students[0].email).toBe('noid@example.com');
  });

  it('returns [] for no attempts', () => {
    expect(summarizeAttempts([])).toEqual([]);
    expect(summarizeAttempts(undefined)).toEqual([]);
  });
});

describe('listAttemptsNewestFirst', () => {
  it('sorts every attempt by submittedAt descending', () => {
    const rows = [
      attempt({ id: 'a', submittedAt: '2026-09-01T00:00:00.000Z' }),
      attempt({ id: 'b', submittedAt: '2026-09-05T00:00:00.000Z' }),
      attempt({ id: 'c', submittedAt: '2026-09-03T00:00:00.000Z' })
    ];
    expect(listAttemptsNewestFirst(rows).map((a) => a.id)).toEqual(['b', 'c', 'a']);
  });

  it('coerces numeric fields and keeps every row (no dedupe)', () => {
    const rows = [
      attempt({ id: 'a', percentage: '80', weekNumber: '2' }),
      attempt({ id: 'b', percentage: '80', weekNumber: '2' })
    ];
    const out = listAttemptsNewestFirst(rows);
    expect(out).toHaveLength(2);
    expect(out[0].percentage).toBe(80);
    expect(out[0].weekNumber).toBe(2);
  });
});
