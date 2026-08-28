import swamijiQuotesData from "@/data/swamijiQuotes.json";

export type SwamijiQuote = { id: number; quote: string; attribution: string };

const QUOTES: SwamijiQuote[] = swamijiQuotesData;

const MIN_QUESTIONS = 8;
const MAX_QUESTIONS = 30;
const MIN_QUOTES = 3;
const MAX_QUOTES = 7;

/**
 * Scales the number of quotes shown across a game linearly between the
 * product's stated min/max game lengths (8-30 questions -> 3-7 quotes),
 * clamped for anything outside that range and by how many gaps between
 * questions actually exist.
 */
export function pickQuoteCount(questionCount: number): number {
  const gaps = Math.max(questionCount - 1, 0);
  if (gaps === 0) return 0;

  const t = (questionCount - MIN_QUESTIONS) / (MAX_QUESTIONS - MIN_QUESTIONS);
  const raw = MIN_QUOTES + t * (MAX_QUOTES - MIN_QUOTES);
  const clamped = Math.min(MAX_QUOTES, Math.max(MIN_QUOTES, Math.round(raw)));
  return Math.min(clamped, gaps);
}

/**
 * Chooses which question indices (1-based into the question list, since a
 * quote plays before that question starts — never before question 0, which
 * starts the instant the host clicks "Start Game") get a quote beforehand.
 * Splits the range into `quoteCount` equal segments and picks one random
 * position per segment, which keeps quotes spread through the game (per the
 * product decision: "3-4 questions between quotes") instead of clustering.
 */
export function assignQuotePositions(questionCount: number, quoteCount: number): number[] {
  if (quoteCount <= 0 || questionCount <= 1) return [];

  const lastPosition = questionCount - 1;
  const segmentSize = (questionCount - 1) / quoteCount;
  const positions: number[] = [];
  for (let i = 0; i < quoteCount; i++) {
    const segmentStart = 1 + i * segmentSize;
    const segmentEnd = 1 + (i + 1) * segmentSize;
    const picked = Math.floor(segmentStart + Math.random() * (segmentEnd - segmentStart));
    // Force positions to be strictly increasing and distinct: adjacent
    // segments can round to the same boundary integer, and buildQuoteAssignment
    // keys a Map by position — a collision there silently drops a quote, so
    // it would hand back fewer than pickQuoteCount promised. `floor` is the
    // lowest still-free slot; `ceiling` leaves room for the remaining
    // segments to each still get their own slot before the last question.
    const floor = i === 0 ? 1 : positions[i - 1] + 1;
    const ceiling = lastPosition - (quoteCount - 1 - i);
    positions.push(Math.min(ceiling, Math.max(floor, Math.min(picked, lastPosition))));
  }
  return positions;
}

/** Samples `count` unique quotes without replacement. */
export function pickRandomQuotes(count: number): SwamijiQuote[] {
  const pool = [...QUOTES];
  const picked: SwamijiQuote[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

/**
 * Builds a full `questionOrder -> quote` assignment for a game session of
 * `questionCount` questions, computed once at session creation (Story: quote
 * feature) so the same quote/position stays fixed for the life of the
 * session.
 */
export function buildQuoteAssignment(questionCount: number): Map<number, SwamijiQuote> {
  const quoteCount = pickQuoteCount(questionCount);
  const positions = assignQuotePositions(questionCount, quoteCount);
  const quotes = pickRandomQuotes(positions.length);
  return new Map(positions.map((position, i) => [position, quotes[i]]));
}
