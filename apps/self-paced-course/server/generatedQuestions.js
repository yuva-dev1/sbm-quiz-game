import crypto from 'node:crypto';

/**
 * Normalizes a POST /generate-quiz response question
 *   { type: "multiple_choice"|"true_false", question, choices, answer, explanation, sourceExcerpt }
 * (see the Kahoot app's src/lib/localQuizGenerator.ts GeneratedQuestion) into
 * this app's stored question shape
 *   { id, type: "MULTIPLE_CHOICE"|"TRUE_FALSE", question, choices, correctChoices, explanation, sourceExcerpt }
 * where grading is set-equality on `correctChoices` (server/grading.js).
 */
export function normalizeGeneratedQuestions(result) {
  const raw = Array.isArray(result?.questions) ? result.questions : [];
  return raw.map((q) => {
    const choices = Array.isArray(q.choices) && q.choices.length ? q.choices : ['True', 'False'];
    const answer = typeof q.answer === 'string' ? q.answer : '';
    return {
      id: crypto.randomUUID(),
      type: q.type === 'true_false' ? 'TRUE_FALSE' : 'MULTIPLE_CHOICE',
      question: String(q.question ?? '').trim(),
      choices,
      correctChoices: answer ? [answer] : [],
      explanation: String(q.explanation ?? '').trim(),
      sourceExcerpt: typeof q.sourceExcerpt === 'string' ? q.sourceExcerpt : null
    };
  });
}

/** Strips `correctChoices` before a question is sent to a student. */
export function toStudentQuestion(question) {
  return {
    id: question.id,
    type: question.type,
    question: question.question,
    choices: question.choices
  };
}
