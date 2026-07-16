import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { DeployModule } from './deploy/deploy.module';
import { ExerciseLibraryModule } from './exercise-library/exercise-library.module';
import { FoodModule } from './food/food.module';
import { HealthController } from './health.controller';
import { StatsModule } from './stats/stats.module';
import { TrainingBuilderModule } from './training-builder/training-builder.module';
import { TrainingModule } from './training/training.module';
import { WorkoutModule } from './workout/workout.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    DeployModule,
    TrainingModule,
    TrainingBuilderModule,
    WorkoutModule,
    StatsModule,
    FoodModule,
    ExerciseLibraryModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
