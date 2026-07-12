import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FoodController } from './food.controller';
import { FoodService } from './food.service';

/**
 * Food parsing over the OpenAI API. Owns no schema and no database — it turns a
 * description into nutrition at request time. It needs the session lookup (to
 * gate the endpoint) and reads OPENAI_API_KEY from the global config.
 */
@Module({
  imports: [AuthModule],
  controllers: [FoodController],
  providers: [FoodService],
})
export class FoodModule {}
