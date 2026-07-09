import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { TrainingConfigController } from './training-config.controller';
import { TrainingConfigService } from './training-config.service';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [TrainingController, TrainingConfigController],
  providers: [TrainingService, TrainingConfigService],
})
export class TrainingModule {}
