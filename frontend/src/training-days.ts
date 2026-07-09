/**
 * The training plan. `exerciseGroups` preserves the order the exercises are
 * performed in: groups run top to bottom, and exercises within a group do too.
 * A group is one block of the workout (e.g. the chest presses, then triceps).
 */
export type TrainingDay = {
  slug: string
  day: string
  focus: string
  exerciseGroups: string[][]
}

export const TRAINING_DAYS: TrainingDay[] = [
  {
    slug: 'monday',
    day: 'Monday',
    focus: 'Грудь и трицепс',
    exerciseGroups: [
      [
        'Жим штанги лежа',
        'Жим гантелями сидя',
        'Жим в тренажере',
        'Брусья',
        'Сведения на тренажере',
      ],
      [
        'Разгибание рук с верхнего блока',
        'Французский жим с гантелей',
        'Разгибание каждой руки с верхнего блока',
      ],
      [
        'Тренажер на основной пресс',
        'Наклоны с гантелями на боковой пресс',
        'Сгибание с верхнего блока на основной пресс',
        'Тренажер на боковой пресс',
        'Поднятие ног на стойке',
      ],
    ],
  },
  {
    slug: 'wednesday',
    day: 'Wednesday',
    focus: 'Спина и бицепс',
    exerciseGroups: [],
  },
  {
    slug: 'friday',
    day: 'Friday',
    focus: 'Ноги и плечи',
    exerciseGroups: [],
  },
]

export function findTrainingDay(slug: string | undefined): TrainingDay | undefined {
  if (!slug) return undefined
  return TRAINING_DAYS.find((entry) => entry.slug === slug)
}
