import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ExerciseLibraryController } from './exercise-library.controller';
import { ExerciseLibraryService } from './exercise-library.service';

/**
 * The exercise library. Owns the `exercise_library` table (bootstrapped and
 * seeded by ExerciseLibraryService) — the reference catalogue of movements,
 * kept separate from the training module's `exercises` table, which holds the
 * exercises placed inside a specific training day. It needs the database and the
 * session lookup (to gate every endpoint). Imported after AuthModule so the
 * session service it depends on is available.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ExerciseLibraryController],
  providers: [ExerciseLibraryService],
  exports: [ExerciseLibraryService],
})
export class ExerciseLibraryModule {}
