import { createElement, type ElementType } from "react";
import { sanitizeRichText } from "@/lib/richText";

/**
 * Renders host-authored rich text (a question prompt, a quote) as HTML,
 * passed through the allowlist sanitizer in src/lib/richText.ts first. Pure
 * and DOM-free, so it works in both the server render and the client
 * ("use client") trees that show live questions.
 */
export function RichText({
  html,
  as = "span",
  className,
}: {
  html: string | null | undefined;
  as?: ElementType;
  className?: string;
}) {
  return createElement(as, {
    className,
    dangerouslySetInnerHTML: { __html: sanitizeRichText(html) },
  });
}
