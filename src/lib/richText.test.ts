import { describe, expect, it } from "vitest";
import { sanitizeRichText } from "@/lib/richText";

describe("sanitizeRichText", () => {
  it("returns an empty string for empty/nullish input", () => {
    expect(sanitizeRichText("")).toBe("");
    expect(sanitizeRichText(null)).toBe("");
    expect(sanitizeRichText(undefined)).toBe("");
  });

  it("keeps allowed formatting tags", () => {
    expect(sanitizeRichText("Line one<br/>Line two")).toBe("Line one<br />Line two");
    expect(sanitizeRichText("a <b>bold</b> and <em>italic</em> word")).toBe(
      "a <b>bold</b> and <em>italic</em> word"
    );
    expect(sanitizeRichText("<ul><li>one</li><li>two</li></ul>")).toBe(
      "<ul><li>one</li><li>two</li></ul>"
    );
  });

  it("normalises tag case and self-closing syntax", () => {
    expect(sanitizeRichText("x<BR>y<BR />z")).toBe("x<br />y<br />z");
    expect(sanitizeRichText("<P>para</P>")).toBe("<p>para</p>");
  });

  it("strips every attribute from an allowed tag", () => {
    expect(sanitizeRichText('<b onclick="steal()" class="x">hi</b>')).toBe("<b>hi</b>");
    expect(sanitizeRichText('<span style="position:fixed">z</span>')).toBe("<span>z</span>");
  });

  it("escapes disallowed tags instead of dropping them", () => {
    expect(sanitizeRichText("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
    expect(sanitizeRichText('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror="alert(1)"&gt;'
    );
    expect(sanitizeRichText('<a href="javascript:alert(1)">link</a>')).toBe(
      '&lt;a href="javascript:alert(1)"&gt;link&lt;/a&gt;'
    );
  });

  it("escapes stray angle brackets in text", () => {
    expect(sanitizeRichText("is 2 <x> or <y>?")).toBe("is 2 &lt;x&gt; or &lt;y&gt;?");
    expect(sanitizeRichText("5 < 3 is false")).toBe("5 &lt; 3 is false");
  });

  it("leaves entities the host typed untouched", () => {
    expect(sanitizeRichText("Rama &amp; Krishna &#8212; brothers")).toBe(
      "Rama &amp; Krishna &#8212; brothers"
    );
  });

  it("neutralises an unterminated tag", () => {
    expect(sanitizeRichText("<b onclick=alert(1) ")).toBe("&lt;b onclick=alert(1) ");
  });

  it("handles a realistic multi-line question", () => {
    const input = "Who spoke the Bhagavatam?<br/><br/>Pick the <b>first</b> reciter.";
    expect(sanitizeRichText(input)).toBe(
      "Who spoke the Bhagavatam?<br /><br />Pick the <b>first</b> reciter."
    );
  });
});
