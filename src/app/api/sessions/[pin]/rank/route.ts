import { getPlayerRank, getPlayerProgress } from "@/lib/leaderboard";
import { NextRequest } from "next/server";

/**
 * A player's own current rank, even outside the leaderboard's top 10
 * (Story 5.2), plus their running correct/answered count (shown regardless
 * of whether the leaderboard is toggled on). An HTTP response to the
 * requesting player's own call is as private as "sent privately to that
 * socket" needs to be here — no need for a dedicated per-player realtime
 * channel and the fan-out cost that'd add at scale (relevant for Feature 9's
 * 500-1000 player load test).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ pin: string }> }) {
  const { pin } = await params;
  const playerId = request.nextUrl.searchParams.get("playerId");
  if (!playerId) {
    return Response.json({ error: "playerId is required." }, { status: 400 });
  }

  const [rank, progress] = await Promise.all([getPlayerRank(pin, playerId), getPlayerProgress(pin, playerId)]);
  if (!rank) {
    return Response.json({ rank: null, points: 0, totalPlayers: 0, correctCount: 0, answeredCount: 0 });
  }
  return Response.json({ ...rank, correctCount: progress?.correctCount ?? 0, answeredCount: progress?.answeredCount ?? 0 });
}
