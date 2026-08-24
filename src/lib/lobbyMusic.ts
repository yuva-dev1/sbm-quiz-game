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
 *
 * Every attempt logs to the console with a `[lobbyMusic]` prefix — this has
 * been unreliable enough in the field (works locally, silently fails or
 * stops in production for reasons not yet confirmed) that guessing further
 * without an actual error/event trail from a real failing browser isn't
 * productive. If it's not working, open DevTools' Console tab and send the
 * `[lobbyMusic]` lines.
 */
const BASE_VOLUME = 0.5;
const FADE_OUT_MS = 1000;
const FADE_STEPS = 20;

let audio: HTMLAudioElement | null = null;

function createAudio(): HTMLAudioElement {
  const el = new Audio("/audio/lobby-music.mp3");
  el.loop = true;
  el.volume = BASE_VOLUME;
  el.addEventListener("error", () => {
    console.warn("[lobbyMusic] element error", el.error?.code, el.error?.message);
  });
  el.addEventListener("stalled", () => console.warn("[lobbyMusic] stalled (network)"));
  el.addEventListener("playing", () => console.info("[lobbyMusic] playing event fired"));
  el.addEventListener("pause", () => console.info("[lobbyMusic] paused", new Error().stack));
  return el;
}

export function startLobbyMusic() {
  if (!audio) {
    audio = createAudio();
  }
  console.info("[lobbyMusic] startLobbyMusic() called, readyState=", audio.readyState);
  audio
    .play()
    .then(() => console.info("[lobbyMusic] play() resolved"))
    .catch((err) => console.warn("[lobbyMusic] play() rejected:", err?.name, err?.message));
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
  console.info("[lobbyMusic] stopLobbyMusic() called", new Error().stack);
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
  if (audio?.paused) {
    console.info("[lobbyMusic] retrying on gesture");
    audio.play().catch((err) => console.warn("[lobbyMusic] retry play() rejected:", err?.name, err?.message));
  }
}
