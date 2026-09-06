import { describe, expect, it } from 'vitest';
import { gradeAnswer, gradeQuiz } from './grading.js';

describe('gradeAnswer', () => {
  it('is true only for an exact set match', () => {
    expect(gradeAnswer(['A'], ['A'])).toBe(true);
    expect(gradeAnswer(['A', 'B'], ['B', 'A'])).toBe(true); // order-independent
    expect(gradeAnswer(['A'], ['B'])).toBe(false);
    expect(gradeAnswer(['A'], ['A', 'B'])).toBe(false); // missing one
    expect(gradeAnswer(['A', 'B'], ['A'])).toBe(false); // extra one
    expect(gradeAnswer([], ['A'])).toBe(false);
  });

  it('treats non-arrays as empty selections', () => {
    expect(gradeAnswer(undefined, ['A'])).toBe(false);
    expect(gradeAnswer(null, [])).toBe(true);
  });
});

describe('gradeQuiz', () => {
  const questions = [
    { id: 'q1', question: 'One?', choices: ['A', 'B'], correctChoices: ['A'], explanation: 'because A' },
    { id: 'q2', question: 'Two?', choices: ['True', 'False'], correctChoices: ['True'], explanation: '' },
    { id: 'q3', question: 'Three?', choices: ['X', 'Y', 'Z'], correctChoices: ['Y'], explanation: '' }
  ];

  it('scores a fully correct submission', () => {
    const result = gradeQuiz(questions, { q1: ['A'], q2: ['True'], q3: ['Y'] });
    expect(result).toMatchObject({ correctCount: 3, totalQuestions: 3, percentage: 100 });
    expect(result.answers.every((a) => a.correct)).toBe(true);
  });

  it('scores a partial submission and rounds the percentage', () => {
    const result = gradeQuiz(questions, { q1: ['A'], q2: ['False'], q3: ['Z'] });
    expect(result).toMatchObject({ correctCount: 1, totalQuestions: 3, percentage: 33 });
  });

  it('treats a missing answer as incorrect', () => {
    const result = gradeQuiz(questions, { q1: ['A'] });
    expect(result.correctCount).toBe(1);
    expect(result.answers[1]).toMatchObject({ questionId: 'q2', selectedChoices: [], correct: false });
  });

  it('carries choices and explanation into the breakdown', () => {
    const result = gradeQuiz(questions, { q1: ['B'] });
    expect(result.answers[0]).toMatchObject({
      questionId: 'q1',
      choices: ['A', 'B'],
      correctChoices: ['A'],
      selectedChoices: ['B'],
      correct: false,
      explanation: 'because A'
    });
  });

  it('returns 0% for an empty quiz', () => {
    expect(gradeQuiz([], {})).toMatchObject({ correctCount: 0, totalQuestions: 0, percentage: 0 });
  });
});
