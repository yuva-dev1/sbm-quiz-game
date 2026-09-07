import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ClipboardCheck, LoaderCircle, RotateCcw } from 'lucide-react';
import { api } from './api.js';
import QuestionCard from './QuestionCard.jsx';

/** The course landing page — where "Back to the course" always lands. */
const COURSE_HOME = 'https://www.srimadbhagavatamcourse.org/english-6month-selfpaced';

/**
 * "Back to the course" should return the student to the course overview, not
 * the individual lesson page. If the embedding page handed us a deep lesson
 * URL in ?back=, trim it back to the course root; otherwise use COURSE_HOME.
 */
function courseHomeUrl(back) {
  const marker = '/english-6month-selfpaced';
  try {
    const url = new URL(back);
    const i = url.pathname.indexOf(marker);
    if (i !== -1) return `${url.origin}${url.pathname.slice(0, i + marker.length)}`;
  } catch {
    // ?back= was empty or not an absolute URL — fall through to the default.
  }
  return COURSE_HOME;
}

/**
 * The quiz, embedded in an <iframe> on the Squarespace course page. The
 * member's identity comes in as ?sid=<Squarespace siteUserId>; ?back=<url>
 * (optional) is the course page to return to. No login here.
 */
export default function TakeQuiz() {
  const { n } = useParams();
  const [params] = useSearchParams();
  const sid = params.get('sid') || '';
  const backHref = courseHomeUrl(params.get('back') || '');
  const preview = params.get('preview') === '1';
  const previewVersion = preview ? params.get('v') || '' : '';

  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [selected, setSelected] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const rootRef = useRef(null);

  const load = useCallback(() => {
    setState({ loading: true, error: '', data: null });
    let q = preview ? 'preview=1' : `sid=${encodeURIComponent(sid)}`;
    if (previewVersion) q += `&v=${encodeURIComponent(previewVersion)}`;
    api
      .get(`/api/q/${n}?${q}`)
      .then((data) => setState({ loading: false, error: '', data }))
      .catch((error) => setState({ loading: false, error: error.message, data: null }));
  }, [n, sid, preview, previewVersion]);

  useEffect(load, [load]);

  // Report height to the parent Squarespace page so the iframe can grow.
  useLayoutEffect(() => {
    const post = () => {
      const h = rootRef.current?.scrollHeight;
      if (h) window.parent?.postMessage({ type: 'sbm-quiz-height', height: h }, '*');
    };
    post();
    const ro = new ResizeObserver(post);
    if (rootRef.current) ro.observe(rootRef.current);
    return () => ro.disconnect();
  });

  const reviewByQuestion = useMemo(
    () => (result ? Object.fromEntries(result.answers.map((a) => [a.questionId, a])) : {}),
    [result]
  );

  const wrap = (children) => (
    <div className="quiz-embed" ref={rootRef}>
      {children}
    </div>
  );

  if (state.loading) {
    return wrap(
      <div className="center-load"><LoaderCircle className="spin" size={24} /></div>
    );
  }

  if (state.error || !state.data) {
    return wrap(
      <div className="card">
        <p className="error" style={{ margin: 0 }}>
          {state.error || 'This quiz could not be loaded.'}
        </p>
        {!sid && (
          <p className="muted" style={{ marginTop: 8 }}>
            Open the quiz from the course lesson so we know who you are.
          </p>
        )}
      </div>
    );
  }

  const { firstName, bestPercentage, lastPercentage, attemptCount, version, liveVersion, week } = state.data;
  const viewingOldVersion = preview && version != null && liveVersion != null && version !== liveVersion;

  const submit = async () => {
    const unanswered = week.questions.filter((q) => !(selected[q.id]?.length)).length;
    if (unanswered > 0) {
      setSubmitError(`Please answer every question — ${unanswered} left.`);
      return;
    }
    setSubmitError('');
    setSubmitting(true);
    try {
      const body = preview ? { preview: true, selected } : { sid, selected };
      const { attempt } = await api.post(`/api/q/${n}/submit`, body);
      setResult(attempt);
      rootRef.current?.scrollIntoView({ block: 'start' });
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
  };

  return wrap(
    <>
      {preview && (
        <p className="info" style={{ marginBottom: 12 }}>
          Host preview — this is exactly what a student sees. Nothing is saved.
          {version != null && (
            viewingOldVersion
              ? ` Showing version ${version} (not live — live is v${liveVersion}).`
              : ` Showing the live quiz (version ${version}).`
          )}
        </p>
      )}
      <p className="eyebrow">Week {week.weekNumber} quiz{firstName ? ` · ${firstName}` : ''}</p>
      <h1 style={{ fontSize: 30 }}>{result ? 'Your results' : week.title}</h1>

      {result && (
        <div className="scorebar">
          <strong>{result.percentage}%</strong>
          <span className="muted">{result.correctCount} of {result.totalQuestions} correct</span>
        </div>
      )}
      {!result && attemptCount > 0 && (
        <p className="muted" style={{ marginTop: 4 }}>
          You&rsquo;ve taken this quiz {attemptCount} time{attemptCount === 1 ? '' : 's'}. Best{' '}
          {bestPercentage}%
          {lastPercentage != null && lastPercentage !== bestPercentage ? `, last ${lastPercentage}%` : ''}.
          {week.open ? ' You can retake it below.' : ''}
        </p>
      )}

      {!week.open && !result && !preview && (
        <p className="info">This quiz is currently closed for submissions. You can still review the questions.</p>
      )}

      {week.questions.length === 0 && (
        <p className="muted">No questions yet — add some in the host quiz editor.</p>
      )}

      {week.questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          index={index}
          question={question}
          selected={selected[question.id] || []}
          onToggle={(choices) => setSelected((cur) => ({ ...cur, [question.id]: choices }))}
          disabled={Boolean(result) || !week.open}
          review={reviewByQuestion[question.id]}
        />
      ))}

      {submitError && <p className="error">{submitError}</p>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
        {result ? (
          <>
            {week.open && (
              <button className="btn secondary" type="button" onClick={retake}>
                <RotateCcw size={16} /> Retake
              </button>
            )}
            {!preview && (
              <a className="btn" href={backHref} target="_top">
                Back to the course <ArrowRight size={16} />
              </a>
            )}
          </>
        ) : week.open && week.questions.length > 0 ? (
          <button className="btn" type="button" onClick={submit} disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={16} /> : <ClipboardCheck size={16} />} Submit quiz
          </button>
        ) : (
          !preview && (
            <a className="btn secondary" href={backHref} target="_top">
              <CheckCircle2 size={16} /> Back to the course
            </a>
          )
        )}
      </div>
    </>
  );
}
