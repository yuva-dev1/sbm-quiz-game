import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";

/**
 * Browser-side Firestore handle, used only to tail a live session's broadcast
 * event log and its player roster (src/lib/sessionBroadcastClient.ts,
 * HostLobby). Every write still goes through this app's own API routes and
 * the Admin SDK — the client never writes Firestore directly, and
 * firestore.rules only grants it read on `sessionBroadcasts/**` and
 * `gameSessions/{id}/players/**`.
 *
 * The NEXT_PUBLIC_FIREBASE_* values are a Firebase *web app* config, not
 * secrets — they identify the project; access is gated by security rules.
 * They are inlined at build time (see Dockerfile), so they must be present
 * as build args for the container image, not just at runtime.
 */

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let cached: Firestore | undefined;

export function getFirestoreClient(): Firestore {
  if (cached) return cached;

  const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const db = getFirestore(app);

  // Local dev/e2e against the Firestore emulator — same host:port the Admin
  // SDK uses via FIRESTORE_EMULATOR_HOST, surfaced to the browser under a
  // NEXT_PUBLIC_ name so it's inlined into the client bundle.
  const emulatorHost = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
  if (emulatorHost) {
    const [host, port] = emulatorHost.split(":");
    connectFirestoreEmulator(db, host, Number(port));
  }

  cached = db;
  return db;
}
