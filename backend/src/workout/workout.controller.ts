import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import {
  validateFinishSetDto,
  validateSaveDraftDto,
  validateStartWorkoutDto,
} from './dto/workout.dto';
import { WorkoutService, type WorkoutState } from './workout.service';

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
    private readonly sessionService: SessionService,
  ) {}

  /** The user's unfinished workout, or null when there is none to resume. */
  @Get('active')
  async active(@Req() req: Request): Promise<{ workout: WorkoutState | null }> {
    const user = await this.currentUser(req);
    return { workout: await this.workoutService.getActiveWorkout(user.id) };
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
    const { weight, reps } = validateFinishSetDto(body);
    return {
      workout: await this.workoutService.finishSet(user.id, weight, reps),
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
   * Pushes the current exercise to the back of the queue — its machine is busy —
   * and opens the one that was next. The exercise is deferred, never skipped.
   * Takes no body: the exercise to defer is the one the session's cursor names.
   */
  @Post('defer')
  @HttpCode(200)
  async defer(@Req() req: Request): Promise<{ workout: WorkoutState }> {
    const user = await this.currentUser(req);
    return { workout: await this.workoutService.deferExercise(user.id) };
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
