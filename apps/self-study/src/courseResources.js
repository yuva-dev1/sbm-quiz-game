export const COURSE_MATERIALS_URL = 'https://www.srimadbhagavatamcourse.org/englishcourse';

// Short, hand-picked names for each class week so students can recognize a
// week by what it covers instead of only a number.
export const WEEK_NAMES = {
  'week-1': 'Sanatana Dharma & the Shastras',
  'week-2': 'The Glory of the Bhagavatam',
  'week-3': 'Four Stories of the Mahatmyam',
  'week-4': 'Atmadeva and the Lineage',
  'week-5': 'Canto One Begins',
  'week-6': "Narada's Counsel & Vyasa's Composition",
  'week-7': "Parikshit's Birth & Dharma Restored"
};

export function getWeekName(weekId) {
  return WEEK_NAMES[weekId] || '';
}

// "Week 1 · Sanatana Dharma & the Shastras" — for on-page UI only.
export function getWeekDisplayLabel(week) {
  if (!week) return '';
  const name = WEEK_NAMES[week.id];
  return name ? `${week.label} · ${name}` : week.label;
}
