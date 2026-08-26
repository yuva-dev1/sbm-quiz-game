import { BookOpen, ExternalLink } from 'lucide-react';
import { COURSE_MATERIALS_URL } from './courseResources.js';

/** sourceExcerpt is a short quote the generator says it drew the question from — see
 * GeneratedQuestion.sourceExcerpt in srimad-bhagavatham-quiz-game's localQuizGenerator.ts. */
export default function SourceReading({ sourceExcerpt, edited = false, compact = false }) {
  if (!sourceExcerpt) return null;

  return (
    <aside className={`source-reading ${compact ? 'compact' : ''}`} aria-label="Answer source">
      <div className="source-reading-heading">
        <span><BookOpen size={16} /></span>
        <div>
          <strong>{edited ? 'Original source context' : 'Where this answer comes from'}</strong>
          <p>{edited ? 'The answer was changed for this study set. The excerpt below supports the originally generated answer.' : 'Quoted from the class notes this question was generated from.'}</p>
        </div>
      </div>
      <div className="source-reading-list">
        <div className="source-reading-item">
          <blockquote>&ldquo;{sourceExcerpt}&rdquo;</blockquote>
        </div>
      </div>
      <a className="course-materials-link" href={COURSE_MATERIALS_URL} target="_blank" rel="noreferrer">
        Browse all English course material <ExternalLink size={13} />
      </a>
    </aside>
  );
}
