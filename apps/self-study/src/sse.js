// Mirrors srimad-bhagavatham-quiz-game's src/lib/sse.ts — kept as a small
// standalone copy since this app is a separate deployable with its own
// node_modules, not a package that repo exposes for reuse.

export function parseSseFrame(frame) {
  let event = '';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (!event || dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join('\n')) };
}

export function extractSseFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let frameBreak = rest.indexOf('\n\n');
  while (frameBreak !== -1) {
    frames.push(rest.slice(0, frameBreak));
    rest = rest.slice(frameBreak + 2);
    frameBreak = rest.indexOf('\n\n');
  }
  return { frames, rest };
}
