// One-off: creates the disposable, unmistakably-labeled quiz the load test
// runs against. Reads Firestore credentials from the environment the same
// way the rest of the app does (Application Default Credentials in prod —
// Cloud Run's attached service account — or FIRESTORE_EMULATOR_HOST
// locally). Prints the new quiz id — feed that to setup-session.mjs next.
import "dotenv/config";
import { createQuiz } from "../src/lib/quizzes";

const TITLE = "LOAD TEST — DO NOT USE";

function mc(order: number, question: string, choices: string[], correct: string) {
  return { order, type: "MULTIPLE_CHOICE" as const, question, choices, correctChoices: [correct], explanation: "", timeLimitSecs: 20 };
}
function tf(order: number, question: string, correct: string) {
  return { order, type: "TRUE_FALSE" as const, question, choices: ["True", "False"], correctChoices: [correct], explanation: "", timeLimitSecs: 15 };
}
function ms(order: number, question: string, choices: string[], correct: string[]) {
  return { order, type: "MULTI_SELECT" as const, question, choices, correctChoices: correct, explanation: "", timeLimitSecs: 25 };
}

const questions = [
  mc(0, "Load test Q1: which color is this?", ["Red", "Blue", "Green", "Yellow"], "Red"),
  mc(1, "Load test Q2: 2 + 2 = ?", ["3", "4", "5", "6"], "4"),
  mc(2, "Load test Q3: capital of France?", ["Berlin", "Madrid", "Paris", "Rome"], "Paris"),
  mc(3, "Load test Q4: which is a fruit?", ["Carrot", "Potato", "Apple", "Onion"], "Apple"),
  tf(4, "Load test Q5: the sky is blue on a clear day.", "True"),
  tf(5, "Load test Q6: a week has eight days.", "False"),
  tf(6, "Load test Q7: water boils at 100°C at sea level.", "True"),
  tf(7, "Load test Q8: the sun rises in the west.", "False"),
  ms(8, "Load test Q9: select all even numbers.", ["1", "2", "3", "4"], ["2", "4"]),
  ms(9, "Load test Q10: select all primary colors.", ["Red", "Green", "Blue", "Orange"], ["Red", "Blue"]),
  ms(10, "Load test Q11: select all planets.", ["Mars", "Sun", "Venus", "Moon"], ["Mars", "Venus"]),
  ms(11, "Load test Q12: select all vowels.", ["A", "B", "E", "C"], ["A", "E"]),
];

async function main() {
  const quiz = await createQuiz({
    title: TITLE,
    description: "Throwaway quiz for the 500-600 bot production load test. Safe to delete after the run.",
    status: "PUBLISHED",
    weekIds: [],
    questions,
  });

  console.log(`Created quiz ${quiz.id}: "${quiz.title}" (${quiz.status}, ${quiz.questions.length} questions)`);
  console.log(`Next: node load-test/setup-session.mjs ${quiz.id} <baseUrl>`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
