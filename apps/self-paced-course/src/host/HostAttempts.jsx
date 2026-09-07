import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download, LoaderCircle, Trash2 } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';

/**
 * Every quiz submission, newest first — one row per attempt, retakes included.
 * The host can filter by week and delete a bogus / test attempt.
 */
export default function HostAttempts() {
  const [state, setState] = useState({ loading: true, error: '', attempts: [] });
  const [week, setWeek] = useState('all');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    api
      .get('/api/host/attempts')
      .then((data) => setState({ loading: false, error: '', attempts: data.attempts || [] }))
      .catch((error) => setState({ loading: false, error: error.message, attempts: [] }));
  }, []);

  useEffect(load, [load]);

  const weekOptions = useMemo(
    () => [...new Set(state.attempts.map((a) => a.weekNumber))].sort((x, y) => x - y),
    [state.attempts]
  );

  const rows = useMemo(
    () => (week === 'all' ? state.attempts : state.attempts.filter((a) => a.weekNumber === Number(week))),
    [state.attempts, week]
  );

  const remove = async (attempt) => {
    if (!window.confirm(`Delete ${attempt.name || attempt.email || 'this'} — Week ${attempt.weekNumber}, ${attempt.percentage}%? This cannot be undone.`)) {
      return;
    }
    setBusyId(attempt.id);
    try {
      await api.post(`/api/host/attempts/${encodeURIComponent(attempt.id)}/delete`);
      setState((s) => ({ ...s, attempts: s.attempts.filter((a) => a.id !== attempt.id) }));
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Layout>
      <Link className="linkbtn" to="/host/scores"><ArrowLeft size={14} /> Back to scores</Link>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
        <div>
          <p className="eyebrow">Course host</p>
          <h1>All attempts</h1>
          <p className="muted" style={{ fontSize: 13 }}>
            Every submission is kept — retakes included. {state.attempts.length} total.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Week</span>
            <select value={week} onChange={(e) => setWeek(e.target.value)}>
              <option value="all">All weeks</option>
              {weekOptions.map((w) => <option key={w} value={w}>Week {w}</option>)}
            </select>
          </label>
          <a className="btn secondary" href="/api/host/attempts.csv"><Download size={16} /> Download CSV</a>
        </div>
      </div>

      {state.loading && <div className="center-load"><LoaderCircle className="spin" size={24} /></div>}
      {state.error && <p className="error" style={{ marginTop: 16 }}>{state.error}</p>}

      {!state.loading && !state.error && (
        rows.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>No attempts{week === 'all' ? ' yet' : ` for week ${week}`}.</p>
        ) : (
          <div className="table-scroll" style={{ marginTop: 16 }}>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Week</th>
                  <th>Quiz version</th>
                  <th>Submitted</th>
                  <th>Score</th>
                  <th aria-label="Delete" />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div>{a.name || '—'}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{a.email}</div>
                    </td>
                    <td className="num">{a.weekNumber}</td>
                    <td className="num">{a.quizVersion ? `v${a.quizVersion}` : '—'}</td>
                    <td>{a.submittedAt ? new Date(a.submittedAt).toLocaleString() : '—'}</td>
                    <td className="num">{a.percentage}% <span className="muted" style={{ fontSize: 11 }}>({a.correctCount}/{a.totalQuestions})</span></td>
                    <td className="num">
                      <button
                        className="btn ghost small"
                        type="button"
                        onClick={() => remove(a)}
                        disabled={busyId === a.id}
                        title="Delete this attempt"
                      >
                        {busyId === a.id ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Layout>
  );
}
