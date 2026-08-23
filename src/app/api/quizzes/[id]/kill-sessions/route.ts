import { killLiveSessionsForQuiz } from "@/lib/sessions";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const killedCount = await killLiveSessionsForQuiz(id);
  return Response.json({ ok: true, killedCount });
}
