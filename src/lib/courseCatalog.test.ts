import { describe, expect, it } from "vitest";
import {
  getCourseCatalog,
  getSourceText,
  getTopicSourceText,
  resolveGenerationScope,
  toPublicCourseWeeks,
  type CourseWeek,
} from "@/lib/courseCatalog";
import courseTopicText from "@/data/courseTopicText.json";

function week(overrides: Partial<CourseWeek> = {}): CourseWeek {
  return {
    id: "week-1",
    label: "Week 1",
    topics: ["Sanatana Dharma", "Dharma", "Vedas"],
    sourceDocuments: [
      {
        id: "doc-1",
        name: "Week 1 Notes.pdf",
        topicsFromHeadings: ["Sanatana Dharma"],
      },
    ],
    ...overrides,
  };
}

describe("toPublicCourseWeeks", () => {
  it("offers the full catalog topic list for a week with source documents", () => {
    const [publicWeek] = toPublicCourseWeeks([week()]);
    expect(publicWeek.topics).toEqual(["Sanatana Dharma", "Dharma", "Vedas"]);
  });

  it("excludes a week entirely when it has zero source documents", () => {
    const publicWeeks = toPublicCourseWeeks([week({ sourceDocuments: [] })]);
    expect(publicWeeks).toEqual([]);
  });
});

describe("resolveGenerationScope", () => {
  it("scopes to the matching topic when a topic filter is given", () => {
    const { topics } = resolveGenerationScope([week()], ["week-1"], ["Sanatana Dharma"]);
    expect(topics).toEqual(["Sanatana Dharma"]);
  });

  it("matches topics case-insensitively and trims whitespace", () => {
    const { topics } = resolveGenerationScope([week()], ["week-1"], [" sanatana dharma "]);
    expect(topics).toEqual(["Sanatana Dharma"]);
  });

  it("falls back to the week's full topic list when the filter matches nothing, instead of an empty scope", () => {
    const { topics } = resolveGenerationScope([week()], ["week-1"], ["Something not in this week"]);
    expect(topics).toEqual(["Sanatana Dharma", "Dharma", "Vedas"]);
  });

  it("returns no topics for a week id that isn't in the catalog", () => {
    const { topics } = resolveGenerationScope([week()], ["week-99"], null);
    expect(topics).toEqual([]);
  });

  it("joins labels with '+' when multiple weeks are selected", () => {
    const weekTwo = week({ id: "week-2", label: "Week 2", topics: ["Bhagavan"] });
    const { coverageLabel } = resolveGenerationScope([week(), weekTwo], ["week-1", "week-2"], null);
    expect(coverageLabel).toBe("Week 1 + Week 2");
  });
});

describe("getCourseCatalog", () => {
  it("reads weeks/topics/source documents straight from the bundled catalog", async () => {
    const weeks = await getCourseCatalog();
    const weekOne = weeks.find((w) => w.id === "week-1");
    expect(weekOne?.label).toBe("Week 1");
    expect(weekOne?.topics).toContain("Meaning and Etymology of Sanatana Dharma");
    expect(weekOne?.sourceDocuments.length).toBeGreaterThan(0);
  });
});

