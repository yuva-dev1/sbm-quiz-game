"use client";

/**
 * Faint background loop that plays only while a question is actively live —
 * choices visible, answers open — so the host's room isn't sitting in dead
 * silence during a timed question. Mirrors lobbyMusic.ts's module-level
 * singleton + fade-out shape, but doesn't need cross-page survival: it's
 * started/stopped entirely from effects inside HostLobby's own lifetime.
 */

import { isSoundEnabled } from "./soundSettings";

const BASE_VOLUME = 0.12;
const FADE_OUT_MS = 400;
const FADE_STEPS = 10;

let audio: HTMLAudioElement | null = null;

function createAudio(): HTMLAudioElement {
  const el = new Audio("/audio/question-music.mp3");
  el.loop = true;
  el.volume = BASE_VOLUME;
  return el;
}

export function startQuestionMusic() {
  if (!isSoundEnabled("questionMusic")) return;
  if (audio) return;
  audio = createAudio();
  audio.play().catch(() => {});
}

export function stopQuestionMusic() {
  const el = audio;
  if (!el) return;
  audio = null;

  const startVolume = el.volume;
  let step = 0;
  const fade = setInterval(() => {
    step += 1;
    if (step >= FADE_STEPS) {
      clearInterval(fade);
      el.pause();
      return;
    }
    el.volume = Math.max(0, startVolume * (1 - step / FADE_STEPS));
  }, FADE_OUT_MS / FADE_STEPS);
}
