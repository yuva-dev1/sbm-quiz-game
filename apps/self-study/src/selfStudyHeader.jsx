import { BookOpen, LogOut, Layers3, RotateCcw } from 'lucide-react';
import { OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';

export default function SelfStudyHeader({
  mode,
  onModeChange,
  onReset,
  resetLabel,
  howHref,
  statusText,
  regNo,
  onLogout
}) {
  const chooseMode = (nextMode) => {
    onModeChange(nextMode);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <header className="site-header self-study-header">
      <div className="header-inner">
        <a className="brand" href="#top" aria-label="Bhagavatam Self Study home">
          <span className="brand-logo-art header-brand-logo" aria-hidden="true"><img src={OFFICIAL_GOD_LOGO_URL} alt="" /></span>
          <span className="brand-copy">
            <strong>Bhagavatam Self Study</strong>
            <em>Atlanta Namadwaar · Class Tools</em>
          </span>
        </a>

        <div className="study-mode-switch" role="group" aria-label="Choose a study mode">
          <button
            type="button"
            aria-pressed={mode === 'quiz'}
            className={mode === 'quiz' ? 'active' : ''}
            onClick={() => chooseMode('quiz')}
          >
            <BookOpen size={16} />
            Quiz
          </button>
          <button
            type="button"
            aria-pressed={mode === 'flashcards'}
            className={mode === 'flashcards' ? 'active' : ''}
            onClick={() => chooseMode('flashcards')}
          >
            <Layers3 size={16} />
            Flashcards
          </button>
        </div>

        <div className="header-utility">
          <span className="api-pill"><span className="status-dot" /> {statusText}</span>
          <a className="how-link" href={howHref}>How it works</a>
          <button className="reset-link" type="button" onClick={onReset} aria-label={resetLabel}>
            <RotateCcw size={14} /> <span>{resetLabel}</span>
          </button>
          {regNo && (
            <button className="reset-link" type="button" onClick={onLogout} aria-label="Log out">
              <LogOut size={14} /> <span>{regNo}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
