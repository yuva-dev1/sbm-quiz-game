import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CircleX,
  ClipboardCheck,
  History,
  Layers3,
  LoaderCircle,
  PencilLine,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  X
} from 'lucide-react';
import './styles.css';
import './auth.css';
import FlashcardsApp from './flashcards.jsx';
import SelfStudyHeader from './selfStudyHeader.jsx';
import SourceReading from './SourceReading.jsx';
import AuthGate from './auth.jsx';
import { OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';
import { getWeekDisplayLabel, getWeekName } from './courseResources.js';
import { generateWithProgress } from './generateClient.js';

const API_URL = '/api/quiz/generate';
const ATTEMPTS_API_URL = '/api/quiz/attempts';
const ALL_TOPICS = '__all_topics__';
const DIFFICULTY_MAP = { Mixed: 'mixed', Foundations: 'beginner', Discussion: 'intermediate', Challenge: 'advanced' };
const FALLBACK_CATALOG = {
  weeks: [
    { id: 'week-1', label: 'Week 1', topics: ['Sanatana Dharma', 'Dharma', 'Vedas', 'Upanishads', 'Itihasas', 'Puranas', 'The Great Vedas', 'The Puranas'] },
    { id: 'week-2', label: 'Week 2', topics: ['Prasthana Traya', 'Upanishads', 'Srimad Bhagavad Gita', 'Brahma Sutras', 'Srimad Bhagavatam as the essence of all three pillars', 'Srimad Bhagavatam Mahatmyam'] },
    { id: 'week-3', label: 'Week 3', topics: ['Dharma', 'Tattva', 'Rasa', 'Essence of all Shastras by Canto', 'Four Major Puranas', 'Four Episodes of Its Greatness', 'Parikshit and the Nectar', 'Narada and Bhakti Devi', 'Atmadeva'] },
    { id: 'week-4', label: 'Week 4', topics: ['Purana', 'Mahatmyam', 'Structure of Srimad Bhagavatam', 'Lineage of Transmission', 'Speakers and Listeners', 'The Story of Atmadeva', 'Srimad Bhagavatam Mahatmyam'] },
    { id: 'week-5', label: 'Week 5', topics: ['Three Types of Samhitas', 'Meaning and Characteristics of a Purana', 'Srimad Bhagavatam as a Mahapurana', 'Ten Lakshanas of Srimad Bhagavatam', 'Ashraya as the Main Subject', 'Cantos and Lakshanas', 'Canto 1 - Speakers and Listeners', 'Outline and Highlights of Canto 1', 'Six Questions of Shaunaka Rishis'] },
    { id: 'week-6', label: 'Week 6', topics: ['Suta Pauranika on True Dharma and Devotion', "Shaunaka Rishi's Four Further Questions", "Sage Vyasa's Birth and Restlessness", "Sage Narada's Arrival and Advice to Vyasa", "Sage Vyasa's Samadhi Vision and Composing Srimad Bhagavatam"] },
    { id: 'week-7', label: 'Week 7', topics: ["Ashwatthama's Revenge and Arjuna Sparing His Life", "Kunti's Stuti After Krishna Protects the Unborn Parikshith", "Bhishmacharya's Final Teachings and Bhishma Stuti", "Parikshith's Birth, Horoscope, and Naming", 'The Four Legs of Dharma: Tapas, Shaucham, Daya, Satyam'] }
  ]
};

function normalizeGeneratedQuestions(result, difficulty) {
  const questions = Array.isArray(result?.questions) ? result.questions : [];
  return questions.map((question, index) => ({
    id: question.id || `question-${index + 1}`,
    number: String(index + 1).padStart(2, '0'),
    type: question.type === 'multiple_choice' ? 'Multiple choice' : 'True / false',
    difficulty,
    question: question.question,
    options: question.choices || ['True', 'False'],
    answer: question.answer,
    explanation: question.explanation || '',
    sourceExcerpt: question.sourceExcerpt || null
  }));
}

function normalizeAnswer(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

function answersMatch(question, response) {
  const expected = normalizeAnswer(question.answer);
  const actual = normalizeAnswer(response);
  if (!actual || !expected) return false;
  if (actual === expected) return true;

  const expectedIndex = question.options.findIndex((option) => normalizeAnswer(option) === expected);
  const actualIndex = question.options.findIndex((option) => normalizeAnswer(option) === actual);
  return expectedIndex >= 0 && expectedIndex === actualIndex;
}

function gradeQuiz(questions, responses) {
  const results = questions.map((question) => {
    const response = responses[question.number] || '';
    const correct = answersMatch(question, response);
    return { question, response, correct };
  });
  const correctCount = results.filter((result) => result.correct).length;
  const reviewResults = results.filter((result) => !result.correct);

  return {
    results,
    correctCount,
    scoredCount: results.length,
    missedCount: results.length - correctCount,
    reviewResults,
    percentage: results.length ? Math.round((correctCount / results.length) * 100) : null
  };
}

const demoQuestions = [
  {
    number: '01',
    type: 'Multiple choice',
    difficulty: 'Recall',
    question: 'What is the central quality that Prahlada demonstrates even in the face of danger?',
    options: ['Fearlessness born from devotion', 'Desire for royal power', 'Attachment to comfort', 'The wish to defeat his father'],
    answer: 'Fearlessness born from devotion'
  },
  {
    number: '02',
    type: 'Multiple choice',
    difficulty: 'Connect',
    question: "What does Prahlada's response show about lived devotion?",
    options: ['Devotion is lived through steady remembrance', 'Devotion is only external ritual', 'Knowledge replaces character', 'Power resolves every conflict'],
    answer: 'Devotion is lived through steady remembrance'
  },
  {
    number: '03',
    type: 'Multiple choice',
    difficulty: 'Reflect',
    question: 'Which idea best captures the class takeaway from this section?',
    options: ['Bhakti is steady remembrance, not only an external ritual', 'Power always resolves a conflict', 'Learning is separate from character', 'Questions should be avoided'],
    answer: 'Bhakti is steady remembrance, not only an external ritual'
  },
  {
    number: '04',
    type: 'Multiple choice',
    difficulty: 'Connect',
    question: "What makes Prahlada's devotion especially meaningful in the story?",
    options: ['It remains steady even when his surroundings oppose it', 'It gives him a way to avoid learning', 'It depends on everyone agreeing with him', 'It is limited to one difficult moment'],
    answer: 'It remains steady even when his surroundings oppose it'
  },
  {
    number: '05',
    type: 'True / false',
    difficulty: 'Reflect',
    question: "Prahlada's steady devotion can inspire a student's week.",
    options: ['True', 'False'],
    answer: 'True'
  }
];

function IconButton({ label, children, onClick, className = '' }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function StepRail({ activeStep }) {
  return (
    <div className="step-rail" aria-label={`Step ${activeStep} of 3`}>
      <span className={activeStep >= 1 ? 'step active' : 'step'}>1</span>
      <span className="step-line" />
      <span className={activeStep >= 2 ? 'step active' : 'step'}>2</span>
      <span className="step-line" />
      <span className={activeStep >= 3 ? 'step active' : 'step'}>3</span>
    </div>
  );
}

// Matches the host app's own progressLabel() in GenerateQuizForm.tsx — the
// "completed of total" count only ever climbs steadily during the initial
// draft pass. Repair rounds fill, invalidate, and refill slots as duplicates
// turn up (see localQuizGenerator.ts's generateQuiz), so showing that same
// number during "repairing" looks like it's stuck in a loop even though it's
// real, bounded work; a static message during that phase reads as calm
// instead of broken, same as the host UI already does.
function formatGenerationProgress(progress) {
  if (!progress) return 'Starting...';
  if (progress.phase === 'draft') return `Drafting ${progress.completed} of ${progress.total}...`;
  if (progress.phase === 'repairing') return 'Fixing up a few questions...';
  return 'Double-checking against the source material...';
}

function QuizForm({ weeks, coverageMode, setCoverageMode, selectedWeekIds, setSelectedWeekIds, selectedTopic, setSelectedTopic, questionCount, setQuestionCount, difficulty, setDifficulty, onGenerate, isGenerating, generationProgress }) {
  const selectedWeeks = weeks.filter((week) => selectedWeekIds.includes(week.id));
  const selectedWeek = selectedWeeks[0] || weeks[0];
  const topics = [...new Set(selectedWeeks.flatMap((week) => week.topics || []))];
  const coverageLabel = selectedWeeks.length > 1 ? selectedWeeks.map((week) => week.label).join(' + ') : selectedWeek?.label || 'selected week';

  const toggleWeek = (weekId) => {
    setSelectedWeekIds((current) => {
      const next = current.includes(weekId) ? current.filter((id) => id !== weekId) : [...current, weekId];
      if (next.length === 0) return current;
      setSelectedTopic(ALL_TOPICS);
      return next;
    });
  };

  return (
    <section className="composer-card" aria-labelledby="brief-title">
      <div className="card-heading">
        <div>
          <p className="eyebrow">01 · Choose the class</p>
          <h2 id="brief-title">Which part of the journey should we revisit?</h2>
        </div>
        <div className="heading-icon"><PencilLine size={19} /></div>
      </div>

      <div className="selector-stack">
        <label className="select-field catalog-field">
          <span className="field-label">Quiz coverage</span>
          <span className="select-wrap">
            <select value={coverageMode} onChange={(event) => { setCoverageMode(event.target.value); setSelectedWeekIds(event.target.value === 'single' ? [selectedWeekIds[0] || weeks[0]?.id] : selectedWeekIds.length > 1 ? selectedWeekIds : weeks.slice(0, 2).map((week) => week.id)); setSelectedTopic(ALL_TOPICS); }}>
              <option value="single">One class week</option>
              <option value="multiple">Multiple class weeks</option>
            </select>
            <ChevronDown size={17} />
          </span>
        </label>

        {coverageMode === 'single' ? (
        <label className="select-field catalog-field">
          <span className="field-label">Class week</span>
          <span className="select-wrap">
            <select value={selectedWeekIds[0] || weeks[0]?.id} onChange={(event) => { setSelectedWeekIds([event.target.value]); setSelectedTopic(ALL_TOPICS); }}>
              {weeks.map((week) => <option key={week.id} value={week.id}>{getWeekDisplayLabel(week)}</option>)}
            </select>
            <ChevronDown size={17} />
          </span>
        </label>
        ) : (
          <div className="catalog-field">
            <span className="field-label">Choose class weeks</span>
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
        <label className="select-field catalog-field">
          <span className="field-label">Topic</span>
          <span className="select-wrap">
            <select value={selectedTopic} onChange={(event) => setSelectedTopic(event.target.value)}>
              <option value={ALL_TOPICS}>All topics in {coverageLabel}</option>
              {topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
            </select>
            <ChevronDown size={17} />
          </span>
        </label>
      </div>
      <p className="catalog-helper"><BookOpen size={14} /> These topics come from the indexed class notes and infographics.</p>

      <div className="form-divider" />
      <div className="settings-grid">
        <label className="select-field">
          <span className="field-label">Number of questions</span>
          <span className="select-wrap">
            <select value={questionCount} onChange={(event) => setQuestionCount(event.target.value)}>
              <option value="5">5 questions</option>
              <option value="8">8 questions</option>
              <option value="10">10 questions</option>
              <option value="15">15 questions</option>
            </select>
            <ChevronDown size={17} />
          </span>
        </label>
        <label className="select-field">
          <span className="field-label">Difficulty</span>
          <span className="select-wrap">
            <select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option>Mixed</option>
              <option>Foundations</option>
              <option>Discussion</option>
              <option>Challenge</option>
            </select>
            <ChevronDown size={17} />
          </span>
        </label>
      </div>

      <div className="context-summary">
        <div className="upload-icon"><Layers3 size={18} /></div>
        <div className="upload-copy">
          <strong>{selectedWeeks.length > 1 ? `${selectedWeeks.length} weeks` : getWeekDisplayLabel(selectedWeek) || 'Selected week'} context loaded</strong>
          <p>Grounded in the indexed class notes for the selected week{selectedWeeks.length > 1 ? 's' : ''}.</p>
        </div>
        <span className="context-ready"><Check size={14} /> Ready</span>
      </div>

      <button className="primary-button generate-button" type="button" onClick={onGenerate} disabled={isGenerating || selectedWeekIds.length === 0 || !selectedTopic}>
        {isGenerating ? <><LoaderCircle className="spin" size={18} /> {formatGenerationProgress(generationProgress)}</> : <><Sparkles size={18} /> Generate quiz <ArrowRight size={17} /></>}
      </button>
      {isGenerating && <p className="generation-timing" role="status">Grounded generation can take a couple of minutes — this stays open while it works.</p>}
    </section>
  );
}

function QuestionCard({ question, index }) {
  return (
    <article className="question-card" style={{ '--delay': `${index * 80}ms` }}>
      <div className="question-topline">
        <span className="question-number">{question.number}</span>
        <span className="question-type">{question.type}</span>
        <span className="difficulty-tag">{question.difficulty}</span>
      </div>
      <h3>{question.question}</h3>
      <div className="options-list">
        {question.options.map((option, optionIndex) => (
          <div className="option" key={option}>
            <span className="option-letter">{String.fromCharCode(65 + optionIndex)}</span>
            <span>{option}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function QuizAttemptCard({ question, index, response, onChange, submitted, result }) {
  const feedbackClass = result?.correct ? 'correct' : 'missed';
  const correctAnswer = question.answer;
  const explanation = question.explanation;

  return (
    <article className="question-card attempt-card" style={{ '--delay': `${index * 80}ms` }}>
      <div className="question-topline">
        <span className="question-number">{question.number}</span>
        <span className="question-type">{question.type}</span>
        <span className="difficulty-tag">{question.difficulty}</span>
      </div>
      <h3>{question.question}</h3>
      <div className="answer-options" role="radiogroup" aria-label={`Answer choices for question ${question.number}`}>
        {question.options.map((option, optionIndex) => (
          <label className={`answer-option ${response === option ? 'selected' : ''}`} key={option}>
            <input
              type="radio"
              name={`question-${question.number}`}
              value={option}
              checked={response === option}
              disabled={submitted}
              onChange={(event) => onChange(question.number, event.target.value)}
            />
            <span className="option-letter">{String.fromCharCode(65 + optionIndex)}</span>
            <span>{option}</span>
          </label>
        ))}
      </div>
      {submitted && result && (
        <div className="attempt-review">
          <div className={`attempt-feedback ${feedbackClass}`}>
            {result.correct ? <CheckCircle2 size={16} /> : <CircleX size={16} />}
            <div>
              <strong>{result.correct ? 'Correct' : 'Missed'}</strong>
              {!result.correct && correctAnswer && <span>Correct answer: {correctAnswer}</span>}
              {explanation && <span>{explanation}</span>}
            </div>
          </div>
          <SourceReading sourceExcerpt={question.sourceExcerpt} compact />
        </div>
      )}
    </article>
  );
}

function GradeReport({ grading, onRetake }) {
  return (
    <section className="grading-report" aria-labelledby="grading-title" role="status">
      <div className="grading-heading">
        <div className="grading-icon"><ClipboardCheck size={20} /></div>
        <div>
          <p className="eyebrow gold">03 · Your review</p>
          <h2 id="grading-title">See what to revisit.</h2>
        </div>
        <div className="score-badge">
          <strong>{grading.percentage === null ? 'Review' : `${grading.percentage}%`}</strong>
          <span>auto-graded</span>
        </div>
      </div>
      <div className="grading-stats">
        <span><b>{grading.correctCount}</b> correct</span>
        <span><b>{grading.missedCount}</b> missed</span>
      </div>
      <p className="grading-note">
        {`${grading.correctCount} of ${grading.scoredCount} questions were graded automatically.`}
      </p>
      <div className="missed-review">
        <h3>{grading.reviewResults.length ? 'Questions to revisit' : 'Strong work'}</h3>
        {grading.reviewResults.length ? (
          <div className="missed-list">
            {grading.reviewResults.map((result) => (
              <div className="missed-item" key={result.question.number}>
                <span className="missed-status missed"><CircleX size={14} /></span>
                <div><strong>Question {result.question.number}</strong><p>{result.question.question}</p></div>
                <span className="missed-label">Missed</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="all-correct"><CheckCircle2 size={16} /> You got every question right.</p>
        )}
      </div>
      <button className="secondary-button retake-button" type="button" onClick={onRetake}><RotateCcw size={16} /> Retake quiz</button>
    </section>
  );
}

function PreviewPanel({ questions, onGenerate, isGenerating, contextLabel, isTakingQuiz, onStartQuiz, onExitQuiz, responses, onChangeResponse, onSubmitQuiz, grading, onRetake, submitError }) {
  return (
    <section className="preview-panel" aria-labelledby="preview-title">
      <div className="preview-header">
        <div>
          <p className="eyebrow gold">02 · Review the set</p>
          <h2 id="preview-title">{isTakingQuiz ? `Answer your ${contextLabel} quiz` : `A first look at your ${contextLabel} quiz`}</h2>
        </div>
        <span className="preview-count"><span>{questions.length}</span> questions</span>
      </div>
      <div className="preview-toolbar">
        <div className="toolbar-status"><span className="status-dot" /> {isTakingQuiz ? `Quiz attempt · ${contextLabel}` : `Draft · ${contextLabel}`}</div>
        <div className="toolbar-actions">
          {!isTakingQuiz && <button className="take-quiz-button" type="button" onClick={onStartQuiz}><Play size={15} /> Take quiz</button>}
          {isTakingQuiz && <button type="button" onClick={onExitQuiz}><PencilLine size={15} /> Back to preview</button>}
        </div>
      </div>
      <div className="questions-list">
        {isTakingQuiz
          ? questions.map((question, index) => <QuizAttemptCard question={question} index={index} response={responses[question.number] || ''} onChange={onChangeResponse} submitted={Boolean(grading)} result={grading?.results.find((item) => item.question.number === question.number)} key={question.number} />)
          : questions.map((question, index) => <QuestionCard question={question} index={index} key={question.number} />)}
      </div>
      {isTakingQuiz ? (
        <div className="attempt-footer">
          <div className="attempt-actions">
            <div className="ready-copy"><span className="ready-icon"><ClipboardCheck size={16} /></span><span><strong>{grading ? 'Quiz reviewed.' : 'Ready to submit?'}</strong><small>{grading ? 'Your missed questions and answer key are marked above.' : 'Submit when you have answered every question.'}</small></span></div>
            {submitError && <p className="submit-warning" role="alert"><CircleHelp size={15} /> {submitError}</p>}
          </div>
          {!grading && <button className="primary-button submit-button" type="button" onClick={onSubmitQuiz}><ClipboardCheck size={17} /> Submit quiz <ArrowRight size={16} /></button>}
        </div>
      ) : (
        <div className="preview-footer">
          <div className="ready-copy"><span className="ready-icon"><Check size={16} /></span><span><strong>Looks like a good starting point.</strong><small>You can regenerate for a different set.</small></span></div>
          <button className="secondary-button" type="button" onClick={onGenerate} disabled={isGenerating}><RotateCcw size={16} /> Regenerate</button>
        </div>
      )}
      {isTakingQuiz && grading && <GradeReport grading={grading} onRetake={onRetake} />}
    </section>
  );
}

function Logo() {
  return (
    <a className="brand" href="#top" aria-label="Bhagavatam Self Study home">
      <span className="brand-logo-art footer-brand-logo" aria-hidden="true"><img src={OFFICIAL_GOD_LOGO_URL} alt="" /></span>
      <span className="brand-copy">
        <strong>Bhagavatam Self Study</strong>
        <em>Atlanta Namadwaar · Class Tools</em>
      </span>
    </a>
  );
}

function AttemptReviewCard({ item, index }) {
  const question = {
    number: String(index + 1).padStart(2, '0'),
    type: item.type,
    difficulty: item.difficulty || '',
    question: item.question,
    options: item.choices || [],
    sourceExcerpt: item.sourceExcerpt
  };
  const result = { correct: item.correct, correctAnswer: item.answer, explanation: item.explanation };
  return <QuizAttemptCard question={question} index={index} response={item.chosenAnswer} onChange={() => {}} submitted result={result} />;
}

function AttemptSummary({ attempt, onBack }) {
  return (
    <section className="grading-report" aria-labelledby="attempt-title">
      <div className="grading-heading">
        <div className="grading-icon"><ClipboardCheck size={20} /></div>
        <div>
          <p className="eyebrow gold">{new Date(attempt.submittedAt).toLocaleString()}</p>
          <h2 id="attempt-title">{attempt.contextLabel}</h2>
        </div>
        <div className="score-badge">
          <strong>{attempt.percentage}%</strong>
          <span>{attempt.correctCount} of {attempt.scoredCount}</span>
        </div>
      </div>
      <button className="secondary-button retake-button" type="button" onClick={onBack}><ArrowRight size={16} style={{ transform: 'rotate(180deg)' }} /> Back to history</button>
      <div className="questions-list">
        {attempt.questions.map((item, index) => <AttemptReviewCard item={item} index={index} key={item.id || index} />)}
      </div>
    </section>
  );
}

function QuizHistoryPanel({ attempts, isLoading, error, onOpenAttempt }) {
  if (isLoading) {
    return (
      <section className="preview-panel" aria-labelledby="history-title">
        <div className="preview-header"><div><p className="eyebrow gold">Your history</p><h2 id="history-title">Loading your past quizzes...</h2></div></div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="preview-panel" aria-labelledby="history-title">
        <div className="preview-header"><div><p className="eyebrow gold">Your history</p><h2 id="history-title">Couldn't load your history</h2></div></div>
        <p className="submit-warning" role="alert"><CircleHelp size={15} /> {error}</p>
      </section>
    );
  }
  if (!attempts.length) {
    return (
      <section className="preview-panel" aria-labelledby="history-title">
        <div className="preview-header"><div><p className="eyebrow gold">Your history</p><h2 id="history-title">No quizzes taken yet</h2></div></div>
        <p>Submit a quiz and it'll show up here.</p>
      </section>
    );
  }
  return (
    <section className="preview-panel" aria-labelledby="history-title">
      <div className="preview-header">
        <div><p className="eyebrow gold">Your history</p><h2 id="history-title">Quizzes you've taken</h2></div>
        <span className="preview-count"><span>{attempts.length}</span> attempts</span>
      </div>
      <div className="missed-list">
        {attempts.map((attempt) => (
          <button className="missed-item history-item" type="button" onClick={() => onOpenAttempt(attempt)} key={attempt.id}>
            <span className={`missed-status ${attempt.percentage >= 70 ? 'review' : 'missed'}`}><ClipboardCheck size={14} /></span>
            <div>
              <strong>{attempt.contextLabel}</strong>
              <p>{new Date(attempt.submittedAt).toLocaleString()}</p>
            </div>
            <span className="missed-label">{attempt.percentage}% · {attempt.correctCount}/{attempt.scoredCount}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function App({ mode = 'quiz', onModeChange = () => {}, regNo, onLogout }) {
  const [catalog, setCatalog] = useState(FALLBACK_CATALOG);
  const [coverageMode, setCoverageMode] = useState('single');
  const [selectedWeekIds, setSelectedWeekIds] = useState(['week-1']);
  const [selectedTopic, setSelectedTopic] = useState(ALL_TOPICS);
  const [questionCount, setQuestionCount] = useState('5');
  const [difficulty, setDifficulty] = useState('Mixed');
  const [questions, setQuestions] = useState(demoQuestions);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(null);
  const [isTakingQuiz, setIsTakingQuiz] = useState(false);
  const [responses, setResponses] = useState({});
  const [grading, setGrading] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState('compose');
  const [attempts, setAttempts] = useState([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [attemptsError, setAttemptsError] = useState('');
  const [selectedAttempt, setSelectedAttempt] = useState(null);

  useEffect(() => {
    fetch('/course-catalog.json')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Catalog unavailable'))))
      .then((nextCatalog) => setCatalog(nextCatalog))
      .catch(() => setCatalog(FALLBACK_CATALOG));
  }, []);

  const selectedWeeks = catalog.weeks.filter((week) => selectedWeekIds.includes(week.id));
  const activeWeek = selectedWeeks[0] || catalog.weeks[0];
  const selectedWeekLabel = selectedWeeks.length > 1 ? selectedWeeks.map((week) => week.label).join(' + ') : activeWeek?.label || 'Selected week';
  const selectedWeekDisplayLabel = selectedWeeks.length > 1
    ? selectedWeeks.map((week) => getWeekDisplayLabel(week)).join(' + ')
    : getWeekDisplayLabel(activeWeek) || 'Selected week';
  const contextLabel = `${selectedWeekDisplayLabel} · ${selectedTopic === ALL_TOPICS ? 'all topics' : selectedTopic}`;

  const reset = () => {
    setView('compose');
    setCoverageMode('single');
    setSelectedWeekIds(['week-1']);
    setSelectedTopic(ALL_TOPICS);
    setQuestions(demoQuestions);
    setIsTakingQuiz(false);
    setResponses({});
    setGrading(null);
    setSubmitError('');
    setNotice('Choose a week and topic, then generate your first set.');
  };

  const generate = async () => {
    if (!activeWeek || !selectedTopic) return;
    setIsGenerating(true);
    setNotice('');
    setGenerationProgress(null);
    const payload = {
      weekIds: selectedWeekIds,
      topics: selectedTopic === ALL_TOPICS ? [] : [selectedTopic],
      questionCount: Number(questionCount),
      difficulty: DIFFICULTY_MAP[difficulty]
    };
    try {
      const result = await generateWithProgress(payload, {
        onProgress: setGenerationProgress,
        signal: AbortSignal.timeout(600_000)
      });
      const generatedQuestions = normalizeGeneratedQuestions(result, difficulty);
      if (generatedQuestions.length === 0) throw new Error('The API returned no quiz questions.');
      setQuestions(generatedQuestions);
      setIsTakingQuiz(false);
      setResponses({});
      setGrading(null);
      setSubmitError('');
      setNotice(`Generated ${generatedQuestions.length} questions for ${contextLabel}.`);
    } catch (error) {
      const message = error?.name === 'TimeoutError'
        ? 'This request took too long and timed out.'
        : error instanceof Error ? error.message : 'Please try again.';
      setNotice(`Quiz generation failed: ${message} The previous quiz has been preserved.`);
    } finally {
      setIsGenerating(false);
      setGenerationProgress(null);
    }
  };

  const startQuiz = () => {
    setResponses({});
    setGrading(null);
    setSubmitError('');
    setNotice('');
    setIsTakingQuiz(true);
  };

  const exitQuiz = () => {
    setIsTakingQuiz(false);
    setGrading(null);
    setSubmitError('');
  };

  const updateResponse = (questionNumber, response) => {
    setResponses((current) => ({ ...current, [questionNumber]: response }));
    setSubmitError('');
  };

  const submitQuiz = async () => {
    const unansweredCount = questions.filter((question) => !String(responses[question.number] || '').trim()).length;
    if (unansweredCount > 0) {
      setSubmitError(`Please finish all questions before submitting. ${unansweredCount} ${unansweredCount === 1 ? 'question remains' : 'questions remain'}.`);
      return;
    }
    setSubmitError('');
    const result = gradeQuiz(questions, responses);
    setGrading(result);

    try {
      await fetch(ATTEMPTS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contextLabel,
          weekIds: selectedWeekIds,
          topics: selectedTopic === ALL_TOPICS ? [] : [selectedTopic],
          difficulty: DIFFICULTY_MAP[difficulty],
          correctCount: result.correctCount,
          scoredCount: result.scoredCount,
          percentage: result.percentage,
          questions: result.results.map((item) => ({
            id: item.question.id,
            type: item.question.type,
            difficulty: item.question.difficulty,
            question: item.question.question,
            choices: item.question.options,
            answer: item.question.answer,
            chosenAnswer: item.response,
            correct: item.correct,
            explanation: item.question.explanation,
            sourceExcerpt: item.question.sourceExcerpt
          }))
        })
      });
    } catch {
      // The quiz is still graded locally either way; history just won't have this attempt.
    }
  };

  const retakeQuiz = () => {
    setResponses({});
    setGrading(null);
    setSubmitError('');
    setIsTakingQuiz(true);
  };

  const loadAttempts = async () => {
    setView('history');
    setSelectedAttempt(null);
    setAttemptsLoading(true);
    setAttemptsError('');
    try {
      const response = await fetch(ATTEMPTS_API_URL);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `History service returned ${response.status}.`);
      const sorted = [...(payload.attempts || [])].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      setAttempts(sorted);
    } catch (error) {
      setAttemptsError(error instanceof Error ? error.message : 'Could not load your history.');
    } finally {
      setAttemptsLoading(false);
    }
  };

  return (
    <div className="app-shell quiz-app">
      <SelfStudyHeader
        mode={mode}
        onModeChange={onModeChange}
        onReset={reset}
        resetLabel="New quiz"
        howHref="#how-it-works"
        statusText="Class notes ready"
        regNo={regNo}
        onLogout={onLogout}
      />
      <main id="studio">
        <section className="workspace-section">
          <div className="workspace-head"><div><p className="eyebrow">The quiz desk</p><h1>Shape the session, then let the questions unfold.</h1></div>{view === 'compose' && <StepRail activeStep={isTakingQuiz ? 3 : questions.length ? 2 : 1} />}</div>
          <nav className="workspace-nav" aria-label="Quiz sections">
            <button type="button" className={view === 'compose' ? 'active' : ''} onClick={() => setView('compose')}><Sparkles size={14} /> Compose</button>
            <button type="button" className={view === 'history' ? 'active' : ''} onClick={loadAttempts}><History size={14} /> History</button>
          </nav>
          {view === 'compose' ? (
            <div className="workspace-grid">
              <QuizForm weeks={catalog.weeks} coverageMode={coverageMode} setCoverageMode={setCoverageMode} selectedWeekIds={selectedWeekIds} setSelectedWeekIds={setSelectedWeekIds} selectedTopic={selectedTopic} setSelectedTopic={setSelectedTopic} questionCount={questionCount} setQuestionCount={setQuestionCount} difficulty={difficulty} setDifficulty={setDifficulty} onGenerate={generate} isGenerating={isGenerating} generationProgress={generationProgress} />
              <PreviewPanel questions={questions} onGenerate={generate} isGenerating={isGenerating} contextLabel={contextLabel} isTakingQuiz={isTakingQuiz} onStartQuiz={startQuiz} onExitQuiz={exitQuiz} responses={responses} onChangeResponse={updateResponse} onSubmitQuiz={submitQuiz} grading={grading} onRetake={retakeQuiz} submitError={submitError} />
            </div>
          ) : selectedAttempt ? (
            <AttemptSummary attempt={selectedAttempt} onBack={() => setSelectedAttempt(null)} />
          ) : (
            <QuizHistoryPanel attempts={attempts} isLoading={attemptsLoading} error={attemptsError} onOpenAttempt={setSelectedAttempt} />
          )}
          {notice && <div className="notice" role="status"><span className="notice-mark"><Check size={15} /></span>{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={16} /></button></div>}
        </section>

        <section id="how-it-works" className="how-section"><div className="how-copy"><p className="eyebrow gold">03 · Keep the rhythm</p><h2>Designed for the five minutes before class begins.</h2><p>Choose one week or combine several, narrow to a topic, and let the backend use the matching notes as context.</p></div><div className="how-steps"><div><span>01</span><strong>Choose the weeks</strong><p>Start with one or combine Week 1 through Week 5 from the class material.</p></div><div><span>02</span><strong>Narrow the topic</strong><p>Pick one of the extracted topics or keep all topics in the selected weeks in scope.</p></div><div><span>03</span><strong>Submit and review</strong><p>Answer the quiz, submit it, and see your score plus the questions worth revisiting.</p></div></div></section>
      </main>
      <footer className="site-footer"><div className="footer-inner"><div><Logo /><p>One place for thoughtful Bhagavatam review.</p></div><div className="footer-right"><span>Quiz mode</span><span className="footer-rule" /><a href="mailto:hello@example.com">Questions or ideas? <strong>Let us know</strong> <Send size={14} /></a></div></div></footer>
    </div>
  );
}

function SelfStudyApp({ regNo, onLogout }) {
  const [mode, setMode] = useState('quiz');

  useEffect(() => {
    document.title = `Bhagavatam Self Study · ${mode === 'quiz' ? 'Quiz' : 'Flashcards'}`;
  }, [mode]);

  return (
    <div id="top" className="self-study-app">
      <div hidden={mode !== 'quiz'}>
        <App mode="quiz" onModeChange={setMode} regNo={regNo} onLogout={onLogout} />
      </div>
      <div hidden={mode !== 'flashcards'}>
        <FlashcardsApp mode="flashcards" onModeChange={setMode} regNo={regNo} onLogout={onLogout} />
      </div>
    </div>
  );
}

function SelfStudyRoot() {
  const [status, setStatus] = useState('loading'); // loading | anonymous | authenticated
  const [regNo, setRegNo] = useState('');

  useEffect(() => {
    fetch('/api/auth/session')
      .then((response) => response.json())
      .then((session) => {
        if (session.authenticated) {
          setRegNo(session.regNo);
          setStatus('authenticated');
        } else {
          setStatus('anonymous');
        }
      })
      .catch(() => setStatus('anonymous'));
  }, []);

  const onAuthenticated = (nextRegNo) => {
    setRegNo(nextRegNo);
    setStatus('authenticated');
  };

  const onLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setRegNo('');
    setStatus('anonymous');
  };

  if (status === 'loading') {
    return (
      <div className="auth-shell">
        <LoaderCircle className="spin" size={28} />
      </div>
    );
  }

  if (status === 'anonymous') {
    return <AuthGate onAuthenticated={onAuthenticated} />;
  }

  return <SelfStudyApp regNo={regNo} onLogout={onLogout} />;
}

createRoot(document.getElementById('root')).render(<SelfStudyRoot />);
