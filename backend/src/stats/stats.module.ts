import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AiProgressSummaryService } from './ai-progress-summary.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Statistics are read-only over tables owned by TrainingModule and
 * WorkoutModule. The one exception is AiProgressSummaryService, which owns a
 * small `progress_ai_summaries` cache table — it references `users`, created by
 * AuthModule, which is imported here so it bootstraps first.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [StatsController],
  providers: [StatsService, AiProgressSummaryService],
})
export class StatsModule {}
