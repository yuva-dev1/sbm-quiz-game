import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, History, LoaderCircle, Pencil, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
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

  const [versions, setVersions] = useState({ liveVersion: null, list: [] });
  const [versionBusy, setVersionBusy] = useState(null);

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

  const loadVersions = useCallback(() => {
    api
      .get(`/api/host/weeks/${weekNumber}/versions`)
      .then((data) => setVersions({ liveVersion: data.liveVersion || null, list: (data.versions || []).slice().reverse() }))
      .catch(() => setVersions({ liveVersion: null, list: [] }));
  }, [weekNumber]);

  useEffect(loadVersions, [loadVersions]);

  const restoreVersion = async (version) => {
    if (!window.confirm(`Make version ${version} the live quiz? Students will see it immediately. Your current questions are already saved as their own version, so this is reversible.`)) {
      return;
    }
    setVersionBusy(version);
    try {
      await api.post(`/api/host/weeks/${weekNumber}/versions/${version}/restore`);
      load();
      loadVersions();
    } catch (error) {
      setPageError(error.message);
    } finally {
      setVersionBusy(null);
    }
  };

  const renameVersion = async (version, current) => {
    const label = window.prompt('Name this version (e.g. "the one we kept"):', current || '');
    if (label === null) return;
    setVersionBusy(version);
    try {
      await api.post(`/api/host/weeks/${weekNumber}/versions/${version}/label`, { label: label.trim() });
      loadVersions();
    } catch (error) {
      setPageError(error.message);
    } finally {
      setVersionBusy(null);
    }
  };

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
      loadVersions();
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
          <Eye size={16} /> Preview (latest saved version)
        </a>
        {savedNote && <span className="info" style={{ margin: 0 }}>{savedNote}</span>}
        {saveError && <span className="error" style={{ margin: 0 }}>{saveError}</span>}
        <button className="btn ghost" type="button" onClick={() => navigate('/host')}>Done</button>
      </div>

      <PreviewLink weekNumber={weekNumber} />

      <VersionHistory
        weekNumber={weekNumber}
        versions={versions}
        busy={versionBusy}
        onRestore={restoreVersion}
        onRename={renameVersion}
      />
    </Layout>
  );
}

/** The shareable host-preview URL for this week — opens whatever is currently
 *  live (the newest save, or an older version you restored). */
function PreviewLink({ weekNumber }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/q/${weekNumber}?preview=1`;
  const copy = () => {
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  };
  return (
    <p className="muted" style={{ marginTop: 14, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>Preview link (opens the live quiz — sign in to <code>/host</code> first):</span>
      <code style={{ background: 'var(--ground)', padding: '2px 6px', borderRadius: 6, wordBreak: 'break-all' }}>{url}</code>
      <button type="button" className="linkbtn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </p>
  );
}

/** Every saved edit of this week's quiz. The newest is normally live; "Restore"
 *  points the live quiz back at an older one (students see it right away). */
function VersionHistory({ weekNumber, versions, busy, onRestore, onRename }) {
  const list = versions.list || [];
  if (list.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <p className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <History size={14} /> Version history
      </p>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Every save is kept. Restoring an older version makes it the live quiz — nothing is lost.
      </p>
      <div className="table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Saved</th>
              <th>Name</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list.map((v) => {
              const spinning = busy === v.version;
              return (
                <tr key={v.version}>
                  <td className="num">
                    v{v.version}
                    {v.isLive && <span className="pill open" style={{ marginLeft: 6 }}>Live</span>}
                  </td>
                  <td>{v.createdAt ? new Date(v.createdAt).toLocaleString() : '—'}</td>
                  <td>{v.label || <span className="muted">—</span>}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <a
                      className="btn ghost small"
                      href={`/q/${weekNumber}?preview=1&v=${v.version}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Preview this version"
                    >
                      <Eye size={13} />
                    </a>{' '}
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => onRename(v.version, v.label)}
                      disabled={spinning}
                      title="Rename"
                    >
                      <Pencil size={13} />
                    </button>{' '}
                    {!v.isLive && (
                      <button
                        className="btn small"
                        type="button"
                        onClick={() => onRestore(v.version)}
                        disabled={spinning}
                        title="Make this the live quiz"
                      >
                        {spinning ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} Restore
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
