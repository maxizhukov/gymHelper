import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import {
  validateBodyWeightDto,
  validateExerciseNameQuery,
  validateFinishSetDto,
  validateSaveDraftDto,
  validateStartTemplateDayDto,
  validateStartWorkoutDto,
} from './dto/workout.dto';
import {
  AiWorkoutSummaryService,
  type WorkoutSummaryPayload,
} from './ai-workout-summary.service';
import {
  WorkoutService,
  type ExerciseHistory,
  type WorkoutState,
} from './workout.service';

// Ids come from the URL, so they are untrusted. Bound the length as well as the
// shape: a 40-digit "integer" would survive the regex and overflow downstream.
const ID_PATTERN = /^[1-9][0-9]{0,9}$/;

/**
 * The workout endpoints. Every mutation acts on the session user's own active
 * workout, resolved server-side — the client never names the workout it is
 * changing, so one user cannot drive another's session.
 */
@Controller('workout')
export class WorkoutController {
  constructor(
    private readonly workoutService: WorkoutService,
    private readonly aiSummaryService: AiWorkoutSummaryService,
    private readonly sessionService: SessionService,
  ) {}

  /** The user's unfinished workout, or null when there is none to resume. */
  @Get('active')
  async active(@Req() req: Request): Promise<{ workout: WorkoutState | null }> {
    const user = await this.currentUser(req);
    return { workout: await this.workoutService.getActiveWorkout(user.id) };
  }

  /**
   * What the user last did on one exercise, for the Previous Performance panel.
   * Scoped to the session user's own workouts, so a name from the query string
   * can only ever surface their own sets. Declared before ':id', or the
   * parameterised route would swallow it.
   */
  @Get('history')
  async history(
    @Query('name') name: unknown,
    @Req() req: Request,
  ): Promise<{ history: ExerciseHistory }> {
    const user = await this.currentUser(req);
    const exerciseName = validateExerciseNameQuery(name);
    return {
      history: await this.workoutService.getExerciseHistory(
        user.id,
        exerciseName,
      ),
    };
  }

  /**
   * The same panel resolved by the library id the Training Builder assigns, so
   * history follows a movement even when it is removed from a day and added
   * back. Declared before ':id' so the literal path wins.
   */
  @Get('exercise-history/:libraryId')
  async exerciseHistory(
    @Param('libraryId') libraryId: string,
    @Req() req: Request,
  ): Promise<{ history: ExerciseHistory }> {
    const user = await this.currentUser(req);
    if (!ID_PATTERN.test(libraryId)) {
      throw new BadRequestException('Invalid exercise id.');
    }
    return {
      history: await this.workoutService.getExerciseHistoryByLibraryId(
        user.id,
        Number(libraryId),
      ),
    };
  }

  /**
   * One of the user's workouts, in progress or finished. Declared after
   * 'active' so that literal path wins over this parameterised one.
   */
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid workout id.');
    }

    const workout = await this.workoutService.getWorkout(user.id, Number(id));
    if (!workout) {
      throw new NotFoundException('Workout not found.');
    }
    return { workout };
  }

  /**
   * The AI post-workout summary for a finished workout: the cached one, or
   * generated on demand if the background generation has not landed yet. Scoped
   * to the owner. Declared before ':id' so this literal segment wins.
   */
  @Get(':id/summary')
  async summary(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ summary: WorkoutSummaryPayload }> {
    const user = await this.currentUser(req);
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid workout id.');
    }
    return {
      summary: await this.aiSummaryService.getSummary(user.id, Number(id)),
    };
  }

  /** Regenerates the AI summary from scratch — the manual "try again" path. */
  @Post(':id/summary/regenerate')
  @HttpCode(200)
  async regenerateSummary(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ summary: WorkoutSummaryPayload }> {
    const user = await this.currentUser(req);
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid workout id.');
    }
    return {
      summary: await this.aiSummaryService.regenerate(user.id, Number(id)),
    };
  }

  /** Starts a workout for a training day. 409 when one is already in progress. */
  @Post('start')
  async start(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    const { slug } = validateStartWorkoutDto(body);
    return { workout: await this.workoutService.startWorkout(user.id, slug) };
  }

  /**
   * Starts a workout from a Training Builder day. 409 when one is already in
   * progress. The day must belong to a template the user owns.
   */
  @Post('start-template-day')
  async startTemplateDay(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    const { dayId } = validateStartTemplateDayDto(body);
    return {
      workout: await this.workoutService.startWorkoutFromTemplateDay(
        user.id,
        dayId,
      ),
    };
  }

  /** Persists weight/reps as they are typed, before the set is committed. */
  @Post('draft')
  @HttpCode(200)
  async draft(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    const draft = validateSaveDraftDto(body);
    return { workout: await this.workoutService.saveDraft(user.id, draft) };
  }

  /** Logs the current set and starts rest (or completes the workout). */
  @Post('sets')
  @HttpCode(200)
  async finishSet(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    const { weight, reps, rir, rpe, isWarmup } = validateFinishSetDto(body);
    return {
      workout: await this.workoutService.finishSet(user.id, weight, reps, {
        rir,
        rpe,
        isWarmup,
      }),
    };
  }

  /** Ends rest and advances to the next set or exercise. */
  @Post('next')
  @HttpCode(200)
  async next(@Req() req: Request): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    return { workout: await this.workoutService.startNextSet(user.id) };
  }

  /**
   * Pushes the current exercise behind one available exercise — its machine is
   * busy — and opens the one that takes its place. Deferred, never skipped.
   * Takes no body: the exercise to defer is the one the session's cursor names.
   */
  @Post('defer')
  @HttpCode(200)
  async defer(@Req() req: Request): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    return { workout: await this.workoutService.deferExercise(user.id) };
  }

  /**
   * Records the body weight of a finished workout — the last step of the workout
   * itself — or corrects one entered wrongly, later, from its summary. Names the
   * workout in the URL because the session cursor has already let go of it: it is
   * finished, so there is no active workout to resolve it from.
   */
  @Post(':id/body-weight')
  @HttpCode(200)
  async bodyWeight(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid workout id.');
    }
    const { bodyWeightKg } = validateBodyWeightDto(body);
    return {
      workout: await this.workoutService.setBodyWeight(
        user.id,
        Number(id),
        bodyWeightKg,
      ),
    };
  }

  /** Abandons the unfinished workout so a new one can be started. */
  @Post('abandon')
  @HttpCode(204)
  async abandon(@Req() req: Request): Promise<void> {
    const user = await this.currentUser(req);
    await this.workoutService.abandonWorkout(user.id);
  }

  /** Resolves the session user or throws 401. Enforced server-side. */
  private async currentUser(req: Request): Promise<AuthenticatedUser> {
    const user = await this.sessionService.getUserForToken(
      readSessionToken(req),
    );
    if (!user) {
      throw new UnauthorizedException('Not authenticated.');
    }
    return user;
  }
}
