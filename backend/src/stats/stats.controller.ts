import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import { StatsService, type StatsOverview } from './stats.service';
import {
  AiProgressSummaryService,
  parseProgressPeriod,
  type ProgressSummaryPayload,
} from './ai-progress-summary.service';

/**
 * Read-only workout statistics. The user is resolved from the session cookie
 * server-side and every query is scoped to their own id, so there is no way to
 * ask this endpoint for somebody else's numbers.
 */
@Controller('stats')
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
    private readonly aiProgressSummary: AiProgressSummaryService,
    private readonly sessionService: SessionService,
  ) {}

  /** Everything the Stats tab renders. */
  @Get('overview')
  async overview(@Req() req: Request): Promise<{ stats: StatsOverview }> {
    const user = await this.currentUser(req);
    return { stats: await this.statsService.getOverview(user.id) };
  }

  /**
   * The AI general-progress summary for a period — cached per (user, period) and
   * regenerated automatically once new training changes the underlying numbers.
   * `period` is one of week | month | three_months | all_time.
   */
  @Get('ai-summary')
  async aiSummary(
    @Query('period') period: unknown,
    @Req() req: Request,
  ): Promise<{ summary: ProgressSummaryPayload }> {
    const user = await this.currentUser(req);
    return {
      summary: await this.aiProgressSummary.getSummary(
        user.id,
        parseProgressPeriod(period),
      ),
    };
  }

  /** Regenerates the progress summary from scratch — the manual "Regenerate". */
  @Post('ai-summary/regenerate')
  @HttpCode(200)
  async regenerateAiSummary(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ summary: ProgressSummaryPayload }> {
    const user = await this.currentUser(req);
    const period = parseProgressPeriod(
      (body as { period?: unknown } | null)?.period,
    );
    return {
      summary: await this.aiProgressSummary.regenerate(user.id, period),
    };
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
