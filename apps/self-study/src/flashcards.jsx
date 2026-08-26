import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Layers3,
  LoaderCircle,
  MapPin,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Save,
  Shuffle,
  Sparkles,
  Tag,
  UserRound,
  X
} from 'lucide-react';
import './flashcards.css';
import SelfStudyHeader from './selfStudyHeader.jsx';
import SourceReading from './SourceReading.jsx';
import { OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';
import { getWeekDisplayLabel, getWeekName } from './courseResources.js';
import { generateWithProgress } from './generateClient.js';

const SETS_API_URL = '/api/flashcards/sets';
const ALL_TOPICS = '__all_topics__';

// Matches the host app's own progressLabel() in GenerateQuizForm.tsx — see
// main.jsx's copy of this function for why repair rounds get a static
// message instead of live numbers.
function formatGenerationProgress(progress) {
  if (!progress) return 'Starting...';
  if (progress.phase === 'draft') return `Drafting ${progress.completed} of ${progress.total}...`;
  if (progress.phase === 'repairing') return 'Fixing up a few cards...';
  return 'Double-checking against the source material...';
}

const CARD_COUNTS = [5, 8, 10, 15, 20, 25, 30];
const FALLBACK_CATALOG = {
  weeks: [
    { id: 'week-1', label: 'Week 1', topics: ['Sanatana Dharma', 'Dharma', 'Vedas', 'Upanishads', 'Itihasas', 'Puranas', 'The Great Vedas'] },
    { id: 'week-2', label: 'Week 2', topics: ['Prasthana Traya', 'Upanishads', 'Srimad Bhagavad Gita', 'Brahma Sutras', 'Srimad Bhagavatam as the essence of all three pillars', 'Srimad Bhagavatam Mahatmyam'] },
    { id: 'week-3', label: 'Week 3', topics: ['Dharma', 'Tattva', 'Rasa', 'Essence of all Shastras by Canto', 'Four Major Puranas', 'Four Episodes of Its Greatness', 'Parikshit and the Nectar', 'Narada and Bhakti Devi', 'Atmadeva'] },
    { id: 'week-4', label: 'Week 4', topics: ['Purana', 'Mahatmyam', 'Structure of Srimad Bhagavatam', 'Lineage of Transmission', 'Speakers and Listeners', 'The Story of Atmadeva'] },
    { id: 'week-5', label: 'Week 5', topics: ['Three Types of Samhitas', 'Meaning and Characteristics of a Purana', 'Srimad Bhagavatam as a Mahapurana', 'Ten Lakshanas of Srimad Bhagavatam', 'Ashraya as the Main Subject', 'Cantos and Lakshanas', 'Canto 1 - Speakers and Listeners', 'Outline and Highlights of Canto 1', 'Six Questions of Shaunaka Rishis'] },
    { id: 'week-6', label: 'Week 6', topics: ['Suta Pauranika on True Dharma and Devotion', "Shaunaka Rishi's Four Further Questions", "Sage Vyasa's Birth and Restlessness", "Sage Narada's Arrival and Advice to Vyasa", "Sage Vyasa's Samadhi Vision and Composing Srimad Bhagavatam"] },
    { id: 'week-7', label: 'Week 7', topics: ["Ashwatthama's Revenge and Arjuna Sparing His Life", "Kunti's Stuti After Krishna Protects the Unborn Parikshith", "Bhishmacharya's Final Teachings and Bhishma Stuti", "Parikshith's Birth, Horoscope, and Naming", 'The Four Legs of Dharma: Tapas, Shaucham, Daya, Satyam'] }
  ]
};

const SAMPLE_CARDS = [
  { id: 'sample-1', category: 'Concept', front: 'What is the heart of Sanatana Dharma?', answer: 'To recognize our eternal relationship with Bhagavan and live in harmony with that truth.', detail: 'A card set generated from your selected class notes will appear here.' },
  { id: 'sample-2', category: 'Person', front: 'Who received the Bhagavatam on the banks of the Ganga?', answer: 'Maharaja Parikshit received it from Sri Sukadeva Goswami.', detail: '' },
  { id: 'sample-3', category: 'Place', front: 'Where did the sages gather to hear the Bhagavatam?', answer: 'They gathered in the sacred forest of Naimisharanya.', detail: '' }
];

const CATEGORY_ICONS = {
  Concept: Tag,
  Person: UserRound,
  Place: MapPin,
  Question: CircleHelp
};

function cleanExplanation(value) {
  return String(value || '').trim();
}

function inferCategory(front) {
  const text = String(front || '').trim();
  const prefixed = text.match(/^\[(Concept|Person|Place|Question)\]\s*/i);
  if (prefixed) {
    const category = prefixed[1][0].toUpperCase() + prefixed[1].slice(1).toLowerCase();
    return { category, front: text.slice(prefixed[0].length).trim() };
  }
  if (/^(who|which (sage|king|person|teacher|speaker|listener))\b/i.test(text)) return { category: 'Person', front: text };
  if (/^(where|which (place|forest|river|kingdom|location))\b/i.test(text)) return { category: 'Place', front: text };
  if (/^(what (is|are|does)|define|the meaning of|identify the (concept|term))\b/i.test(text)) return { category: 'Concept', front: text };
  return { category: 'Question', front: text };
}

function normalizeCards(result) {
  const questions = Array.isArray(result?.questions) ? result.questions : [];
  return questions.map((question, index) => {
    const parsed = inferCategory(question.question);
    return {
      id: question.id || `card-${index + 1}`,
      number: index + 1,
      category: parsed.category,
      front: parsed.front,
      answer: String(question.answer || '').trim(),
      originalAnswer: String(question.answer || '').trim(),
      detail: cleanExplanation(question.explanation),
      sourceExcerpt: question.sourceExcerpt || null,
      edited: false
    };
  }).filter((card) => card.front && card.answer);
}

function Logo() {
  return (
    <a className="brand" href="#top" aria-label="Bhagavatam Self Study home">
      <span className="brand-logo-art"><img src={OFFICIAL_GOD_LOGO_URL} alt="Global Organization for Divinity" /></span>
      <span className="brand-copy">
        <strong>Bhagavatam Self Study</strong>
        <em>Atlanta Namadwaar · Class Tools</em>
      </span>
    </a>
  );
}

function WeekAndTopicForm({
  weeks,
  coverageMode,
  setCoverageMode,
  selectedWeekIds,
  setSelectedWeekIds,
  selectedTopics,
  setSelectedTopics,
  cardCount,
  setCardCount,
  onGenerate,
  isGenerating,
  generationProgress
}) {
  const selectedWeeks = weeks.filter((week) => selectedWeekIds.includes(week.id));
  const availableTopics = [...new Set(selectedWeeks.flatMap((week) => week.topics || []))];

  const switchCoverage = (mode) => {
    setCoverageMode(mode);
    setSelectedWeekIds(mode === 'single' ? [selectedWeekIds[0] || weeks[0]?.id] : selectedWeekIds.length > 1 ? selectedWeekIds : weeks.slice(0, 2).map((week) => week.id));
    setSelectedTopics([]);
  };

  const toggleWeek = (weekId) => {
    setSelectedWeekIds((current) => {
      const next = current.includes(weekId) ? current.filter((id) => id !== weekId) : [...current, weekId];
      return next.length ? next : current;
    });
    setSelectedTopics([]);
  };

  const toggleTopic = (topic) => {
    if (topic === ALL_TOPICS) {
      setSelectedTopics([]);
      return;
    }
    setSelectedTopics((current) => current.includes(topic) ? current.filter((item) => item !== topic) : [...current, topic]);
  };

  return (
    <section className="composer-card flashcard-composer" aria-labelledby="flashcard-options-title">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Build a study set</p>
          <h2 id="flashcard-options-title">Choose what to revisit.</h2>
        </div>
        <div className="heading-icon"><Layers3 size={19} /></div>
      </div>

      <div className="choice-section">
        <span className="field-label">Class coverage</span>
        <div className="segmented-control" role="group" aria-label="Class coverage">
          <button type="button" className={coverageMode === 'single' ? 'selected' : ''} aria-pressed={coverageMode === 'single'} onClick={() => switchCoverage('single')}>One week</button>
          <button type="button" className={coverageMode === 'multiple' ? 'selected' : ''} aria-pressed={coverageMode === 'multiple'} onClick={() => switchCoverage('multiple')}>Multiple weeks</button>
        </div>
      </div>

      {coverageMode === 'single' ? (
        <label className="select-field catalog-field choice-section">
          <span className="field-label">Class week</span>
          <span className="select-wrap">
            <select value={selectedWeekIds[0] || weeks[0]?.id} onChange={(event) => { setSelectedWeekIds([event.target.value]); setSelectedTopics([]); }}>
              {weeks.map((week) => <option key={week.id} value={week.id}>{getWeekDisplayLabel(week)}</option>)}
            </select>
            <ChevronDown size={17} />
          </span>
        </label>
      ) : (
        <div className="choice-section">
          <span className="field-label">Choose weeks</span>
          <div className="week-chip-grid" role="group" aria-label="Choose class weeks">
            {weeks.map((week, index) => (
              <label className={`week-chip ${selectedWeekIds.includes(week.id) ? 'selected' : ''}`} key={week.id}>
                <input type="checkbox" checked={selectedWeekIds.includes(week.id)} onChange={() => toggleWeek(week.id)} />
                <span>
                  <b>{String(index + 1).padStart(2, '0')}</b>
                  <span className="week-chip-text">
                    <strong>{week.label}</strong>
                    {getWeekName(week.id) && <small>{getWeekName(week.id)}</small>}
                  </span>
                  <Check size={14} />
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="choice-section">
        <div className="topic-label-row">
          <span className="field-label">Topics</span>
          <span>{selectedTopics.length ? `${selectedTopics.length} selected` : 'All included'}</span>
        </div>
        <div className="topic-chip-list" role="group" aria-label="Choose topics">
          <button type="button" className={!selectedTopics.length ? 'selected' : ''} aria-pressed={!selectedTopics.length} onClick={() => toggleTopic(ALL_TOPICS)}>All topics</button>
          {availableTopics.map((topic) => (
            <button type="button" className={selectedTopics.includes(topic) ? 'selected' : ''} aria-pressed={selectedTopics.includes(topic)} onClick={() => toggleTopic(topic)} key={topic}>{topic}</button>
          ))}
        </div>
      </div>

      <div className="choice-section">
        <span className="field-label">Number of flashcards</span>
        <div className="count-picker" role="group" aria-label="Number of flashcards">
          {CARD_COUNTS.map((count) => (
            <button type="button" className={Number(cardCount) === count ? 'selected' : ''} aria-pressed={Number(cardCount) === count} onClick={() => setCardCount(String(count))} key={count}>{count}</button>
          ))}
        </div>
        <p className="count-helper">Choose up to 30 cards for a deeper review.</p>
      </div>

      <button className="primary-button generate-button flashcard-generate" type="button" onClick={onGenerate} disabled={isGenerating || !selectedWeekIds.length}>
        {isGenerating ? <><LoaderCircle className="spin" size={18} /> {formatGenerationProgress(generationProgress)}</> : <><Sparkles size={18} /> Generate flashcards <ArrowRight size={17} /></>}
      </button>
      {isGenerating && <p className="generation-timing" role="status">Larger decks can take a few minutes — this stays open while it works.</p>}
      <p className="source-helper"><BookOpen size={14} /> Grounded in the indexed class notes for the selected week{selectedWeekIds.length > 1 ? 's' : ''}.</p>
    </section>
  );
}

function EmptyDeck() {
  return (
    <div className="empty-deck">
      <div className="empty-card-stack" aria-hidden="true">
        <span /><span /><span><Sparkles size={28} /></span>
      </div>
      <p className="eyebrow gold">Your study deck</p>
      <h2>Ready when you are.</h2>
      <p>Choose the class material on the left, then generate a deck. Tap any card to turn it over and reveal the answer.</p>
    </div>
  );
}

function Flashcard({ card, flipped, onFlip }) {
  const CategoryIcon = CATEGORY_ICONS[card.category] || CircleHelp;
  return (
    <button className={`study-card ${flipped ? 'is-flipped' : ''}`} type="button" onClick={onFlip} aria-label={`${flipped ? 'Answer' : 'Front'} of flashcard ${card.number}. Click to show ${flipped ? 'the front' : 'the answer'}.`}>
      <span className="study-card-inner">
        <span className="study-card-face study-card-front">
          <span className="card-face-top"><span className="card-category"><CategoryIcon size={15} /> {card.category}</span><span>{String(card.number).padStart(2, '0')}</span></span>
          <span className="card-prompt">{card.front}</span>
          <span className="flip-hint"><RefreshCw size={14} /> Tap to reveal the answer</span>
        </span>
        <span className="study-card-face study-card-back">
          <span className="card-face-top"><span className="card-category answer"><Sparkles size={15} /> Answer</span><span>{String(card.number).padStart(2, '0')}</span></span>
          <span className="card-answer">{card.answer}</span>
          {card.detail && <span className="card-detail">{card.detail}</span>}
          <span className="flip-hint"><RefreshCw size={14} /> Tap to see the front</span>
        </span>
      </span>
    </button>
  );
}

function DeckViewer({ cards, contextLabel, onRegenerate, isGenerating, onSave, saveState }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [deck, setDeck] = useState(cards);
  const [isEditing, setIsEditing] = useState(false);
  const [draftAnswer, setDraftAnswer] = useState('');
  const answerEditorRef = useRef(null);

  useEffect(() => {
    setDeck(cards);
    setActiveIndex(0);
    setFlipped(false);
    setIsEditing(false);
  }, [cards]);

  useEffect(() => {
    if (isEditing) answerEditorRef.current?.focus();
  }, [isEditing]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return;
      if (event.key === 'ArrowLeft') {
        setActiveIndex((current) => Math.max(current - 1, 0));
        setFlipped(false);
      }
      if (event.key === 'ArrowRight') {
        setActiveIndex((current) => Math.min(current + 1, deck.length - 1));
        setFlipped(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deck.length]);

  if (!deck.length) return <section className="deck-panel"><EmptyDeck /></section>;

  const activeCard = deck[activeIndex];
  const goTo = (index) => {
    setActiveIndex(index);
    setFlipped(false);
    setIsEditing(false);
  };
  const shuffleDeck = () => {
    setDeck((current) => [...current].sort(() => Math.random() - 0.5));
    setActiveIndex(0);
    setFlipped(false);
    setIsEditing(false);
  };
  const beginEditing = () => {
    setDraftAnswer(activeCard.answer);
    setFlipped(true);
    setIsEditing(true);
  };
  const saveAnswer = () => {
    const nextAnswer = draftAnswer.trim();
    if (!nextAnswer) return;
    setDeck((current) => current.map((card, index) => index === activeIndex
      ? { ...card, answer: nextAnswer, edited: nextAnswer !== card.originalAnswer }
      : card));
    setIsEditing(false);
    setFlipped(true);
  };
  const restoreSourceAnswer = () => {
    setDraftAnswer(activeCard.originalAnswer);
  };

  return (
    <section className="deck-panel generated" aria-labelledby="deck-title">
      <div className="deck-header">
        <div>
          <p className="eyebrow gold">Study deck</p>
          <h2 id="deck-title">{contextLabel}</h2>
        </div>
        <span className="deck-count"><b>{deck.length}</b> cards</span>
      </div>

      <div className="deck-toolbar">
        <span>Card {activeIndex + 1} of {deck.length}</span>
        <div>
          <button type="button" onClick={shuffleDeck}><Shuffle size={15} /> Shuffle</button>
          {onRegenerate && <button type="button" onClick={onRegenerate} disabled={isGenerating}><RotateCcw size={15} /> Regenerate</button>}
          {onSave && (
            <button type="button" onClick={onSave} disabled={saveState === 'saving' || saveState === 'saved'}>
              {saveState === 'saving' ? <><LoaderCircle className="spin" size={15} /> Saving...</> : saveState === 'saved' ? <><Check size={15} /> Saved</> : <><Save size={15} /> Save this set</>}
            </button>
          )}
        </div>
      </div>

      <div className="study-stage">
        <Flashcard card={activeCard} flipped={flipped} onFlip={() => setFlipped((current) => !current)} />
      </div>

      <div className="answer-actions">
        <div>
          {activeCard.edited && <span className="edited-answer-badge"><PencilLine size={13} /> Edited for this study set</span>}
        </div>
        <button type="button" onClick={beginEditing}><PencilLine size={15} /> Edit answer</button>
      </div>

      {isEditing && (
        <div className="answer-editor">
          <label htmlFor={`answer-editor-${activeCard.id}`}>Change this flashcard answer</label>
          <textarea
            id={`answer-editor-${activeCard.id}`}
            ref={answerEditorRef}
            rows="4"
            value={draftAnswer}
            onChange={(event) => setDraftAnswer(event.target.value)}
          />
          <div className="answer-editor-footer">
            <p>Your edit stays in this study set. The original source is kept below for reference.</p>
            <div>
              {activeCard.edited && <button className="restore-answer" type="button" onClick={restoreSourceAnswer}><RotateCcw size={14} /> Restore source answer</button>}
              <button className="cancel-answer" type="button" onClick={() => setIsEditing(false)}>Cancel</button>
              <button className="save-answer" type="button" onClick={saveAnswer} disabled={!draftAnswer.trim()}><Save size={14} /> Save answer</button>
            </div>
          </div>
        </div>
      )}

      {flipped && !isEditing && <SourceReading sourceExcerpt={activeCard.sourceExcerpt} edited={activeCard.edited} />}

      <div className="deck-navigation">
        <button type="button" onClick={() => goTo(activeIndex - 1)} disabled={activeIndex === 0} aria-label="Previous flashcard"><ArrowLeft size={19} /></button>
        <div className="progress-track" aria-label={`${activeIndex + 1} of ${deck.length} flashcards`}>
          <span style={{ width: `${((activeIndex + 1) / deck.length) * 100}%` }} />
        </div>
        <button type="button" onClick={() => goTo(activeIndex + 1)} disabled={activeIndex === deck.length - 1} aria-label="Next flashcard"><ArrowRight size={19} /></button>
      </div>

      <div className="card-strip" aria-label="Jump to a flashcard">
        {deck.map((card, index) => (
          <button type="button" className={index === activeIndex ? 'active' : ''} aria-label={`Open card ${index + 1}`} aria-current={index === activeIndex ? 'true' : undefined} onClick={() => goTo(index)} key={`${card.id}-${index}`}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <small>{card.category}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function FlashcardSetsPanel({ sets, isLoading, error, onOpenSet }) {
  if (isLoading) return <div className="empty-deck"><p className="eyebrow gold">Your flashcards</p><h2>Loading your saved sets...</h2></div>;
  if (error) return <div className="empty-deck"><p className="eyebrow gold">Your flashcards</p><h2>Couldn't load your sets</h2><p>{error}</p></div>;
  if (!sets.length) return <div className="empty-deck"><p className="eyebrow gold">Your flashcards</p><h2>No saved sets yet</h2><p>Generate a deck and tap "Save this set" to see it here.</p></div>;

  return (
    <div className="flashcard-sets-list">
      <p className="eyebrow gold">Your flashcards</p>
      <h2>{sets.length} saved {sets.length === 1 ? 'set' : 'sets'}</h2>
      <div className="missed-list">
        {sets.map((set) => (
          <button className="missed-item history-item" type="button" onClick={() => onOpenSet(set)} key={set.id}>
            <span className="missed-status review"><Layers3 size={14} /></span>
            <div>
              <strong>{set.label}</strong>
              <p>{new Date(set.createdAt).toLocaleString()}</p>
            </div>
            <span className="missed-label">{set.cards.length} cards</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function FlashcardsApp({ mode = 'flashcards', onModeChange = () => {}, regNo, onLogout }) {
  const [catalog, setCatalog] = useState(FALLBACK_CATALOG);
  const [coverageMode, setCoverageMode] = useState('single');
  const [selectedWeekIds, setSelectedWeekIds] = useState(['week-1']);
  const [selectedTopics, setSelectedTopics] = useState([]);
  const [cardCount, setCardCount] = useState('25');
  const [cards, setCards] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(null);
  const [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState('idle');
  const [view, setView] = useState('generate');
  const [sets, setSets] = useState([]);
  const [setsLoading, setSetsLoading] = useState(false);
  const [setsError, setSetsError] = useState('');
  const [selectedSet, setSelectedSet] = useState(null);

  useEffect(() => {
    fetch('/course-catalog.json')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Catalog unavailable')))
      .then(setCatalog)
      .catch(() => setCatalog(FALLBACK_CATALOG));
  }, []);

  const selectedWeeks = useMemo(() => catalog.weeks.filter((week) => selectedWeekIds.includes(week.id)), [catalog.weeks, selectedWeekIds]);
  const weekLabel = selectedWeeks.length > 1 ? selectedWeeks.map((week) => week.label).join(' + ') : selectedWeeks[0]?.label || 'Selected week';
  const weekDisplayLabel = selectedWeeks.length > 1
    ? selectedWeeks.map((week) => getWeekDisplayLabel(week)).join(' + ')
    : getWeekDisplayLabel(selectedWeeks[0]) || 'Selected week';
  const contextLabel = `${weekDisplayLabel} · ${selectedTopics.length ? (selectedTopics.length === 1 ? selectedTopics[0] : `${selectedTopics.length} topics`) : 'all topics'}`;

  const reset = () => {
    setView('generate');
    setCoverageMode('single');
    setSelectedWeekIds(['week-1']);
    setSelectedTopics([]);
    setCardCount('25');
    setCards([]);
    setNotice('');
    setSaveState('idle');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const generate = async () => {
    if (!selectedWeeks.length) return;
    setIsGenerating(true);
    setNotice('');
    setSaveState('idle');
    setGenerationProgress(null);
    try {
      const result = await generateWithProgress({
        weekIds: selectedWeekIds,
        topics: selectedTopics,
        questionCount: Number(cardCount),
        difficulty: 'mixed'
      }, {
        onProgress: setGenerationProgress,
        signal: AbortSignal.timeout(600_000)
      });
      const deck = normalizeCards(result);
      if (!deck.length) throw new Error('The API returned no flashcards.');
      setCards(deck);
      setNotice(`Generated ${deck.length} grounded flashcards for ${contextLabel}.`);
    } catch (error) {
      const message = error?.name === 'TimeoutError' ? 'This request took too long and timed out.' : error instanceof Error ? error.message : 'Please try again.';
      setNotice(`Flashcard generation failed: ${message}${cards.length ? ' Your previous deck has been preserved.' : ''}`);
    } finally {
      setIsGenerating(false);
      setGenerationProgress(null);
    }
  };

  const saveCurrentSet = async () => {
    if (!cards.length) return;
    setSaveState('saving');
    try {
      const response = await fetch(SETS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: contextLabel,
          weekIds: selectedWeekIds,
          topics: selectedTopics,
          cards: cards.map((card) => ({
            front: card.front,
            answer: card.answer,
            detail: card.detail,
            category: card.category,
            sourceExcerpt: card.sourceExcerpt
          }))
        })
      });
      if (!response.ok) throw new Error();
      setSaveState('saved');
    } catch {
      setSaveState('error');
      setNotice('This set could not be saved. Please try again.');
    }
  };

  const loadSets = async () => {
    setView('sets');
    setSelectedSet(null);
    setSetsLoading(true);
    setSetsError('');
    try {
      const response = await fetch(SETS_API_URL);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Sets service returned ${response.status}.`);
      const sorted = [...(payload.sets || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setSets(sorted);
    } catch (error) {
      setSetsError(error instanceof Error ? error.message : 'Could not load your flashcard sets.');
    } finally {
      setSetsLoading(false);
    }
  };

  return (
    <div className="app-shell flashcard-app">
      <SelfStudyHeader
        mode={mode}
        onModeChange={onModeChange}
        onReset={reset}
        resetLabel="New set"
        howHref="#how-flashcards-work"
        statusText="Class notes ready"
        regNo={regNo}
        onLogout={onLogout}
      />
      <main id="flashcard-studio" className="flashcard-main">
        <section className="flashcard-intro">
          <div>
            <div className="eyebrow-pill"><span className="status-dot" /> Bhagavatam class tool</div>
            <h1>Choose a lesson.<br /><em>Turn it over.</em></h1>
          </div>
          <p>Build a focused deck from one week or several. Every card stays grounded in the class notes, with the answer waiting on the other side.</p>
        </section>

        <nav className="workspace-nav" aria-label="Flashcard sections">
          <button type="button" className={view === 'generate' ? 'active' : ''} onClick={() => setView('generate')}><Sparkles size={14} /> Generate</button>
          <button type="button" className={view === 'sets' ? 'active' : ''} onClick={loadSets}><Layers3 size={14} /> My Flashcards</button>
        </nav>

        {view === 'generate' ? (
          <section className="flashcard-workspace" aria-label="Flashcard generator">
            <WeekAndTopicForm
              weeks={catalog.weeks}
              coverageMode={coverageMode}
              setCoverageMode={setCoverageMode}
              selectedWeekIds={selectedWeekIds}
              setSelectedWeekIds={setSelectedWeekIds}
              selectedTopics={selectedTopics}
              setSelectedTopics={setSelectedTopics}
              cardCount={cardCount}
              setCardCount={setCardCount}
              onGenerate={generate}
              isGenerating={isGenerating}
              generationProgress={generationProgress}
            />
            <DeckViewer cards={cards} contextLabel={contextLabel} onRegenerate={generate} isGenerating={isGenerating} onSave={cards.length ? saveCurrentSet : undefined} saveState={saveState} />
          </section>
        ) : selectedSet ? (
          <section className="flashcard-workspace flashcard-workspace-single" aria-label="Saved flashcard set">
            <button className="secondary-button retake-button" type="button" onClick={() => setSelectedSet(null)}><ArrowLeft size={16} /> Back to my flashcards</button>
            <DeckViewer
              cards={selectedSet.cards.map((card, index) => ({ id: `${selectedSet.id}-${index}`, number: index + 1, category: card.category, front: card.front, answer: card.answer, originalAnswer: card.answer, detail: card.detail, sourceExcerpt: card.sourceExcerpt, edited: false }))}
              contextLabel={selectedSet.label}
            />
          </section>
        ) : (
          <section className="flashcard-workspace flashcard-workspace-single" aria-label="Saved flashcard sets">
            <FlashcardSetsPanel sets={sets} isLoading={setsLoading} error={setsError} onOpenSet={setSelectedSet} />
          </section>
        )}

        {notice && <div className={`notice flashcard-notice ${notice.includes('failed') ? 'error' : ''}`} role="status"><span className="notice-mark">{notice.includes('failed') ? <CircleHelp size={15} /> : <Check size={15} />}</span>{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={16} /></button></div>}

        <section id="how-flashcards-work" className="flashcard-how">
          <div><p className="eyebrow gold">A simple study rhythm</p><h2>Pick. Flip. Remember.</h2></div>
          <ol>
            <li><span>01</span><strong>Choose the weeks</strong><p>Study one class or combine several weeks into a single deck.</p></li>
            <li><span>02</span><strong>Select the topics</strong><p>Keep everything in scope or choose the exact ideas you want to revisit.</p></li>
            <li><span>03</span><strong>Turn the cards</strong><p>Recall first, then tap to reveal the answer and supporting detail.</p></li>
          </ol>
        </section>
      </main>
      <footer className="site-footer flashcard-footer"><div className="footer-inner"><div><Logo /><p>One place for thoughtful Bhagavatam review.</p></div><div className="footer-right"><span>Flashcard mode</span></div></div></footer>
    </div>
  );
}

export { SAMPLE_CARDS, normalizeCards };
