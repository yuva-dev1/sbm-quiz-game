import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, LoaderCircle, ListChecks } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';

export default function HostScores() {
  const [state, setState] = useState({ loading: true, error: '', weeks: [], students: [] });

  useEffect(() => {
    api
      .get('/api/host/scores')
      .then((data) => setState({ loading: false, error: '', weeks: data.weeks || [], students: data.students || [] }))
      .catch((error) => setState({ loading: false, error: error.message, weeks: [], students: [] }));
  }, []);

  return (
    <Layout>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <p className="eyebrow">Course host</p>
          <h1>Scores</h1>
          <p className="muted" style={{ fontSize: 13 }}>Latest score per student per week. A retake shows &times;N — hover for best / last.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link className="btn ghost" to="/host/attempts"><ListChecks size={16} /> All attempts</Link>
          <a className="btn secondary" href="/api/host/scores.csv"><Download size={16} /> Download CSV</a>
        </div>
      </div>

      {state.loading && <div className="center-load"><LoaderCircle className="spin" size={24} /></div>}
      {state.error && <p className="error" style={{ marginTop: 16 }}>{state.error}</p>}

      {!state.loading && !state.error && (
        state.students.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>No quiz attempts yet.</p>
        ) : (
          <div className="table-scroll" style={{ marginTop: 16 }}>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Student</th>
                  {state.weeks.map((w) => <th key={w.weekNumber}>Week {w.weekNumber}</th>)}
                </tr>
              </thead>
              <tbody>
                {state.students.map((s, i) => (
                  <tr key={s.email || s.name || i}>
                    <td>
                      <div>{s.name || '—'}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{s.email}</div>
                    </td>
                    {state.weeks.map((w) => {
                      const cell = s.cells[w.weekNumber];
                      const tip = cell
                        ? `Latest ${cell.percentage}% · best ${cell.best}% · ${cell.attemptCount} attempt${cell.attemptCount === 1 ? '' : 's'} · last ${new Date(cell.submittedAt).toLocaleString()}`
                        : '';
                      return (
                        <td className="num" key={w.weekNumber} title={tip}>
                          {cell ? (
                            <>
                              {cell.percentage}%
                              {cell.attemptCount > 1 && (
                                <span style={{ marginLeft: 5, fontSize: 11, color: 'var(--ink-soft)' }}>
                                  &times;{cell.attemptCount}
                                </span>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      );
                    })}
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
