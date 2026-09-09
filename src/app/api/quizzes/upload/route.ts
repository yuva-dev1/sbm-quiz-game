import { createQuiz } from "@/lib/quizzes";
import { importQuizFromFile, QuizImportError, MAX_IMPORTED_QUESTIONS } from "@/lib/quizImport";

// Host-only: src/proxy.ts already gates every /api/quizzes/* path behind the
// shared host session, so there's no auth check here.

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB — a generous cap for a quiz doc or PDF.

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file was uploaded." }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "That file is larger than 8 MB." }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let result;
  try {
    result = await importQuizFromFile({
      filename: file.name || "upload",
      mimeType: file.type || "",
      bytes,
    });
  } catch (error) {
    if (error instanceof QuizImportError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error("Unexpected error importing an uploaded quiz file:", error);
    return Response.json({ error: "Unexpected server error while reading that file." }, { status: 500 });
  }

  const quiz = await createQuiz({
    title: result.title,
    description: `Imported from ${file.name || "an uploaded file"}.`,
    mode: "LIVE",
    weekIds: [],
    questions: result.questions.map((question, index) => ({
      order: index,
      type: question.type,
      question: question.question,
      choices: question.choices,
      correctChoices: question.correctChoices,
      explanation: "",
      timeLimitSecs: question.timeLimitSecs,
      sourceExcerpt: null,
    })),
  });

  return Response.json({
    id: quiz.id,
    title: quiz.title,
    questionCount: quiz.questions.length,
    usedLlm: result.usedLlm,
    truncated: result.questions.length >= MAX_IMPORTED_QUESTIONS,
  });
}
