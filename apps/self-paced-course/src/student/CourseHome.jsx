import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';
import { COURSE_TITLE } from '../brandAssets.js';

const WINDOW_LABEL = {
  open: { text: 'Open', cls: 'open' },
  not_open_yet: { text: 'Opens soon', cls: 'closed' },
  closed_by_window: { text: 'Closed', cls: 'closed' },
  closed_by_host: { text: 'Closed', cls: 'closed' }
};

export default function CourseHome() {
  const [state, setState] = useState({ loading: true, error: '', weeks: [], progress: { completed: 0, total: 0 }, bestByWeek: {} });

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get('/api/course'),
      api.get('/api/course/progress').catch(() => ({ completed: 0, total: 0 })),
      api.get('/api/attempts').catch(() => ({ attempts: [] }))
    ])
      .then(([course, progress, history]) => {
        if (!active) return;
        const bestByWeek = {};
        for (const attempt of history.attempts || []) {
          const n = Number(attempt.weekNumber);
          if (!(n in bestByWeek) || attempt.percentage > bestByWeek[n]) bestByWeek[n] = attempt.percentage;
        }
        setState({ loading: false, error: '', weeks: course.weeks || [], progress, bestByWeek });
      })
      .catch((error) => active && setState((s) => ({ ...s, loading: false, error: error.message })));
    return () => {
      active = false;
    };
  }, []);

  if (state.loading) {
    return (
      <Layout>
        <div className="center-load"><LoaderCircle className="spin" size={26} /></div>
      </Layout>
    );
  }

  const pct = state.progress.total ? Math.round((state.progress.completed / state.progress.total) * 100) : 0;

  return (
    <Layout>
      <div className="course-hero">
        <p className="eyebrow">{COURSE_TITLE}</p>
        <h1>Your weekly path</h1>
        <p>Watch each week’s lesson, take the quiz, and track how far you’ve come.</p>
      </div>

      <div className="progress">
        <span className="label">{pct}% complete</span>
        <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
        <span className="label">{state.progress.completed} / {state.progress.total} weeks</span>
      </div>

      {state.error && <p className="error">{state.error}</p>}

      {state.weeks.length === 0 && !state.error && (
        <p className="muted">No weeks have been published yet. Check back soon.</p>
      )}

      {state.weeks.map((week) => {
        const w = WINDOW_LABEL[week.windowState] || WINDOW_LABEL.closed_by_host;
        const best = state.bestByWeek[week.weekNumber];
        return (
          <Link className="card week-card" to={`/week/${week.weekNumber}`} key={week.weekNumber}>
            <span className="kicker">Week {week.weekNumber}</span>
            <h2>{week.title}</h2>
            {week.summary && <p className="muted" style={{ marginTop: 6 }}>{week.summary}</p>}
            <div className="meta">
              <span>{week.lessons.length} lesson{week.lessons.length === 1 ? '' : 's'}</span>
              <span>{week.questionCount} question{week.questionCount === 1 ? '' : 's'}</span>
              <span className={`pill ${w.cls}`}>{w.text}</span>
              {best != null && <span className="pill score">Best {best}%</span>}
            </div>
          </Link>
        );
      })}
    </Layout>
  );
}
