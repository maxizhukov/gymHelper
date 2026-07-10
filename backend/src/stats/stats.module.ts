import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Statistics are read-only over tables owned by TrainingModule and
 * WorkoutModule. Nothing here creates schema, so — unlike WorkoutModule — this
 * module has no bootstrap to order against theirs and needs only the database
 * and the session lookup.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
