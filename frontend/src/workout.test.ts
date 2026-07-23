import { describe, expect, it } from 'vitest'
import {
  formatRelativeDay,
  formatSetWeights,
  formatShortDate,
  improvementOverLast,
  showMachineBusyButton,
  showMachineBusyButtonDuringRest,
  type HistoryWorkout,
  type WorkoutExercise,
  type WorkoutPhase,
  type WorkoutState,
} from './workout'

/**
 * The "Machine busy — do this later" rule, pinned down without a browser or a
 * database. There is exactly one rule — the current exercise has no sets on it
 * — and the point of this file is that nothing else may creep back in.
 *
 * The button has now regressed twice by acquiring extra conditions (the first
 * exercise only; not the last; not while resting). So the last test here walks
 * every combination of the state that used to matter and asserts it does not.
 */

const SETS_PER_EXERCISE = 4
const QUEUE = ['Bench Press', 'Chest Press Machine', 'Incline Press', 'Pec Deck']

/**
 * A workout sitting on `exerciseIndex`, with `completedSets[i]` sets logged
 * against each exercise. Every other field is filler: if changing one of them
 * ever changes the answer, the rule has grown a condition it should not have.
 */
function workoutState(
  completedSets: number[],
  exerciseIndex: number,
  overrides: Partial<WorkoutState> = {},
): WorkoutState {
  const exercises: WorkoutExercise[] = QUEUE.map((name, position) => ({
    position,
    name,
    exerciseLibraryId: null,
    deferred: false,
    completedSets: completedSets[position],
    aiWeightRecommendation: null,
  }))

  return {
    id: 1,
    daySlug: 'chest',
    dayName: 'Monday',
    focus: 'Chest',
    phase: 'set',
    startedAt: '2026-01-01T10:00:00.000Z',
    completedAt: null,
    elapsedSeconds: 0,
    exercises,
    exerciseIndex,
    exerciseCount: exercises.length,
    exerciseName: exercises[exerciseIndex]?.name ?? '',
    exerciseLibraryId: null,
    deferredCount: 0,
    setNumber: (completedSets[exerciseIndex] ?? 0) + 1,
    setsPerExercise: SETS_PER_EXERCISE,
    targetReps: 10,
    plannedWeight: 60,
    draftReps: null,
    restSeconds: 90,
    restRemainingSeconds: null,
    setsCompleted: completedSets.reduce((total, sets) => total + sets, 0),
    exercisesCompleted: 0,
    bodyWeightKg: null,
    ...overrides,
  }
}

