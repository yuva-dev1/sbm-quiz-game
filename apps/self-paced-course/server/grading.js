/**
 * Server-authoritative grading for a week's quiz. Ported from the Kahoot app's
 * src/lib/grading.ts (order-independent set equality) — a question is correct
 * only when the student's selected choices are exactly the correct set.
 *
 * The student client never sees `correctChoices`; the server re-reads the
 * frozen QuizJSON from the sheet and grades against it here.
 */

function sameChoiceSet(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((choice, i) => choice === sortedB[i]);
}

export function gradeAnswer(selectedChoices, correctChoices) {
  return sameChoiceSet(
    Array.isArray(selectedChoices) ? selectedChoices : [],
    Array.isArray(correctChoices) ? correctChoices : []
  );
}

/**
 * @param {Array<{id,type,question,choices,correctChoices,explanation}>} questions
 * @param {Record<string, string[]>} selectedByQuestionId
 * @returns {{ correctCount, totalQuestions, percentage, answers }}
 */
export function gradeQuiz(questions, selectedByQuestionId) {
  const answers = questions.map((question) => {
    const selectedChoices = Array.isArray(selectedByQuestionId[question.id])
      ? selectedByQuestionId[question.id]
      : [];
    const correct = gradeAnswer(selectedChoices, question.correctChoices);
    return {
      questionId: question.id,
      question: question.question,
      choices: question.choices,
      correctChoices: question.correctChoices,
      selectedChoices,
      correct,
      explanation: question.explanation ?? ''
    };
  });
  const correctCount = answers.filter((a) => a.correct).length;
  const totalQuestions = questions.length;
  const percentage = totalQuestions ? Math.round((correctCount / totalQuestions) * 100) : 0;
  return { correctCount, totalQuestions, percentage, answers };
}
