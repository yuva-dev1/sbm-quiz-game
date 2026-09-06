import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';
import { LessonVideo } from '../video.jsx';

export default function WeekPage() {
  const { n } = useParams();
  const [state, setState] = useState({ loading: true, error: '', week: null, best: null });

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get(`/api/weeks/${n}`),
      api.get('/api/attempts').catch(() => ({ attempts: [] }))
    ])
      .then(([week, history]) => {
        if (!active) return;
        const forWeek = (history.attempts || []).filter((a) => Number(a.weekNumber) === Number(n));
        const best = forWeek.length ? Math.max(...forWeek.map((a) => a.percentage)) : null;
        setState({ loading: false, error: '', week, best });
      })
      .catch((error) => active && setState((s) => ({ ...s, loading: false, error: error.message })));
    return () => {
      active = false;
    };
  }, [n]);

  if (state.loading) {
    return (
      <Layout>
        <div className="center-load"><LoaderCircle className="spin" size={26} /></div>
      </Layout>
    );
  }

  if (state.error || !state.week) {
    return (
      <Layout>
        <Link className="linkbtn" to="/"><ArrowLeft size={14} /> Back to course</Link>
        <p className="error" style={{ marginTop: 16 }}>{state.error || 'Week not found.'}</p>
      </Layout>
    );
  }

  const { week } = state;
  const canTake = week.windowState === 'open' && week.questions.length > 0;

  return (
    <Layout>
      <Link className="linkbtn" to="/"><ArrowLeft size={14} /> Back to course</Link>
      <p className="eyebrow" style={{ marginTop: 16 }}>Week {week.weekNumber}</p>
      <h1>{week.title}</h1>
      {week.summary && <p className="muted" style={{ margin: '8px 0 20px' }}>{week.summary}</p>}

      {week.lessons.map((lesson, i) => (
        <section className="lesson" key={i}>
          {lesson.title && <h3>{lesson.title}</h3>}
          <LessonVideo url={lesson.videoUrl} title={lesson.title} />
          {lesson.description && <p className="muted" style={{ marginTop: 8 }}>{lesson.description}</p>}
        </section>
      ))}

      <div className="card" style={{ marginTop: 24 }}>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>Week {week.weekNumber} quiz</h3>
        <p className="muted" style={{ margin: '6px 0 14px' }}>
          {week.questions.length} question{week.questions.length === 1 ? '' : 's'}.
          {state.best != null && ` Your best so far: ${state.best}%.`}
          {week.windowState !== 'open' && ' This quiz is currently closed.'}
        </p>
        {canTake ? (
          <Link className="btn" to={`/week/${week.weekNumber}/quiz`}>
            {state.best == null ? 'Take the quiz' : 'Retake the quiz'} <ArrowRight size={16} />
          </Link>
        ) : (
          <button className="btn" disabled>Quiz unavailable</button>
        )}
      </div>
    </Layout>
  );
}
