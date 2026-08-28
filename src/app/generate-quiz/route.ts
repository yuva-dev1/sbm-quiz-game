import crypto from "node:crypto";
import { generateQuiz, QuizGenerationError, type GenerationProgress } from "@/lib/localQuizGenerator";
import { resolveGenerateQuizRequest } from "@/lib/generateQuizRequest";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Backend-only entry point for other services to generate a Bhagavatam
 * class quiz without going through this app's own DB/UI — stateless, no
 * persistence. Gated by a shared bearer token (GENERATE_QUIZ_API_KEY) since
 * it calls a budget-metered OpenRouter key directly.
 */
function isAuthorized(request: Request): boolean {
  const expected = process.env.GENERATE_QUIZ_API_KEY;
  if (!expected) return false;

  const [scheme, token] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token) return false;

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const parsed = await resolveGenerateQuizRequest(request);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }
  const { questionCount, difficulty, scopeTopics, coverageLabel, sourceText, topicSourceText, existingQuestions } = parsed.value;

  const wantsStream = (request.headers.get("accept") ?? "").includes("text/event-stream");
  if (!wantsStream) {
    try {
      const quiz = await generateQuiz({
        topics: scopeTopics,
        sourceText,
        topicSourceText,
        questionCount,
        difficulty,
        coverageLabel,
        existingQuestions,
      });
      return Response.json(quiz);
    } catch (error) {
      if (error instanceof QuizGenerationError) {
        return Response.json({ error: error.message }, { status: 502 });
      }
      console.error("Unexpected error during quiz generation:", error);
      return Response.json({ error: "Unexpected server error while generating the quiz." }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(":heartbeat\n\n"));
      }, HEARTBEAT_INTERVAL_MS);

      try {
        const quiz = await generateQuiz({
          topics: scopeTopics,
          sourceText,
          topicSourceText,
          questionCount,
          difficulty,
          coverageLabel,
          existingQuestions,
          onProgress: (progress: GenerationProgress) => send("progress", progress),
        });
        send("complete", quiz);
      } catch (error) {
        if (error instanceof QuizGenerationError) {
          send("error", { error: error.message });
        } else {
          console.error("Unexpected error during quiz generation:", error);
          send("error", { error: "Unexpected server error while generating the quiz." });
        }
      } finally {
        clearInterval(heartbeat);
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
