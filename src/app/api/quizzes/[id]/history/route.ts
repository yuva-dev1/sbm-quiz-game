import { getQuizSessionHistory } from "@/lib/sessions";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessions = await getQuizSessionHistory(id);
  return Response.json({ sessions });
}
