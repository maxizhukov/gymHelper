import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import { StatsService, type StatsOverview } from './stats.service';

/**
 * Read-only workout statistics. The user is resolved from the session cookie
 * server-side and every query is scoped to their own id, so there is no way to
 * ask this endpoint for somebody else's numbers.
 */
@Controller('stats')
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
    private readonly sessionService: SessionService,
  ) {}

  /** Everything the Stats tab renders. */
  @Get('overview')
  async overview(@Req() req: Request): Promise<{ stats: StatsOverview }> {
    const user = await this.currentUser(req);
    return { stats: await this.statsService.getOverview(user.id) };
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
