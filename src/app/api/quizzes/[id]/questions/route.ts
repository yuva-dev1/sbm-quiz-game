import { firestore } from "@/lib/firestore";
import { MIN_TIME_LIMIT_SECS, MAX_TIME_LIMIT_SECS } from "@/lib/timeLimits";

const TRUE_FALSE_CHOICES = ["True", "False"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const quizRef = firestore.collection("quizzes").doc(id);
  const questionsRef = quizRef.collection("questions");
  const quizSnap = await quizRef.get();
  if (!quizSnap.exists) {
    return Response.json({ error: "Quiz not found." }, { status: 404 });
  }
  const quiz = quizSnap.data()!;

  const type = body?.type === "TRUE_FALSE" || body?.type === "MULTIPLE_CHOICE" ? body.type : null;
  if (!type) {
    return Response.json({ error: "type must be MULTIPLE_CHOICE or TRUE_FALSE." }, { status: 400 });
  }

  const questionText = typeof body?.question === "string" ? body.question.trim() : "";
  if (!questionText || questionText.length > 500) {
    return Response.json({ error: "question is required (max 500 characters)." }, { status: 400 });
  }

  let choices: string[];
  if (type === "TRUE_FALSE") {
    choices = TRUE_FALSE_CHOICES;
  } else {
    const rawChoices = Array.isArray(body?.choices)
      ? body.choices
          .map((choice: unknown) => (typeof choice === "string" ? choice.trim() : ""))
          .filter((choice: string) => choice !== "")
      : [];
    if (rawChoices.length !== 4 || new Set(rawChoices).size !== 4) {
      return Response.json({ error: "Provide four unique, non-empty choices." }, { status: 400 });
    }
    choices = rawChoices;
  }

  const rawCorrectChoices: unknown[] = Array.isArray(body?.correctChoices) ? body.correctChoices : [];
  const correctChoices = [
    ...new Set(rawCorrectChoices.filter((choice): choice is string => typeof choice === "string")),
  ];
  if (correctChoices.length !== 1 || !correctChoices.every((choice) => choices.includes(choice))) {
    return Response.json(
      { error: "correctChoices must contain exactly one of the question's choices." },
      { status: 400 }
    );
  }

  const timeLimitSecs = Number(body?.timeLimitSecs);
  if (!Number.isInteger(timeLimitSecs) || timeLimitSecs < MIN_TIME_LIMIT_SECS || timeLimitSecs > MAX_TIME_LIMIT_SECS) {
    return Response.json(
      { error: `timeLimitSecs must be an integer between ${MIN_TIME_LIMIT_SECS} and ${MAX_TIME_LIMIT_SECS}.` },
      { status: 400 }
    );
  }

  // order must stay contiguous (0..n-1) — mirrors the invariant the DELETE
  // handler maintains, since GameSession identifies the last question by
  // order === questions.length - 1. Reading the current count and writing
  // the new doc inside one transaction keeps two concurrent "Add Question"
  // submissions from landing on the same order.
  const newQuestion = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(questionsRef);
    const order = snap.size;
    const ref = questionsRef.doc();
    const data = {
      order,
      type,
      question: questionText,
      choices,
      correctChoices,
      explanation: "",
      timeLimitSecs,
      quizCreatedAt: quiz.createdAt,
      weekIds: quiz.weekIds ?? [],
    };
    tx.set(ref, data);
    return { id: ref.id, ...data };
  });

  return Response.json({
    id: newQuestion.id,
    type: newQuestion.type,
    question: newQuestion.question,
    choices: newQuestion.choices,
    correctChoices: newQuestion.correctChoices,
    timeLimitSecs: newQuestion.timeLimitSecs,
  });
}
