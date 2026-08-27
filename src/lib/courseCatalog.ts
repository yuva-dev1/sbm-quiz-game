/**
 * Reads this app's own course catalog (weeks -> topics -> source documents),
 * generated from srimadbhagavatamcourse.org's notes/infographics by
 * scripts/build_course_catalog.py (see src/data/courseCatalog.json) — not
 * the shared self-study catalog other apps use, so this app's topic picker
 * doesn't depend on a separately-maintained curation pass.
 *
 * Purely local: this app doesn't call out to any external knowledge-base.
 * It does hold the course notes' actual text (src/data/courseNotes.json,
 * built by scripts/build_course_notes.mjs from content/course-notes/,
 * keyed the same way as each source document's id here) — getSourceText()
 * below is what src/lib/localQuizGenerator.ts uses to ground generation in
 * the real material instead of the model's own general knowledge.
 */

import localCatalog from "@/data/courseCatalog.json";
import courseNotes from "@/data/courseNotes.json";
import courseTopicText from "@/data/courseTopicText.json";

export type CourseSourceDocument = {
  id: string;
  name: string;
  topicsFromHeadings: string[];
};

export type CourseWeek = {
  id: string;
  label: string;
  topics: string[];
  sourceDocuments: CourseSourceDocument[];
};

export type PublicCourseWeek = {
  id: string;
  label: string;
  topics: string[];
};

/**
 * The catalog only labels weeks "Week N" — not enough for a host picking a
 * week to know what's actually in it. Derived by hand from each week's own
 * topic list in src/data/courseCatalog.json; not generated automatically,
 * so this needs a human check whenever the catalog is rebuilt with new
 * content (see scripts/build_course_catalog.py).
 */
const WEEK_SUMMARIES: Record<string, string> = {
  "week-1": "Sanatana Dharma Overview",
  "week-2": "Prasthana Traya",
  "week-3": "Bhagavatam Mahatmyam",
  "week-4": "Structure & Lineage",
  "week-5": "Canto 1 Overview",
  "week-6": "Canto 1 Answers & Narada-Vyasa Dialogue",
  "week-7": "King Parikshith's Lineage",
};

export async function getCourseCatalog(): Promise<CourseWeek[]> {
  return localCatalog.weeks.map((week) => ({
    id: week.id,
    label: week.label,
    topics: week.topics,
    sourceDocuments: week.source_documents.map((doc) => ({
      id: doc.id,
      name: doc.name,
      topicsFromHeadings: doc.topics_from_headings,
    })),
  }));
}

export function toPublicCourseWeeks(weeks: CourseWeek[]): PublicCourseWeek[] {
  return weeks
    .filter((week) => week.sourceDocuments.length > 0)
    .map((week) => ({
      id: week.id,
      label: WEEK_SUMMARIES[week.id] ? `${week.label} · ${WEEK_SUMMARIES[week.id]}` : week.label,
      topics: week.topics,
    }));
}

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

export type GenerationScope = {
  topics: string[];
  coverageLabel: string;
};

/**
 * Resolves which topics a generation request actually covers, given the
 * host's selected weeks and (optionally) a topic filter within them. A
 * requested topic that doesn't literally match one of a week's listed
 * topics still gets that week's full topic list rather than an empty scope
 * — course topics are curated by hand and can drift in wording from what a
 * caller sends, and an empty scope gives the generator nothing to work with.
 */
export function resolveGenerationScope(
  weeks: CourseWeek[],
  weekIds: string[],
  topics: string[] | null
): GenerationScope {
  const selectedWeeks = weeks.filter((week) => weekIds.includes(week.id));
  const normalizedTopics = topics && topics.length > 0 ? new Set(topics.map(normalizeTopic)) : null;

  const resolvedTopics = new Set<string>();
  for (const week of selectedWeeks) {
    const matched = normalizedTopics
      ? week.topics.filter((topic) => normalizedTopics.has(normalizeTopic(topic)))
      : week.topics;
    const chosen = matched.length > 0 ? matched : week.topics;
    chosen.forEach((topic) => resolvedTopics.add(topic));
  }

  const coverageLabel =
    selectedWeeks.length > 1 ? selectedWeeks.map((week) => week.label).join(" + ") : (selectedWeeks[0]?.label ?? "");

  return { topics: [...resolvedTopics], coverageLabel };
}

