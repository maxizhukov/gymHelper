import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { FoodController } from './food.controller';
import { FoodService } from './food.service';

/**
 * The food tracker. Owns the `food_entries` and `food_daily_targets` tables
 * (bootstrapped by FoodService) and turns text or a label photo into editable
 * drafts via the OpenAI key in the backend config. It needs the database and
 * the session lookup (to gate every endpoint). Imported after AuthModule so the
 * `users` table it references already exists when its bootstrap runs.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [FoodController],
  providers: [FoodService],
})
export class FoodModule {}