describe('showMachineBusyButton', () => {
  /**
   * The sequence the feature is specified by, walked exactly as the user does:
   * start, log a set, finish the exercise, move on. The button is offered once
   * at the top of every exercise and withdrawn by that exercise's first set.
   */
  it('offers the button at the start of every exercise and withdraws it on the first set', () => {
    // Exercise 1, untouched.
    expect(showMachineBusyButton(workoutState([0, 0, 0, 0], 0))).toBe(true)

    // Its first set lands.
    expect(showMachineBusyButton(workoutState([1, 0, 0, 0], 0))).toBe(false)

    // ...and it stays hidden for every remaining set of that exercise.
    for (let sets = 2; sets <= SETS_PER_EXERCISE; sets++) {
      expect(showMachineBusyButton(workoutState([sets, 0, 0, 0], 0))).toBe(false)
    }

    // Exercise 2, untouched: the button is back.
    expect(showMachineBusyButton(workoutState([4, 0, 0, 0], 1))).toBe(true)

    // Exercise 3, untouched: back again.
    expect(showMachineBusyButton(workoutState([4, 4, 0, 0], 2))).toBe(true)

    // Exercise 4 — the last one — is not a special case.
    expect(showMachineBusyButton(workoutState([4, 4, 4, 0], 3))).toBe(true)
  })

  /**
   * The reported bug: press "machine busy" on exercise 2, do exercise 3, and
   * exercise 2 comes back — still untouched, so the button must come back with
   * it. The queue has been reordered, so the deferred exercise is now at a
   * different position than the one it was offered at the first time.
   */
  it('offers the button again when a deferred exercise comes back around', () => {
    // Bench Press is done; the cursor is on Chest Press Machine, untouched.
    expect(showMachineBusyButton(workoutState([4, 0, 0, 0], 1))).toBe(true)

    // "Machine busy": Chest Press Machine goes behind Incline Press. The queue
    // is now Bench Press, Incline Press, Chest Press Machine, Pec Deck — so
    // position 1 is Incline Press, untouched, and the button is offered.
    const afterDefer = workoutState([4, 0, 0, 0], 1, {
      exercises: [
        {
          position: 0,
          name: 'Bench Press',
          exerciseLibraryId: null,
          deferred: false,
          completedSets: 4,
          aiWeightRecommendation: null,
        },
        {
          position: 1,
          name: 'Incline Press',
          exerciseLibraryId: null,
          deferred: false,
          completedSets: 0,
          aiWeightRecommendation: null,
        },
        {
          position: 2,
          name: 'Chest Press Machine',
          exerciseLibraryId: null,
          deferred: true,
          completedSets: 0,
          aiWeightRecommendation: null,
        },
        {
          position: 3,
          name: 'Pec Deck',
          exerciseLibraryId: null,
          deferred: false,
          completedSets: 0,
          aiWeightRecommendation: null,
        },
      ],
      exerciseName: 'Incline Press',
      deferredCount: 1,
    })
    expect(showMachineBusyButton(afterDefer)).toBe(true)

    // Incline Press is finished. The cursor lands on Chest Press Machine, which
    // still has no sets on it — so the button is offered a second time.
    const deferredIsBack: WorkoutState = {
      ...afterDefer,
      exercises: afterDefer.exercises.map((exercise) =>
        exercise.name === 'Incline Press'
          ? { ...exercise, completedSets: 4 }
          : exercise,
      ),
      exerciseIndex: 2,
      exerciseName: 'Chest Press Machine',
      deferredCount: 0,
    }
    expect(showMachineBusyButton(deferredIsBack)).toBe(true)

    // And its own first set withdraws it, exactly as for any other exercise.
    const underway: WorkoutState = {
      ...deferredIsBack,
      exercises: deferredIsBack.exercises.map((exercise) =>
        exercise.name === 'Chest Press Machine'
          ? { ...exercise, completedSets: 1 }
          : exercise,
      ),
    }
    expect(showMachineBusyButton(underway)).toBe(false)
  })

  /**
   * Every condition the rule used to carry, asserted irrelevant. Only the
   * current exercise's set count decides — for each position in the queue, at
   * each phase, deferred or not, whatever else the workout reports.
   */
  it('ignores position, phase, deferral and workout-wide counts', () => {
    const phases: WorkoutPhase[] = ['set', 'rest', 'completed']

    for (let index = 0; index < QUEUE.length; index++) {
      for (const phase of phases) {
        for (const deferred of [false, true]) {
          for (const currentSets of [0, 1, SETS_PER_EXERCISE]) {
            // Every *other* exercise is finished, so a rule keyed off the
            // workout's total set count would answer differently here.
            const completedSets = QUEUE.map((_, position) =>
              position === index ? currentSets : SETS_PER_EXERCISE,
            )
            const state = workoutState(completedSets, index, {
              phase,
              deferredCount: deferred ? 1 : 0,
            })
            state.exercises[index].deferred = deferred

            expect(showMachineBusyButton(state)).toBe(currentSets === 0)
          }
        }
      }
    }
  })

  /** A completed workout indexes past the queue: no exercise, no button. */
  it('hides the button when there is no current exercise', () => {
    const finished = workoutState([4, 4, 4, 4], QUEUE.length, {
      phase: 'completed',
    })
    expect(showMachineBusyButton(finished)).toBe(false)
  })
})

/**
 * The rest that ends an exercise is the walk to the next machine — it is the
 * screen the user is on when they find it busy, one tap before the cursor
 * moves. Every workout abandoned to this bug died exactly here: four sets on
 * exercise 1, resting, no way to defer exercise 2.
 */
describe('showMachineBusyButtonDuringRest', () => {
  /** Rest during a workout keeps the cursor on the exercise just finished. */
  function resting(
    completedSets: number[],
    exerciseIndex: number,
    setNumber: number,
  ): WorkoutState {
    return workoutState(completedSets, exerciseIndex, {
      phase: 'rest',
      setNumber,
      restRemainingSeconds: 45,
    })
  }

  /** The reported scenario, at the screen it was reported from. */
  it('offers the button on the rest that ends an exercise', () => {
    expect(showMachineBusyButtonDuringRest(resting([4, 0, 0, 0], 0, 4))).toBe(
      true,
    )
    expect(showMachineBusyButtonDuringRest(resting([4, 4, 0, 0], 1, 4))).toBe(
      true,
    )
  })

  /** A rest between two sets leads back to the machine already in use. */
  it('withholds it on a rest between two sets of one exercise', () => {
    for (let setNumber = 1; setNumber < SETS_PER_EXERCISE; setNumber++) {
      expect(
        showMachineBusyButtonDuringRest(resting([setNumber, 0, 0, 0], 0, setNumber)),
      ).toBe(false)
    }
  })

  /** The one true special case: nothing behind the last exercise to swap with. */
  it('withholds it when the rest leads into the last exercise', () => {
    expect(showMachineBusyButtonDuringRest(resting([4, 4, 4, 0], 2, 4))).toBe(
      false,
    )
  })

  /** The same one rule: an exercise with sets on it is underway. */
  it('withholds it when the exercise coming up is already underway', () => {
    expect(showMachineBusyButtonDuringRest(resting([4, 2, 0, 0], 0, 4))).toBe(
      false,
    )
  })
})

