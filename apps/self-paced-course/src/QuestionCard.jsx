import { CheckCircle2, XCircle } from 'lucide-react';

/**
 * One quiz question. In answering mode it's a single-choice radio group
 * (the generator only produces single-answer questions); `selected` is still
 * an array so grading stays set-based. In review mode (`review` provided) the
 * inputs are disabled and each choice is marked correct/wrong.
 */
export default function QuestionCard({ index, question, selected = [], onToggle, disabled, review }) {
  const choose = (choice) => {
    if (disabled) return;
    onToggle([choice]);
  };

  return (
    <article className="card qcard">
      <div className="qtop">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span>{question.type === 'TRUE_FALSE' ? 'True / False' : 'Multiple choice'}</span>
      </div>
      <h3>{question.question}</h3>
      {question.choices.map((choice) => {
        const isSelected = selected.includes(choice);
        let cls = 'choice';
        if (review) {
          if (review.correctChoices?.includes(choice)) cls += ' correct';
          else if (isSelected) cls += ' wrong';
        } else if (isSelected) {
          cls += ' selected';
        }
        return (
          <label className={cls} key={choice}>
            <input
              type="radio"
              name={`q-${question.id}`}
              checked={isSelected}
              disabled={disabled}
              onChange={() => choose(choice)}
            />
            <span>{choice}</span>
          </label>
        );
      })}
      {review && (
        <div className={`feedback ${review.correct ? 'correct' : 'missed'}`}>
          {review.correct ? <CheckCircle2 size={15} /> : <XCircle size={15} />}{' '}
          {review.correct ? 'Correct' : `Correct answer: ${(review.correctChoices || []).join(', ')}`}
          {review.explanation && <span className="exp">{review.explanation}</span>}
        </div>
      )}
    </article>
  );
}
