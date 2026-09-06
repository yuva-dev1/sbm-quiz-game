import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck, LoaderCircle, RotateCcw } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';
import QuestionCard from '../QuestionCard.jsx';

export default function TakeQuiz() {
  const { n } = useParams();
  const [week, setWeek] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let active = true;
    api
      .get(`/api/weeks/${n}`)
      .then((data) => active && setWeek(data))
      .catch((error) => active && setLoadError(error.message));
    return () => {
      active = false;
    };
  }, [n]);

  const reviewByQuestion = useMemo(() => {
    if (!result) return {};
    return Object.fromEntries(result.answers.map((a) => [a.questionId, a]));
  }, [result]);

  if (loadError) {
    return (
      <Layout>
        <Link className="linkbtn" to={`/week/${n}`}><ArrowLeft size={14} /> Back to week</Link>
        <p className="error" style={{ marginTop: 16 }}>{loadError}</p>
      </Layout>
    );
  }
  if (!week) {
    return (
      <Layout>
        <div className="center-load"><LoaderCircle className="spin" size={26} /></div>
      </Layout>
    );
  }

  const submit = async () => {
    const unanswered = week.questions.filter((q) => !(selected[q.id]?.length)).length;
    if (unanswered > 0) {
      setSubmitError(`Please answer every question — ${unanswered} left.`);
      return;
    }
    setSubmitError('');
    setSubmitting(true);
    try {
      const { attempt } = await api.post(`/api/weeks/${n}/attempt`, { selected });
      setResult(attempt);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setSubmitError(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const retake = () => {
    setSelected({});
    setResult(null);
    setSubmitError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <Layout>
      <Link className="linkbtn" to={`/week/${n}`}><ArrowLeft size={14} /> Back to week</Link>
      <p className="eyebrow" style={{ marginTop: 16 }}>Week {week.weekNumber}</p>
      <h1>{result ? 'Your results' : `${week.title} quiz`}</h1>

      {result && (
        <div className="scorebar">
          <strong>{result.percentage}%</strong>
          <span className="muted">{result.correctCount} of {result.totalQuestions} correct</span>
        </div>
      )}

      {week.questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          index={index}
          question={question}
          selected={selected[question.id] || []}
          onToggle={(choices) => setSelected((cur) => ({ ...cur, [question.id]: choices }))}
          disabled={Boolean(result)}
          review={reviewByQuestion[question.id]}
        />
      ))}

      {submitError && <p className="error">{submitError}</p>}

      {result ? (
        <button className="btn secondary" type="button" onClick={retake}>
          <RotateCcw size={16} /> Retake
        </button>
      ) : (
        <button className="btn" type="button" onClick={submit} disabled={submitting}>
          {submitting ? <LoaderCircle className="spin" size={16} /> : <ClipboardCheck size={16} />} Submit quiz
        </button>
      )}
    </Layout>
  );
}
