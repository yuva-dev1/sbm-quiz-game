"use client";

/**
 * A module-level (not React-state) singleton so the lobby track survives the
 * client-side navigation from the "Start Live Game" button (src/app/host/
 * StartGameButton.tsx) to the /host/[pin] waiting room (HostLobby.tsx) —
 * Next's App Router router.push() never unloads the document, so a real,
 * still-playing <audio> element just keeps going across that route change.
 *
 * That first click is also why startLobbyMusic() has to be called from
 * there rather than from an effect on the destination page: browsers only
 * reliably honour audio-with-sound autoplay when play() is invoked
 * synchronously inside a genuine user gesture's own event handler. A
 * play() call from a useEffect that runs after the route change is several
 * ticks removed from that gesture and can be silently rejected — Safari
 * enforces this strictly, Chrome less so but still inconsistently for a
 * fresh domain with no prior media-engagement history.
 */
const BASE_VOLUME = 0.5;
const FADE_OUT_MS = 1000;
const FADE_STEPS = 20;

let audio: HTMLAudioElement | null = null;

export function startLobbyMusic() {
  if (!audio) {
    audio = new Audio("/audio/lobby-music.mp3");
    audio.loop = true;
    audio.volume = BASE_VOLUME;
  }
  audio.play().catch(() => {});
}

// Fades out over a second rather than cutting off mid-note when the quiz
// starts. Detaches the module's reference immediately (rather than at the
// end of the fade) so a stop followed right away by a fresh
// startLobbyMusic() call creates a new element instead of fighting the old
// one's fade-out for control of the same <audio>.
//
// iOS Safari ignores HTMLMediaElement.volume entirely (it defers to the
// hardware volume buttons), so this degrades there to a delayed hard stop
// after FADE_OUT_MS rather than an audible ramp — acceptable, and not worth
// the added complexity of a Web Audio API GainNode (which brings its own
// autoplay-gesture requirements) just for this nicety.
export function stopLobbyMusic() {
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
      el.volume = BASE_VOLUME;
      return;
    }
    el.volume = Math.max(0, startVolume * (1 - step / FADE_STEPS));
  }, FADE_OUT_MS / FADE_STEPS);
}

/** Retry hook for HostLobby: covers the case where the host lands on
 * /host/[pin] without having gone through the button above (e.g. a page
 * reload), so the synchronous-gesture play() above never happened. */
export function retryLobbyMusicIfPaused() {
  if (audio?.paused) audio.play().catch(() => {});
}
