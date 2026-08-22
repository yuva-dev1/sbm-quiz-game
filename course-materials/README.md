# Course materials

Raw source files for `scripts/build_course_catalog.py`, downloaded from the
[English course page](https://www.srimadbhagavatamcourse.org/englishcourse).
Not committed (see `.gitignore`) — re-download into `raw/week-N/` before
rebuilding the catalog.

| Week | Notes PDF | Infographic |
|---|---|---|
| 1 | `/s/Week-1-ENG-SB-Course.pdf` | `/s/week1-infographic` |
| 2 | `/s/SBCC-E-2-Notes-PDF.pdf` | `/s/week2-infographic` |
| 3 | `/s/Week-3-ENG-SB-Course-2-With-3-Stories.pdf` | `/s/week3-infographic` |
| 4 | `/s/Week-4-ENG-SB-Course-2-PDF.pdf` | `/s/SB-Week4-Infographics.jpeg` |
| 5 | `/s/SBCC-E-5-Notes-PDF.pdf` | `/s/Week5-Infographics.jpeg` |
| 6 | `/s/SBCC-E-6-Notes-PDF.pdf` | — (site currently reuses Week 5's infographic) |
| 7 | `/s/SBCC-E-7-Notes-PDF.pdf` | `/s/Wk7-Infographics.jpeg` |

All paths are relative to `https://www.srimadbhagavatamcourse.org`. As new
weeks are posted, add a row here, download into a new `raw/week-N/`
directory, and re-run:

```bash
pip install -r requirements-course-catalog.txt
python scripts/build_course_catalog.py
```

This regenerates `content/course-notes/` (the Markdown, via MarkItDown) and
`src/data/courseCatalog.json` (the catalog `courseCatalog.ts` reads). After
regenerating, check `WEEK_SUMMARIES` in `src/lib/courseCatalog.ts` for a new
week's short label — it's maintained by hand, not generated.
