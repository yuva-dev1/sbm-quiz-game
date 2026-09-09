/**
 * Minimal allowlist HTML sanitizer for host-authored rich text — the
 * question prompt and the Sri Swamiji quote interstitial, both of which are
 * now rendered as HTML so a host can put `<br/>`, `<b>`, a list, etc. into
 * them and have it format on the projected screen.
 *
 * Hosts sit behind a shared passcode (src/lib/hostAuth.ts), so this isn't
 * the primary trust boundary — it's defence-in-depth so a stray `<script>`,
 * an `onerror=` attribute, or a `javascript:` URL that gets pasted into a
 * question (or lifted out of an uploaded file by the quiz importer, see
 * src/lib/quizImport.ts) can never reach a player's device as live markup.
 *
 * Deliberately tiny and dependency-free: it runs both server-side (the
 * initial render of the host/player screens) and client-side (every live
 * `question_start` / `quote_display` event), so it can't lean on the DOM the
 * way DOMPurify would. The approach is a single pass over every `<...>`
 * token — a recognised formatting tag is re-emitted with ALL attributes
 * stripped; anything else has its angle brackets escaped so it shows as
 * literal text rather than vanishing silently (a question that reads
 * "is 2 <x> or <y>?" should still say exactly that).
 */

/** Inline + simple block formatting only. No `<a>` (no href to vet), no
 * `<img>`, no attributes on anything — so there is nothing left to carry a
 * script, a style, or a URL. */
const ALLOWED_TAGS = new Set([
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "sub",
  "sup",
  "p",
  "div",
  "ul",
  "ol",
  "li",
  "blockquote",
  "span",
  "mark",
  "small",
  "code",
  "pre",
]);

const VOID_TAGS = new Set(["br"]);

// One tag token: `<name ...>`, `</name>` or `<name ... />`. The attribute
// portion (`\s[^<>]*`) is matched only so it can be thrown away.
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^<>]*)?\/?>/g;

function escapeAngles(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeRichText(input: string | null | undefined): string {
  if (!input) return "";

  let out = "";
  let lastIndex = 0;

  for (const match of input.matchAll(TAG_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;

    // Text since the previous tag — escape bare angle brackets, but leave
    // `&` alone so entities the host typed (`&amp;`, `&#8220;`, `&nbsp;`)
    // still work.
    out += escapeAngles(input.slice(lastIndex, start));
    lastIndex = start + raw.length;

    const tag = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      out += escapeAngles(raw);
      continue;
    }

    if (raw.startsWith("</")) {
      out += `</${tag}>`;
    } else if (VOID_TAGS.has(tag)) {
      out += `<${tag} />`;
    } else {
      out += `<${tag}>`;
    }
  }

  out += escapeAngles(input.slice(lastIndex));
  return out;
}
