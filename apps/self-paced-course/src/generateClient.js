import { extractSseFrames, parseSseFrame } from './sse.js';

const API_URL = '/api/host/quiz/generate';

/**
 * Calls the host quiz-generation proxy asking for the SSE-streaming variant
 * (mirrors apps/self-study/src/generateClient.js and the Kahoot host UI) so a
 * slow, multi-minute generation shows live progress. Validation failures come
 * back as plain JSON before the stream starts, so this branches on
 * content-type.
 */
export async function generateWithProgress(payload, { onProgress, signal } = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal
  });

  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Quiz API returned ${response.status}`);
  }
  if (!response.body) throw new Error('The quiz generator returned no data.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const { frames, rest } = extractSseFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const parsed = parseSseFrame(frame);
      if (!parsed) continue; // heartbeat comment

      if (parsed.event === 'progress') {
        onProgress?.(parsed.data);
      } else if (parsed.event === 'complete') {
        result = parsed.data;
      } else if (parsed.event === 'error') {
        throw new Error(parsed.data?.error || 'The quiz generator reported an error.');
      }
    }
  }

  if (!result) throw new Error("The quiz generator's stream ended without a result.");
  return result;
}
