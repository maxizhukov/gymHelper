import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { TrainingModule } from '../training/training.module';
import { WorkoutController } from './workout.controller';
import { WorkoutService } from './workout.service';

/**
 * Imports TrainingModule for the user's config (reps, rest period) and, just as
 * importantly, for its schema bootstrap: `workout_sessions` references
 * `training_days` and `users`, so those tables must exist first. Nest
 * initialises imported modules before their importer, which is what orders the
 * `CREATE TABLE`s correctly.
 */
@Module({
  imports: [DatabaseModule, AuthModule, TrainingModule],
  controllers: [WorkoutController],
  providers: [WorkoutService],
})
export class WorkoutModule {}
