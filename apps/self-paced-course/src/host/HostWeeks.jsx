import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoaderCircle, Plus } from 'lucide-react';
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

  const toggle = async (week) => {
    setBusy(week.weekNumber);
    try {
      await api.post(`/api/host/weeks/${week.weekNumber}/${week.status === 'PUBLISHED' ? 'unpublish' : 'publish'}`);
      load();
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setBusy(null);
    }
  };

  const nextWeekNumber = state.weeks.reduce((max, w) => Math.max(max, w.weekNumber), 0) + 1;

  return (
    <Layout variant="host">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <p className="eyebrow">Course host</p>
          <h1>Weeks</h1>
        </div>
        <Link className="btn" to={`/host/week/${nextWeekNumber}`}><Plus size={16} /> New week</Link>
      </div>

      {state.loading && <div className="center-load"><LoaderCircle className="spin" size={24} /></div>}
      {state.error && <p className="error" style={{ marginTop: 16 }}>{state.error}</p>}

      {!state.loading && state.weeks.length === 0 && !state.error && (
        <p className="muted" style={{ marginTop: 16 }}>No weeks yet. Create the first one.</p>
      )}

      {state.weeks.map((week) => (
        <div className="card" key={week.weekNumber} style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px' }}>
            <span className="kicker">Week {week.weekNumber} · {week.status}</span>
            <h2 style={{ fontSize: 22 }}>{week.title}</h2>
            <div className="meta">
              <span>{week.lessons.length} lesson{week.lessons.length === 1 ? '' : 's'}</span>
              <span>{week.quiz.length} question{week.quiz.length === 1 ? '' : 's'}</span>
              <span className={`pill ${week.responsesOpen ? 'open' : 'closed'}`}>{week.responsesOpen ? 'Accepting responses' : 'Closed'}</span>
            </div>
          </div>
          <Link className="btn secondary small" to={`/host/week/${week.weekNumber}`}>Edit</Link>
          <button className="btn small" type="button" onClick={() => toggle(week)} disabled={busy === week.weekNumber || (week.status !== 'PUBLISHED' && week.quiz.length === 0)}>
            {busy === week.weekNumber ? <LoaderCircle className="spin" size={14} /> : null}
            {week.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      ))}
    </Layout>
  );
}
