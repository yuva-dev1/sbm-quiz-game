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

/**
 * Concatenates the actual course-note text for the selected weeks' source
 * documents — the real grounding material for generation, not just topic
 * labels. Documents with no extracted text (e.g. an infographic with no OCR
 * output) are skipped rather than padding the prompt with nothing useful.
 */
export function getSourceText(weeks: CourseWeek[], weekIds: string[]): string {
  const selectedWeeks = weeks.filter((week) => weekIds.includes(week.id));
  const sections: string[] = [];
  for (const week of selectedWeeks) {
    for (const doc of week.sourceDocuments) {
      const text = notesById[doc.id]?.trim();
      if (text) sections.push(`--- ${week.label}: ${doc.name} ---\n${text}`);
    }
  }
  return sections.join("\n\n");
}
