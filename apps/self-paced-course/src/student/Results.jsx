import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';
import QuestionCard from '../QuestionCard.jsx';

export default function Results() {
  const [state, setState] = useState({ loading: true, error: '', attempts: [] });
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let active = true;
    api
      .get('/api/attempts')
      .then((data) => active && setState({ loading: false, error: '', attempts: data.attempts || [] }))
      .catch((error) => active && setState({ loading: false, error: error.message, attempts: [] }));
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

  return (
    <Layout>
      <p className="eyebrow">Your history</p>
      <h1>Quizzes you’ve taken</h1>

      {state.error && <p className="error" style={{ marginTop: 16 }}>{state.error}</p>}
      {!state.error && state.attempts.length === 0 && (
        <p className="muted" style={{ marginTop: 16 }}>You haven’t submitted any quizzes yet.</p>
      )}

      {state.attempts.map((attempt) => {
        const isOpen = open === attempt.id;
        return (
          <div className="card" key={attempt.id}>
            <button
              type="button"
              className="linkbtn"
              style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'var(--ink)' }}
              onClick={() => setOpen(isOpen ? null : attempt.id)}
            >
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <strong style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>Week {attempt.weekNumber}</strong>
              <span className="muted">{new Date(attempt.submittedAt).toLocaleString()}</span>
              <span className="pill score" style={{ marginLeft: 'auto' }}>
                {attempt.percentage}% · {attempt.correctCount}/{attempt.totalQuestions}
              </span>
            </button>

            {isOpen && (
              <div style={{ marginTop: 14 }}>
                {(attempt.answers || []).map((a, index) => (
                  <QuestionCard
                    key={a.questionId || index}
                    index={index}
                    question={{ id: a.questionId || `q${index}`, type: 'MULTIPLE_CHOICE', question: a.question, choices: a.choices || [] }}
                    selected={a.selectedChoices || []}
                    onToggle={() => {}}
                    disabled
                    review={{ correct: a.correct, correctChoices: a.correctChoices, explanation: a.explanation }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Layout>
  );
}