describe("getSourceText", () => {
  it("returns an empty string when none of a week's source documents have extracted text", () => {
    expect(getSourceText([week()], ["week-1"])).toBe("");
  });

  it("returns an empty string for a week id that isn't in the catalog", () => {
    expect(getSourceText([week()], ["week-99"])).toBe("");
  });

  it("includes the real week's course-note text when it's actually bundled", async () => {
    const weeks = await getCourseCatalog();
    const text = getSourceText(weeks, ["week-1"]);
    expect(text).toContain("Sanatana Dharma");
    expect(text.length).toBeGreaterThan(100);
  });

  it("narrows grounding text to the selected topics' excerpts instead of the whole week", async () => {
    const weeks = await getCourseCatalog();
    const fullWeek = getSourceText(weeks, ["week-1"]);
    // Enough topics to clear MIN_TOPIC_SCOPE_CHARS (so it doesn't fall back to
    // the full week) but not all of them (so the "every topic selected"
    // shortcut doesn't fire) — and deliberately omitting "The 18 Puranas and
    // Their Three Gunas" and "The Pramana Hierarchy".
    const scoped = getSourceText(weeks, ["week-1"], [
      "Meaning and Etymology of Sanatana Dharma",
      "Origin of the Term Hinduism",
      "How Sanatana Dharma Differs from Other Religions",
      "The Vedas as the Supreme Pramana",
      "The Four Vedas - Rig, Yajur, Sama, Atharva",
      "The Four Portions of the Vedas",
      "The Two Itihasas - Ramayana and Mahabharata",
    ]);

    expect(scoped.length).toBeLessThan(fullWeek.length);
    expect(scoped).toContain("Indus Valley Civilisation");
    expect(scoped).toContain("Valmiki");
    // A phrase unique to a week-1 topic that wasn't selected.
    expect(scoped).not.toContain("Brahmavaivarta");
  });

  it("treats selecting every topic of a week the same as 'all topics' (full week text)", async () => {
    const weeks = await getCourseCatalog();
    const weekOne = weeks.find((w) => w.id === "week-1")!;
    expect(getSourceText(weeks, ["week-1"], weekOne.topics)).toBe(getSourceText(weeks, ["week-1"]));
  });

  it("falls back to the full week when the selected topics resolve to too little text", async () => {
    const weeks = await getCourseCatalog();
    const scoped = getSourceText(weeks, ["week-1"], ["not a real topic in this week"]);
    expect(scoped).toBe(getSourceText(weeks, ["week-1"]));
  });
});

describe("getTopicSourceText", () => {
  it("returns a scoped passage for every topic of the selected weeks", async () => {
    const weeks = await getCourseCatalog();
    const weekOne = weeks.find((w) => w.id === "week-1")!;
    const map = getTopicSourceText(weeks, ["week-1"]);
    for (const topic of weekOne.topics) {
      expect(map[topic]?.length, `no scoped passage for "${topic}"`).toBeGreaterThan(0);
    }
  });

  it("keeps passages per-topic even when every topic of a week is selected (unlike getSourceText)", async () => {
    const weeks = await getCourseCatalog();
    const weekOne = weeks.find((w) => w.id === "week-1")!;
    const fullWeek = getSourceText(weeks, ["week-1"]);
    const map = getTopicSourceText(weeks, ["week-1"], weekOne.topics);

    // getSourceText collapses "every topic selected" back to the full week;
    // getTopicSourceText deliberately does not — each slot only ever sees
    // its own topic's passage.
    for (const topic of weekOne.topics) {
      expect(map[topic]).toBeTruthy();
      expect(map[topic].length).toBeLessThan(fullWeek.length);
    }
  });

  it("narrows to the requested topics when a filter is given", async () => {
    const weeks = await getCourseCatalog();
    const map = getTopicSourceText(weeks, ["week-1"], ["Origin of the Term Hinduism"]);
    expect(Object.keys(map)).toEqual(["Origin of the Term Hinduism"]);
  });

  it("returns an empty map when the selected weeks have neither a topic index nor bundled notes", () => {
    expect(getTopicSourceText([week()], ["week-1"])).toEqual({});
  });
});

describe("courseTopicText.json index", () => {
  it("has a non-empty excerpt for every topic of every week in the catalog", async () => {
    const weeks = await getCourseCatalog();
    const index: Record<string, Record<string, string>> = courseTopicText;
    for (const week of weeks) {
      const weekIndex = index[week.id];
      expect(weekIndex, `missing topic index for ${week.id}`).toBeDefined();
      for (const topic of week.topics) {
        expect(weekIndex[topic]?.trim(), `missing/empty excerpt for ${week.id} → "${topic}"`).toBeTruthy();
      }
    }
  });

  it("has no index keys that don't correspond to a real catalog topic", async () => {
    const weeks = await getCourseCatalog();
    const index: Record<string, Record<string, string>> = courseTopicText;
    for (const [weekId, topics] of Object.entries(index)) {
      const week = weeks.find((w) => w.id === weekId);
      expect(week, `index references unknown week ${weekId}`).toBeDefined();
      for (const topic of Object.keys(topics)) {
        expect(week!.topics, `index for ${weekId} has stale topic "${topic}"`).toContain(topic);
      }
    }
  });
});
