import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, LoaderCircle, Plus, Sparkles, Trash2 } from 'lucide-react';
import Layout from '../Layout.jsx';
import { api } from '../api.js';
import { generateWithProgress } from '../generateClient.js';

const DIFFICULTY_MAP = { Mixed: 'mixed', Foundations: 'beginner', Discussion: 'intermediate', Challenge: 'advanced' };
const COUNTS = [5, 8, 10, 15, 20, 25, 30, 35];

const blankQuestion = () => ({
  id: crypto.randomUUID(),
  type: 'MULTIPLE_CHOICE',
  question: '',
  choices: ['', '', '', ''],
  correctChoices: [],
  explanation: '',
  sourceExcerpt: null
});

function progressLabel(p) {
  if (!p) return 'Starting…';
  if (p.phase === 'draft') return `Drafting ${p.completed} of ${p.total}…`;
  if (p.phase === 'repairing') return 'Fixing up a few questions…';
  return 'Double-checking against the source…';
}

export default function HostWeekEditor() {
  const { n } = useParams();
  const navigate = useNavigate();
  const weekNumber = Number(n);

  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState('');

  const [title, setTitle] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [questions, setQuestions] = useState([]);

  const [catalog, setCatalog] = useState({ weeks: [] });
  const [genWeekIds, setGenWeekIds] = useState([]);
  const [genTopic, setGenTopic] = useState('');
  const [genCount, setGenCount] = useState(8);
  const [genDifficulty, setGenDifficulty] = useState('Mixed');
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(null);
  const [genError, setGenError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/api/host/weeks'),
      fetch('/course-catalog.json').then((r) => (r.ok ? r.json() : { weeks: [] })).catch(() => ({ weeks: [] }))
    ])
      .then(([data, cat]) => {
        setCatalog(cat);
        setGenWeekIds(cat.weeks[0] ? [cat.weeks[0].id] : []);
        const existing = (data.weeks || []).find((w) => w.weekNumber === weekNumber);
        if (existing) {
          setTitle(existing.title);
          setQuestions(existing.quiz || []);
          setOpensAt(toLocalInput(existing.opensAt));
          setClosesAt(toLocalInput(existing.closesAt));
        }
        setLoading(false);
      })
      .catch((error) => {
        setPageError(error.message);
        setLoading(false);
      });
  }, [weekNumber]);

  useEffect(load, [load]);

  const genTopics = useMemo(() => {
    const picked = catalog.weeks.filter((w) => genWeekIds.includes(w.id));
    return [...new Set(picked.flatMap((w) => w.topics || []))];
  }, [catalog, genWeekIds]);

  const generate = async () => {
    if (genWeekIds.length === 0) return;
    setGenerating(true);
    setGenError('');
    setGenProgress(null);
    try {
      const raw = await generateWithProgress(
        {
          weekIds: genWeekIds,
          topics: genTopic ? [genTopic] : [],
          questionCount: Number(genCount),
          difficulty: DIFFICULTY_MAP[genDifficulty]
        },
        { onProgress: setGenProgress, signal: AbortSignal.timeout(600_000) }
      );
      const { questions: normalized } = await api.post('/api/host/quiz/normalize', raw);
      if (!normalized?.length) throw new Error('The generator returned no questions.');
      setQuestions(normalized);
    } catch (error) {
      setGenError(error.name === 'TimeoutError' ? 'Generation timed out.' : error.message);
    } finally {
      setGenerating(false);
      setGenProgress(null);
    }
  };

  const save = async () => {
    setSaveError('');
    setSavedNote('');
    if (!title.trim()) {
      setSaveError('A quiz title is required.');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/api/host/weeks/${weekNumber}`, {
        title: title.trim(),
        quiz: questions,
        opensAt: opensAt ? new Date(opensAt).toISOString() : null,
        closesAt: closesAt ? new Date(closesAt).toISOString() : null
      });
      setSavedNote('Saved.');
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div className="center-load"><LoaderCircle className="spin" size={24} /></div>
      </Layout>
    );
  }

  return (
    <Layout>
      <Link className="linkbtn" to="/host"><ArrowLeft size={14} /> All quizzes</Link>
      <h1 style={{ marginTop: 14 }}>Week {weekNumber} quiz</h1>
      {pageError && <p className="error">{pageError}</p>}

      <div className="card">
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Week 1 Assessment Quiz" />
        </label>
        <div className="row">
          <label className="field">
            <span>Opens at (optional)</span>
            <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          </label>
          <label className="field">
            <span>Closes at (optional)</span>
            <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
          </label>
        </div>
      </div>

      <h2 style={{ marginTop: 26, fontSize: 24 }}>Questions</h2>
      <div className="card">
        <p className="eyebrow">Generate from the class notes</p>
        <div className="row">
          <label className="field">
            <span>Catalog week</span>
            <select value={genWeekIds[0] || ''} onChange={(e) => { setGenWeekIds([e.target.value]); setGenTopic(''); }}>
              {catalog.weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Topic</span>
            <select value={genTopic} onChange={(e) => setGenTopic(e.target.value)}>
              <option value="">All topics</option>
              {genTopics.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Questions</span>
            <select value={genCount} onChange={(e) => setGenCount(Number(e.target.value))}>
              {COUNTS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Difficulty</span>
            <select value={genDifficulty} onChange={(e) => setGenDifficulty(e.target.value)}>
              {Object.keys(DIFFICULTY_MAP).map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
        </div>
        {genError && <p className="error">{genError}</p>}
        <button className="btn" type="button" onClick={generate} disabled={generating || genWeekIds.length === 0}>
          {generating ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
          {generating ? progressLabel(genProgress) : 'Generate questions'}
        </button>
        {generating && <p className="muted" style={{ marginTop: 8 }}>Grounded generation can take a couple of minutes.</p>}
      </div>

      {questions.map((q, qi) => (
        <div className="card" key={q.id}>
          <label className="field">
            <span>Question {qi + 1}</span>
            <textarea value={q.question} onChange={(e) => updateItem(setQuestions, qi, { question: e.target.value })} />
          </label>
          {q.choices.map((choice, ci) => (
            <div key={ci} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <input
                type="radio"
                name={`correct-${q.id}`}
                checked={q.correctChoices.includes(choice) && choice !== ''}
                onChange={() => updateItem(setQuestions, qi, { correctChoices: [choice] })}
                title="Mark correct"
              />
              <input
                style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8 }}
                value={choice}
                onChange={(e) => {
                  const choices = [...q.choices];
                  const wasCorrect = q.correctChoices.includes(choice);
                  choices[ci] = e.target.value;
                  updateItem(setQuestions, qi, { choices, correctChoices: wasCorrect ? [e.target.value] : q.correctChoices });
                }}
              />
            </div>
          ))}
          <label className="field" style={{ marginTop: 8 }}>
            <span>Explanation (optional)</span>
            <textarea value={q.explanation} onChange={(e) => updateItem(setQuestions, qi, { explanation: e.target.value })} />
          </label>
          <button className="btn ghost small" type="button" onClick={() => setQuestions((cur) => cur.filter((_, idx) => idx !== qi))}>
            <Trash2 size={13} /> Remove question
          </button>
        </div>
      ))}
      <button className="btn secondary small" type="button" onClick={() => setQuestions((cur) => [...cur, blankQuestion()])}>
        <Plus size={14} /> Add blank question
      </button>

      <div style={{ marginTop: 28, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={save} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={16} /> : null} Save quiz
        </button>
        <a className="btn secondary" href={`/q/${weekNumber}?preview=1`} target="_blank" rel="noreferrer">
          <Eye size={16} /> Preview (saved version)
        </a>
        {savedNote && <span className="info" style={{ margin: 0 }}>{savedNote}</span>}
        {saveError && <span className="error" style={{ margin: 0 }}>{saveError}</span>}
        <button className="btn ghost" type="button" onClick={() => navigate('/host')}>Done</button>
      </div>
    </Layout>
  );
}

function updateItem(setter, index, patch) {
  setter((cur) => cur.map((item, i) => (i === index ? { ...item, ...patch } : item)));
}

/** ISO string -> value for <input type="datetime-local"> in local time. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
