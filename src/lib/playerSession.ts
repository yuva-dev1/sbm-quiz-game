/**
 * Client-persisted {playerId, nickname} per PIN so a refresh, a dropped
 * connection, or navigating back to /join for a game already joined
 * re-associates with the existing Player record instead of creating a
 * duplicate (Story 7.1). Uses localStorage, not sessionStorage — a new tab
 * or a reopened tab on the same device needs to see the same record too, so
 * a player can't accidentally (or deliberately) get a second entry in the
 * same game just by opening /join again in a fresh tab.
 */
type PlayerSession = { playerId: string; nickname: string };

function storageKey(pin: string): string {
  return `quiz-player:${pin}`;
}

export function savePlayerSession(pin: string, session: PlayerSession): void {
  window.localStorage.setItem(storageKey(pin), JSON.stringify(session));
}

export function getPlayerSession(pin: string): PlayerSession | null {
  const raw = window.localStorage.getItem(storageKey(pin));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.playerId === "string" && typeof parsed?.nickname === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
