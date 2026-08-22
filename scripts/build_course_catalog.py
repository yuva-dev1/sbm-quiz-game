#!/usr/bin/env python3
"""Convert this app's own copy of the Bhagavatam course notes/infographics
(course-materials/raw/week-N/...) into Markdown with MarkItDown, and build
src/data/courseCatalog.json — the local replacement for the shared
COURSE_CATALOG_URL catalog.

Topics are derived from each note PDF's numbered outline markers (e.g.
"4.2 Lineage of Srimad Bhagavatam"), which is the section-heading convention
these course handouts consistently use; MarkItDown's own heading detection
does not reliably pick these up without a vision model, which this repo does
not have configured.

Usage: python scripts/build_course_catalog.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from markitdown import MarkItDown

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "course-materials" / "raw"
NOTES_OUT_DIR = ROOT / "content" / "course-notes"
CATALOG_OUT = ROOT / "src" / "data" / "courseCatalog.json"

WEEK_LABELS = {
    "week-1": "Week 1",
    "week-2": "Week 2",
    "week-3": "Week 3",
    "week-4": "Week 4",
    "week-5": "Week 5",
    "week-6": "Week 6",
    "week-7": "Week 7",
}

HEADING_PATTERN = re.compile(r"^(\d+\.\d+)[ \t]+(.+?)[ \t]*$", re.MULTILINE)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "document"


def normalize_topic(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def extract_topics(markdown: str) -> list[str]:
    """Each note PDF opens with a table of contents that repeats every
    section number right before the section itself (e.g. "6.2  Sage Narada
    Sage - Sri Veda Vyasa Conversation" in the TOC, then "6.2  Sage Narada &
    Sage Veda Vyasa's Conversation" as the actual heading a page later) — the
    two listings' wording can drift slightly (typos, punctuation) even
    though they're the same section, which produced near-duplicate topics
    (and near-duplicate quiz questions downstream) when both were kept. Dedup
    by section number instead of by exact text so each numbered section only
    contributes one topic; the last occurrence wins since the in-body heading
    (not the TOC blurb) is the more carefully worded one.
    """
    order: list[str] = []
    by_number: dict[str, str] = {}
    for match in HEADING_PATTERN.finditer(markdown):
        number, topic = match.group(1), normalize_topic(match.group(2))
        if not topic:
            continue
        if number not in by_number:
            order.append(number)
        by_number[number] = topic

    seen: set[str] = set()
    topics: list[str] = []
    for number in order:
        topic = by_number[number]
        key = topic.lower()
        if key not in seen:
            seen.add(key)
            topics.append(topic)
    return topics


# Written at the top of any content/course-notes/**/*.md file that was hand
# -transcribed (infographics: this repo has no vision model, so someone —
# usually Claude, reading the image/PDF directly — transcribes it once and
# it's committed). Without this check, rerunning this script would silently
# clobber that transcription back to the generic "no OCR performed" stub for
# images, or a jumbled raw MarkItDown extraction for text-layer PDFs whose
# layout doesn't survive linearization (infographics are multi-column).
MANUAL_TRANSCRIPTION_MARKER = "<!-- manually-transcribed"


def convert_document(converter: MarkItDown, path: Path, week_out_dir: Path) -> tuple[dict, list[str]]:
    week_out_dir.mkdir(parents=True, exist_ok=True)
    md_path = week_out_dir / f"{slugify(path.stem)}.md"

    existing = md_path.read_text(encoding="utf-8") if md_path.exists() else ""
    if existing.startswith(MANUAL_TRANSCRIPTION_MARKER):
        topics = extract_topics(existing)
        return {"id": slugify(path.stem), "name": path.name, "topics_from_headings": topics}, topics

    is_image = path.suffix.lower() in IMAGE_SUFFIXES
    markdown = ""
    if not is_image:
        markdown = converter.convert(str(path)).text_content.strip()

    if is_image:
        md_path.write_text(
            f"# {path.name}\n\n"
            "Image asset — no OCR performed in this build (no vision model "
            "configured in this repo). The infographic is still included as "
            "a source document so it stays in the RAG retrieval scope once "
            "GOD-Auth-Service has it indexed with real OCR'd content.\n",
            encoding="utf-8",
        )
    else:
        md_path.write_text(markdown + "\n", encoding="utf-8")

    topics = [] if is_image else extract_topics(markdown)
    document = {
        "id": slugify(path.stem),
        "name": path.name,
        "topics_from_headings": topics,
    }
    return document, topics


def main() -> None:
    converter = MarkItDown(enable_plugins=False)
    weeks_out = []

    # A week's top-level "topics" list drives question-generation's
    # round-robin focus (see localQuizGenerator.ts) — it works best broken
    # down into many specific, question-worthy facts, which is an editorial
    # judgment call no regex over section-heading numbers can make (a course
    # PDF might have only 2-3 numbered headings for a week that actually
    # covers 8+ genuinely distinct facts). So once a week has been curated by
    # hand, preserve it across rebuilds instead of clobbering it back down to
    # the raw per-document heading union — same reasoning as
    # MANUAL_TRANSCRIPTION_MARKER above, just at the topic-list level instead
    # of the per-document text level. Only a week with no existing entry (a
    # brand new week) falls back to the auto-derived union, as a starting
    # point for its first curation pass.
    existing_catalog: dict[str, dict] = {}
    if CATALOG_OUT.exists():
        for week in json.loads(CATALOG_OUT.read_text(encoding="utf-8")).get("weeks", []):
            existing_catalog[week["id"]] = week

    for week_id in sorted(WEEK_LABELS, key=lambda w: int(w.split("-")[1])):
        week_dir = RAW_DIR / week_id
        if not week_dir.is_dir():
            continue
        sources = sorted(p for p in week_dir.iterdir() if p.is_file())
        if not sources:
            continue

        week_out_dir = NOTES_OUT_DIR / week_id
        source_documents = []
        auto_topics: list[str] = []
        seen_topic_keys: set[str] = set()

        for source in sources:
            document, topics = convert_document(converter, source, week_out_dir)
            source_documents.append(document)
            for topic in topics:
                key = topic.lower()
                if key not in seen_topic_keys:
                    seen_topic_keys.add(key)
                    auto_topics.append(topic)

        curated_topics = existing_catalog.get(week_id, {}).get("topics") or []
        week_topics = curated_topics if curated_topics else auto_topics

        weeks_out.append({
            "id": week_id,
            "label": WEEK_LABELS[week_id],
            "topics": week_topics,
            "source_documents": source_documents,
        })
        print(f"{week_id}: {len(source_documents)} documents, {len(week_topics)} topics")

    CATALOG_OUT.parent.mkdir(parents=True, exist_ok=True)
    CATALOG_OUT.write_text(
        json.dumps({"weeks": weeks_out}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"\nWrote {CATALOG_OUT}")


if __name__ == "__main__":
    main()
