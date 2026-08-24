import {
  deleteCompletedSession,
  SessionHistoryNotFoundError,
  SessionNotCompletedError,
} from "@/lib/sessions";

export async function DELETE(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  try {
    await deleteCompletedSession(sessionId);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof SessionHistoryNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof SessionNotCompletedError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
