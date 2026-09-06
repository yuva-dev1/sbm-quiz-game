/**
 * Renders a lesson video from a host-supplied URL. Handles the common share
 * formats (YouTube, Vimeo) as iframes and falls back to a native <video> for
 * a direct file URL.
 */
export function LessonVideo({ url, title }) {
  if (!url) return null;
  const embed = toEmbedUrl(url);
  return (
    <div className="video-frame">
      {embed ? (
        <iframe
          src={embed}
          title={title || 'Lesson video'}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <video src={url} controls preload="metadata" />
      )}
    </div>
  );
}

/** Returns an embeddable URL for known providers, or null for a direct file. */
function toEmbedUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (parsed.pathname === '/watch' && parsed.searchParams.get('v')) {
      return `https://www.youtube.com/embed/${parsed.searchParams.get('v')}`;
    }
    if (parsed.pathname.startsWith('/embed/')) return parsed.href;
    if (parsed.pathname.startsWith('/shorts/')) {
      return `https://www.youtube.com/embed/${parsed.pathname.split('/')[2]}`;
    }
  }
  if (host === 'youtu.be') {
    return `https://www.youtube.com/embed/${parsed.pathname.slice(1)}`;
  }
  if (host === 'vimeo.com') {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    if (id) return `https://player.vimeo.com/video/${id}`;
  }
  if (host === 'player.vimeo.com' || host === 'drive.google.com') return parsed.href;

  return null;
}
