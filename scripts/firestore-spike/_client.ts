// Shared emulator-connected Firestore client for the Phase 2 spike scripts
// (see the migration plan). Not used by the real app — src/lib/firestore.ts
// (Phase 3) will be the real singleton.
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

if (!getApps().length) {
  initializeApp({ projectId: "namabiksha-v1" });
}

export const db = getFirestore();
