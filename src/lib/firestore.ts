import { initializeApp, getApps, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const globalForFirestore = globalThis as unknown as {
  firebaseApp: App | undefined;
};

// FIRESTORE_EMULATOR_HOST (set for local dev/test — see .env.example and
// vitest.config.ts) redirects the Admin SDK to the local emulator
// automatically; no credentials needed in that case. In production the
// Admin SDK picks up application-default credentials from the deployment
// environment (Cloud Run's attached service account) with no explicit
// `cert()` needed either — `cert()` is only required for local production
// access outside a GCP-hosted environment, which this app doesn't do.
const app =
  globalForFirestore.firebaseApp ??
  (getApps()[0] ?? initializeApp({ projectId: "namabiksha-v1" }));

export const firestore = getFirestore(app);

if (process.env.NODE_ENV !== "production") globalForFirestore.firebaseApp = app;
