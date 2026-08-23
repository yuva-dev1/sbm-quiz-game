/**
 * Kahoot-style tile color per choice index — shared by host and player.
 * Green and red are reserved exclusively for the post-lock reveal (correct/
 * incorrect fill in PlayerLobby/HostLobby) — none of these four may be green
 * or red, not even a muted shade, so a tile's base color is never confused
 * with that convention before the question locks (QA feedback: elderly
 * players read the green tile below as a hint before the answer revealed).
 * Each color also hits at least a 4.5:1 contrast ratio against white text
 * (WCAG AA for normal text).
 */
export const ANSWER_TILE_COLORS = ["#2e3192", "#a34a00", "#8a6d00", "#8a3d68"] as const;
