import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import {
  TrainingDayDetail,
  TrainingDaySummary,
  TrainingService,
} from './training.service';

// Slugs are lowercase identifiers we generate ('monday'). Anything else is a
// malformed request, so reject it before it reaches the database.
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

@Controller('training-days')
export class TrainingController {
  constructor(
    private readonly trainingService: TrainingService,
    private readonly sessionService: SessionService,
  ) {}

  /** The training plan. Requires a session — the plan is not public. */
  @Get()
  async list(@Req() req: Request): Promise<{ days: TrainingDaySummary[] }> {
    await this.requireSession(req);
    return { days: await this.trainingService.listTrainingDays() };
  }

  /** One training day with its exercises. 404 when the slug is unknown. */
  @Get(':slug')
  async findOne(
    @Param('slug') slug: string,
    @Req() req: Request,
  ): Promise<{ day: TrainingDayDetail }> {
    await this.requireSession(req);

    if (!SLUG_PATTERN.test(slug)) {
      throw new BadRequestException('Invalid training day.');
    }

    const day = await this.trainingService.findTrainingDay(slug);
    if (!day) {
      throw new NotFoundException('Training day not found.');
    }
    return { day };
  }

  /** Denies the request unless the session cookie resolves to a user. */
  private async requireSession(req: Request): Promise<void> {
    const user = await this.sessionService.getUserForToken(
      readSessionToken(req),
    );
    if (!user) {
      throw new UnauthorizedException('Not authenticated.');
    }
  }
}
