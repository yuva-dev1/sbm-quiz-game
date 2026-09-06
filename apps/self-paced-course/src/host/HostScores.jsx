import { useEffect, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
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
    <Layout variant="host">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <p className="eyebrow">Course host</p>
          <h1>Scores</h1>
        </div>
        <a className="btn secondary" href="/api/host/scores.csv"><Download size={16} /> Download CSV</a>
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
                {state.students.map((s) => (
                  <tr key={s.email}>
                    <td>
                      <div>{s.name || '—'}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{s.email}</div>
                    </td>
                    {state.weeks.map((w) => {
                      const cell = s.cells[w.weekNumber];
                      return (
                        <td className="num" key={w.weekNumber} title={cell ? new Date(cell.submittedAt).toLocaleString() : ''}>
                          {cell ? `${cell.percentage}%` : '—'}
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
