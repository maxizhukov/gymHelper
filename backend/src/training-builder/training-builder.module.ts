import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ExerciseLibraryModule } from '../exercise-library/exercise-library.module';
import { TrainingBuilderController } from './training-builder.controller';
import { TrainingBuilderService } from './training-builder.service';

/**
 * The Training Builder — the user's repeatable templates, days, and the library
 * exercises placed on them.
 *
 * Imports ExerciseLibraryModule for schema ordering as much as for the lookups:
 * `training_template_day_exercises.exercise_library_id` references
 * `exercise_library`, so that table must be bootstrapped first. Nest initialises
 * imported modules before their importer, which orders the `CREATE TABLE`s.
 * AuthModule gates every endpoint on a session.
 */
@Module({
  imports: [DatabaseModule, AuthModule, ExerciseLibraryModule],
  controllers: [TrainingBuilderController],
  providers: [TrainingBuilderService],
  exports: [TrainingBuilderService],
})
export class TrainingBuilderModule {}
