import { firestore } from "@/lib/firestore";
import { redis } from "@/lib/redis";

/**
 * Uptime-check target (Story 8.2): point an external monitor (UptimeRobot,
 * a platform's own health check, etc.) at this so a mid-game outage is
 * noticed within seconds instead of from a confused host mid-class.
 *
 * Checks Firestore and Redis live, since either going down is the actual
 * "game just broke" scenario. The realtime transport is a Firestore
 * listener now (no separate service to check) — the Firestore check below
 * covers it.
 */
export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    // Lightweight connectivity check — doesn't depend on any specific
    // document or collection existing, just that Firestore answers at all.
    await firestore.listCollections();
    checks.database = "ok";
  } catch (error) {
    healthy = false;
    checks.database = `error: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    await redis.ping();
    checks.redis = "ok";
  } catch (error) {
    healthy = false;
    checks.redis = `error: ${error instanceof Error ? error.message : String(error)}`;
  }

  return Response.json(
    { ok: healthy, checks, timestamp: new Date().toISOString() },
    { status: healthy ? 200 : 503 }
  );
}
