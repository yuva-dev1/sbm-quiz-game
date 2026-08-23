import { firestore } from "@/lib/firestore";
import { GenerateQuizForm } from "./GenerateQuizForm";
import { QuizDraftCard } from "./QuizDraftCard";
import { PublishedQuizCard } from "./PublishedQuizCard";
import { getCourseCatalog, toPublicCourseWeeks } from "@/lib/courseCatalog";
import { logoutHostAction } from "./login/actions";

export const dynamic = "force-dynamic";

type QuizQuestion = {
  id: string;
  type: "MULTIPLE_CHOICE" | "TRUE_FALSE" | "SHORT_ANSWER" | "MULTI_SELECT";
  question: string;
  choices: string[];
  correctChoices: string[];
  timeLimitSecs: number;
  sourceExcerpt: string | null;
};

async function withQuestions(doc: FirebaseFirestore.QueryDocumentSnapshot) {
  const questionsSnap = await doc.ref.collection("questions").orderBy("order").get();
  const questions: QuizQuestion[] = questionsSnap.docs.map((q) => {
    const data = q.data();
    return {
      id: q.id,
      type: data.type,
      question: data.question,
      choices: data.choices,
      correctChoices: data.correctChoices,
      timeLimitSecs: data.timeLimitSecs,
      sourceExcerpt: (data.sourceExcerpt as string | null | undefined) ?? null,
    };
  });
  return { data: doc.data(), questions };
}

export default async function HostPage() {
  const [catalog, draftsSnap, publishedSnap] = await Promise.all([
    getCourseCatalog(),
    firestore
      .collection("quizzes")
      .where("status", "==", "DRAFT")
      .where("mode", "==", "LIVE")
      .orderBy("createdAt", "desc")
      .get(),
    firestore
      .collection("quizzes")
      .where("status", "==", "PUBLISHED")
      .where("mode", "==", "LIVE")
      .orderBy("createdAt", "desc")
      .get(),
  ]);

  const drafts = await Promise.all(
    draftsSnap.docs.map(async (doc) => {
      const { data, questions } = await withQuestions(doc);
      return {
        id: doc.id,
        title: data.title as string,
        showLeaderboardDefault: data.showLeaderboardDefault as boolean,
        showTimerDefault: data.showTimerDefault as boolean,
        scoringMode: data.scoringMode as "SPEED" | "ACCURACY",
        leadTimeSecs: data.leadTimeSecs as number,
        questions,
      };
    })
  );

  const published = await Promise.all(
    publishedSnap.docs.map(async (doc) => {
      const { data, questions } = await withQuestions(doc);
      return {
        id: doc.id,
        title: data.title as string,
        questionCount: questions.length,
        questions,
      };
    })
  );

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-6 py-16 lg:max-w-4xl xl:max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="pill-badge">Host</span>
          <h1 className="mt-3 text-4xl">Pick a quiz</h1>
          <p className="mt-2 text-ink-soft">Generate a new quiz, or start a live session from an existing one.</p>
        </div>
        <form action={logoutHostAction}>
          <button type="submit" className="text-sm font-semibold text-ink-soft underline">
            Log out
          </button>
        </form>
      </div>

      <GenerateQuizForm weeks={toPublicCourseWeeks(catalog)} />

      {drafts.length > 0 && (
        <div>
          <h2 className="text-2xl">Drafts</h2>
          <p className="mt-1 text-sm text-ink-soft">Review, rename, and publish before these can be started.</p>
          <ul className="mt-3 flex flex-col gap-3">
            {drafts.map((quiz) => (
              <QuizDraftCard key={quiz.id} quiz={quiz} />
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="text-2xl">Quizzes ready to run</h2>
        {published.length === 0 ? (
          <p className="mt-2 text-ink-soft">No published quizzes yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {published.map((quiz) => (
              <PublishedQuizCard
                key={quiz.id}
                quiz={{
                  id: quiz.id,
                  title: quiz.title,
                  questionCount: quiz.questionCount,
                  questions: quiz.questions,
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
