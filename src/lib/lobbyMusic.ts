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
let audio: HTMLAudioElement | null = null;

export function startLobbyMusic() {
  if (!audio) {
    audio = new Audio("/audio/lobby-music.mp3");
    audio.loop = true;
    audio.volume = 0.5;
  }
  audio.play().catch(() => {});
}

export function stopLobbyMusic() {
  audio?.pause();
}

/** Retry hook for HostLobby: covers the case where the host lands on
 * /host/[pin] without having gone through the button above (e.g. a page
 * reload), so the synchronous-gesture play() above never happened. */
export function retryLobbyMusicIfPaused() {
  if (audio?.paused) audio.play().catch(() => {});
}
