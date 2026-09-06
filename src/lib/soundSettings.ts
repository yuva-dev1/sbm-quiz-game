"use client";

/**
 * Host-only sound preferences (mute-all + per-sound toggles), persisted to
 * localStorage so they carry across the /host -> /host/[pin] navigation and
 * survive a reload mid-game. Never synced to players or the server — this is
 * purely what the host's own browser plays for itself, matching how all four
 * sounds already only ever play from host-side <audio> elements.
 */

import { useSyncExternalStore } from "react";

export type SoundKey = "mangalacharan" | "questionMusic" | "answerReveal" | "quizEnd";

export const SOUND_LABELS: Record<SoundKey, string> = {
  mangalacharan: "Opening Music (Mangalacharan)",
  questionMusic: "Question Music",
  answerReveal: "Answer Reveal",
  quizEnd: "Quiz End Fanfare",
};

export const SOUND_KEYS: SoundKey[] = ["mangalacharan", "questionMusic", "answerReveal", "quizEnd"];

export type SoundSettings = {
  muteAll: boolean;
  enabled: Record<SoundKey, boolean>;
};

const STORAGE_KEY = "hostSoundSettings";

const DEFAULT_SETTINGS: SoundSettings = {
  muteAll: false,
  enabled: { mangalacharan: true, questionMusic: true, answerReveal: true, quizEnd: true },
};

let cached: SoundSettings | null = null;
const listeners = new Set<() => void>();

function load(): SoundSettings {
  if (cached) return cached;
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = DEFAULT_SETTINGS;
    } else {
      const parsed = JSON.parse(raw);
      cached = {
        muteAll: Boolean(parsed.muteAll),
        enabled: { ...DEFAULT_SETTINGS.enabled, ...parsed.enabled },
      };
    }
  } catch {
    cached = DEFAULT_SETTINGS;
  }
  return cached;
}

function persist(next: SoundSettings) {
  cached = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort — a missed persist just means the toggle resets on reload.
    }
  }
  listeners.forEach((listener) => listener());
}

export function getSoundSettings(): SoundSettings {
  return load();
}

/** Whether a given sound should actually play right now — the single check
 * every imperative audio call site (lobbyMusic.ts, questionMusic.ts,
 * HostLobby's reveal/fanfare refs) gates on. */
export function isSoundEnabled(key: SoundKey): boolean {
  const settings = load();
  return !settings.muteAll && settings.enabled[key];
}

export function setSoundEnabled(key: SoundKey, value: boolean) {
  const settings = load();
  persist({ ...settings, enabled: { ...settings.enabled, [key]: value } });
}

export function setMuteAll(value: boolean) {
  persist({ ...load(), muteAll: value });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read for components — e.g. re-running the lobby-music effect the
 * instant the host flips a toggle mid-game, not just on the next mount. */
export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(subscribe, getSoundSettings, () => DEFAULT_SETTINGS);
}
