import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { TrainingBuilderModule } from '../training-builder/training-builder.module';
import { TrainingModule } from '../training/training.module';
import { WorkoutController } from './workout.controller';
import { WorkoutService } from './workout.service';

/**
 * Imports TrainingModule for the user's config (reps, rest period) and, just as
 * importantly, for its schema bootstrap: `workout_sessions` references
 * `training_days` and `users`, so those tables must exist first. Nest
 * initialises imported modules before their importer, which is what orders the
 * `CREATE TABLE`s correctly.
 *
 * TrainingBuilderModule is imported for the same ordering reason: a workout can
 * be started from a builder day, so `workout_sessions.template_day_id`
 * references `training_template_days` and `workout_session_exercises` carries an
 * `exercise_library_id` — both target tables must exist before this module's
 * schema runs.
 */
@Module({
  imports: [DatabaseModule, AuthModule, TrainingModule, TrainingBuilderModule],
  controllers: [WorkoutController],
  providers: [WorkoutService],
})
export class WorkoutModule {}
