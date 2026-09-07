import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoaderCircle, Lock, LockOpen, Plus } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';

export default function HostWeeks() {
  const [state, setState] = useState({ loading: true, error: '', weeks: [] });
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    api
      .get('/api/host/weeks')
      .then((data) => setState({ loading: false, error: '', weeks: data.weeks || [] }))
      .catch((error) => setState({ loading: false, error: error.message, weeks: [] }));
  }, []);

  useEffect(load, [load]);

  const act = async (weekNumber, path, body) => {
    setBusy(weekNumber);
    try {
      await api.post(`/api/host/weeks/${weekNumber}/${path}`, body);
      load();
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setBusy(null);
    }
  };

  const nextWeekNumber = state.weeks.reduce((max, w) => Math.max(max, w.weekNumber), 0) + 1;

  return (
    <Layout>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <p className="eyebrow">Course host</p>
          <h1>Weekly quizzes</h1>
        </div>
        <Link className="btn" to={`/host/week/${nextWeekNumber}`}><Plus size={16} /> New week</Link>
      </div>

      {state.loading && <div className="center-load"><LoaderCircle className="spin" size={24} /></div>}
      {state.error && <p className="error" style={{ marginTop: 16 }}>{state.error}</p>}

      {!state.loading && state.weeks.length === 0 && !state.error && (
        <p className="muted" style={{ marginTop: 16 }}>No quizzes yet. Create the first one.</p>
      )}

      {state.weeks.map((week) => {
        const published = week.status === 'PUBLISHED';
        const hasQuiz = week.quiz.length > 0;
        const spinning = busy === week.weekNumber;

        let statusPill;
        if (!published) statusPill = { cls: 'closed', text: 'Draft' };
        else if (!hasQuiz) statusPill = { cls: 'closed', text: 'No questions' };
        else if (week.responsesOpen) statusPill = { cls: 'open', text: 'Open' };
        else statusPill = { cls: 'closed', text: 'Closed' };

        return (
          <div className="card" key={week.weekNumber} style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <span className="kicker">Week {week.weekNumber}{published ? `  ·  /q/${week.weekNumber}` : ''}</span>
              <h2 style={{ fontSize: 22 }}>{week.title}</h2>
              <div className="meta">
                <span>{week.quiz.length} question{week.quiz.length === 1 ? '' : 's'}</span>
                <span className={`pill ${statusPill.cls}`}>{statusPill.text}</span>
              </div>
            </div>

            <Link className="btn secondary small" to={`/host/week/${week.weekNumber}`}>Edit</Link>

            {published && (
              <button
                className="btn small"
                type="button"
                onClick={() => act(week.weekNumber, 'responses', { open: !week.responsesOpen })}
                disabled={spinning || !hasQuiz}
                title={hasQuiz ? '' : 'Add questions first'}
              >
                {spinning ? <LoaderCircle className="spin" size={14} /> : week.responsesOpen ? <Lock size={14} /> : <LockOpen size={14} />}
                {week.responsesOpen ? 'Close' : 'Open'}
              </button>
            )}

            <button
              className="btn ghost small"
              type="button"
              onClick={() => act(week.weekNumber, published ? 'unpublish' : 'publish')}
              disabled={spinning}
            >
              {spinning ? <LoaderCircle className="spin" size={14} /> : null}
              {published ? 'Unpublish' : 'Publish'}
            </button>
          </div>
        );
      })}
    </Layout>
  );
}
