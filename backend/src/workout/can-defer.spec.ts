import { canDeferExercise } from './workout.service';

/**
 * The "Machine busy — do this later" rule, pinned down without a database.
 *
 * The database-backed suite in `workout.service.spec.ts` skips when
 * `TEST_DATABASE_URL` is unset, so on a machine with no Postgres it proved
 * nothing — a defer regression could ship green. These tests always run, and
 * they are the reason the button cannot quietly disappear again.
 *
 * The rule in one line: the button is offered at the start of every exercise
 * and withdrawn as soon as that exercise's first set lands.
 */

const SETS_PER_EXERCISE = 4;

describe('canDeferExercise', () => {
  describe('the button returns for every exercise, not just the first', () => {
    // Four exercises, because the reported bug was invisible with fewer: the
    // button worked on exercise 1 and never came back for 2, 3 or 4.
    const EXERCISE_COUNT = 4;
    const lastPosition = EXERCISE_COUNT - 1;

    // Exercise 1, 2 and 3: offered before the first set, withdrawn after it.
    for (let position = 0; position < lastPosition; position++) {
      it(`offers the button before the first set of exercise ${position + 1}`, () => {
        expect(
          canDeferExercise({
            phase: 'set',
            currentExerciseSets: 0,
            exercisePosition: position,
            exerciseCount: EXERCISE_COUNT,
          }),
        ).toBe(true);
      });

      it(`withdraws the button once exercise ${position + 1} has a set on it`, () => {
        // Every later set of that exercise keeps it hidden, too.
        for (let sets = 1; sets <= SETS_PER_EXERCISE; sets++) {
          expect(
            canDeferExercise({
              phase: 'set',
              currentExerciseSets: sets,
              exercisePosition: position,
              exerciseCount: EXERCISE_COUNT,
            }),
          ).toBe(false);
        }
      });
    }

    // The final exercise is the one exception: there is nothing to do before it.
    it('never offers the button on the final exercise', () => {
      for (let sets = 0; sets <= SETS_PER_EXERCISE; sets++) {
        expect(
          canDeferExercise({
            phase: 'set',
            currentExerciseSets: sets,
            exercisePosition: lastPosition,
            exerciseCount: EXERCISE_COUNT,
          }),
        ).toBe(false);
      }
    });
  });

  /**
   * Walks a whole workout the way the user does — every exercise, every set —
   * and asserts the button's visibility at each step. A rule keyed off the
   * workout's total set count (rather than the current exercise's) passes the
   * first exercise and fails here on the second, which is exactly the
   * regression that shipped.
   */
  it('offers the button exactly once per exercise, at its first set', () => {
    const EXERCISE_COUNT = 5;
    const offeredAt: number[] = [];

    for (let position = 0; position < EXERCISE_COUNT; position++) {
      for (let set = 1; set <= SETS_PER_EXERCISE; set++) {
        const setsAlreadyLogged = set - 1;

        if (
          canDeferExercise({
            phase: 'set',
            currentExerciseSets: setsAlreadyLogged,
            exercisePosition: position,
            exerciseCount: EXERCISE_COUNT,
          })
        ) {
          offeredAt.push(position);
        }

        // Resting between sets never offers it, whatever the exercise.
        expect(
          canDeferExercise({
            phase: 'rest',
            currentExerciseSets: setsAlreadyLogged,
            exercisePosition: position,
            exerciseCount: EXERCISE_COUNT,
          }),
        ).toBe(false);
      }
    }

    // Once each for exercises 1-4, at their first set. Never for the last.
    expect(offeredAt).toEqual([0, 1, 2, 3]);
  });

  it('never offers the button while resting or once the workout is over', () => {
    for (const phase of ['rest', 'completed'] as const) {
      expect(
        canDeferExercise({
          phase,
          currentExerciseSets: 0,
          exercisePosition: 0,
          exerciseCount: 4,
        }),
      ).toBe(false);
    }
  });

  it('never offers the button in a single-exercise workout', () => {
    expect(
      canDeferExercise({
        phase: 'set',
        currentExerciseSets: 0,
        exercisePosition: 0,
        exerciseCount: 1,
      }),
    ).toBe(false);
  });
});