/**
 * The Previous Performance panel's one judgement call: whether today's numbers
 * beat last time's. Everything else it renders is a fact from the server.
 *
 * The rule is deliberately conservative — a trade is not an improvement — so
 * these cases pin down what does *not* count as one just as much as what does.
 */
function lastWorkout(sets: Array<[number, number]>): HistoryWorkout {
  return {
    workoutId: 1,
    completedAt: '2026-07-07T18:00:00.000Z',
    sets: sets.map(([weight, reps], index) => ({
      setNumber: index + 1,
      weight,
      reps,
    })),
  }
}

describe('improvementOverLast', () => {
  const last = lastWorkout([
    [75, 12],
    [70, 10],
  ])

  it('reports heavier at the same reps', () => {
    expect(improvementOverLast(last, 1, 77.5, 12)).toBe('weight')
  })

  it('reports more reps at the same weight', () => {
    expect(improvementOverLast(last, 1, 75, 13)).toBe('reps')
  })

  it('reports both when heavier and for more reps', () => {
    expect(improvementOverLast(last, 1, 77.5, 13)).toBe('both')
  })

  /** Set 2 was 70 × 10, set 1 was 75 × 12. The same numbers are a win against
   *  one row and nothing against the other — reading the wrong row is the bug
   *  this catches. */
  it('compares against the matching set, not the first one', () => {
    expect(improvementOverLast(last, 2, 72.5, 10)).toBe('weight')
    expect(improvementOverLast(last, 1, 72.5, 10)).toBe('none')
  })

  it('stays quiet when the set matches last time exactly', () => {
    expect(improvementOverLast(last, 1, 75, 12)).toBe('none')
  })

  /** A trade, not a win: the panel does not claim a personal best either way. */
  it('stays quiet on heavier for fewer reps, and on lighter for more', () => {
    expect(improvementOverLast(last, 1, 80, 8)).toBe('none')
    expect(improvementOverLast(last, 1, 70, 15)).toBe('none')
  })

  it('stays quiet with no history, no matching set, or nothing typed', () => {
    expect(improvementOverLast(null, 1, 100, 20)).toBe('none')
    expect(improvementOverLast(last, 3, 100, 20)).toBe('none')
    expect(improvementOverLast(last, 1, null, 12)).toBe('none')
    expect(improvementOverLast(last, 1, 77.5, null)).toBe('none')
  })
})

describe('formatRelativeDay', () => {
  const now = new Date(2026, 6, 10, 9, 0)

  /** Whole calendar days: last night reads "Yesterday", not "0 days ago". */
  it('counts calendar days, not elapsed hours', () => {
    expect(formatRelativeDay(new Date(2026, 6, 10, 1, 0).toISOString(), now)).toBe(
      'Today',
    )
    expect(formatRelativeDay(new Date(2026, 6, 9, 22, 0).toISOString(), now)).toBe(
      'Yesterday',
    )
    expect(formatRelativeDay(new Date(2026, 6, 7, 18, 0).toISOString(), now)).toBe(
      '3 days ago',
    )
  })

  /** Past a week, "23 days ago" is a number to decode rather than a date. */
  it('falls back to a plain date after six days', () => {
    expect(formatRelativeDay(new Date(2026, 6, 3, 18, 0).toISOString(), now)).toBe(
      formatShortDate(new Date(2026, 6, 3, 18, 0).toISOString()),
    )
  })
})

describe('formatSetWeights', () => {
  it('lists weights in set order, dropping trailing zeros', () => {
    expect(formatSetWeights(lastWorkout([[72.5, 12], [70, 10], [70, 8]]).sets)).toBe(
      '72.5 / 70 / 70',
    )
  })

  it('renders an exercise with no sets as an empty string', () => {
    expect(formatSetWeights([])).toBe('')
  })
})
