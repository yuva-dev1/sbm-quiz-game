import "dotenv/config";
import { createQuiz } from "../src/lib/quizzes";

async function main() {
  // No status set — defaults to DRAFT (createQuiz's own default), matching
  // the original prisma/seed.ts, which never set it either.
  const quiz = await createQuiz({
    title: "Srimad Bhagavatam: Canto 1 Basics",
    description: "A sample warm-up quiz for testing the live game flow.",
    weekIds: ["week-1"],
    questions: [
      {
        order: 0,
        type: "MULTIPLE_CHOICE",
        question: "Who narrated the Srimad Bhagavatam to Maharaja Parikshit?",
        choices: ["Sage Vyasadeva", "Sage Narada", "Sukadeva Gosvami", "Sage Vasistha"],
        correctChoices: ["Sukadeva Gosvami"],
        explanation: "Sukadeva Gosvami recited the Bhagavatam to Parikshit Maharaja in his final seven days.",
        timeLimitSecs: 20,
      },
      {
        order: 1,
        type: "MULTIPLE_CHOICE",
        question: "How many cantos (skandhas) does the Srimad Bhagavatam have?",
        choices: ["10", "12", "18", "24"],
        correctChoices: ["12"],
        explanation: "The Bhagavatam is traditionally divided into twelve cantos.",
        timeLimitSecs: 20,
      },
      {
        order: 2,
        type: "TRUE_FALSE",
        question: "Maharaja Parikshit was cursed to die within seven days.",
        choices: ["True", "False"],
        correctChoices: ["True"],
        explanation: "The curse of Sringi is what prompted Parikshit to hear the Bhagavatam before his death.",
        timeLimitSecs: 15,
      },
      {
        order: 3,
        type: "MULTIPLE_CHOICE",
        question: "Srimad Bhagavatam is considered a commentary on which Vedic text?",
        choices: ["Bhagavad Gita", "Vedanta Sutra", "Isopanisad", "Manu Smriti"],
        correctChoices: ["Vedanta Sutra"],
        explanation: "The Bhagavatam is traditionally regarded as Vyasadeva's own natural commentary on the Vedanta Sutra.",
        timeLimitSecs: 20,
      },
    ],
  });

  console.log(`Seeded quiz ${quiz.id}: ${quiz.title}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