const notesById: Record<string, string> = courseNotes;
// Per-topic grounding excerpts, hand-authored from each week's own course
// notes (src/data/courseTopicText.json), keyed by week id then by the exact
// topic string from courseCatalog.json. Lets getSourceText ground a
// topic-filtered request in just that topic's passages instead of the whole
// week's notes — see docs/topic-scoped-grounding.md.
const topicTextByWeek: Record<string, Record<string, string>> = courseTopicText;
// Below this many characters, the resolved per-topic excerpts aren't enough
// material for the generator to draw a full quiz from without repeating
// itself into a short, shallow result — fall back to the whole week's notes
// for that week. Deliberately high: a handful of topics picked from one week
// still comfortably clears the week's own full-notes size, so scoping only
// actually kicks in for large selections (many topics, or several weeks),
// which is the only case where the un-scoped text was a real problem. An
// earlier value of 600 let a two-topic pick hand the model a few hundred
// characters and ask for 8 questions — it came back with 5 trivial ones.
const MIN_TOPIC_SCOPE_CHARS = 4000;

function fullWeekText(week: CourseWeek): string {
  return week.sourceDocuments
    .map((doc) => {
      const text = notesById[doc.id]?.trim();
      return text ? `--- ${week.label}: ${doc.name} ---\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Concatenates the course-note text that grounds generation for the selected
 * weeks — the real source material, not just topic labels. Documents with no
 * extracted text (e.g. an infographic with no OCR output) are skipped rather
 * than padding the prompt with nothing useful.
 *
 * When `topics` is given (a host picked specific topics rather than "all
 * topics"), each week's contribution is narrowed to just the hand-authored
 * excerpts for those topics (src/data/courseTopicText.json) instead of its
 * entire notes — the whole point of the topic picker, and what keeps a
 * one-topic request from shipping the whole week (or, across weeks, the whole
 * course) into every generation and judge call. A week falls back to its full
 * notes when every one of its topics was selected anyway, when it has no
 * topic index, or when the selected topics resolve to too little text to work
 * with (MIN_TOPIC_SCOPE_CHARS).
 */
export function getSourceText(weeks: CourseWeek[], weekIds: string[], topics?: string[] | null): string {
  const selectedWeeks = weeks.filter((week) => weekIds.includes(week.id));
  const wantedTopics = topics && topics.length > 0 ? new Set(topics.map(normalizeTopic)) : null;

  const sections: string[] = [];
  for (const week of selectedWeeks) {
    if (!wantedTopics) {
      const text = fullWeekText(week);
      if (text) sections.push(text);
      continue;
    }

    const weekTopics = week.topics.filter((topic) => wantedTopics.has(normalizeTopic(topic)));
    const everyTopicSelected = week.topics.length > 0 && weekTopics.length === week.topics.length;
    const index = topicTextByWeek[week.id];

    if (everyTopicSelected || !index) {
      const text = fullWeekText(week);
      if (text) sections.push(text);
      continue;
    }

    const seen = new Set<string>();
    const passages: string[] = [];
    for (const topic of weekTopics) {
      const passage = index[topic]?.trim();
      if (passage && !seen.has(passage)) {
        seen.add(passage);
        passages.push(passage);
      }
    }
    const scoped = passages.join("\n\n");

    if (scoped.length >= MIN_TOPIC_SCOPE_CHARS) {
      sections.push(`--- ${week.label} (selected topics) ---\n${scoped}`);
    } else {
      const text = fullWeekText(week);
      if (text) sections.push(text);
    }
  }
  return sections.join("\n\n");
}
