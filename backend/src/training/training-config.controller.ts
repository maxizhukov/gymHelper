import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import { validateTrainingConfigDto } from './dto/training-config.dto';
import {
  TrainingConfig,
  TrainingConfigService,
} from './training-config.service';

@Controller('training-config')
export class TrainingConfigController {
  constructor(
    private readonly trainingConfigService: TrainingConfigService,
    private readonly sessionService: SessionService,
  ) {}

  /** The signed-in user's training settings. Requires a session. */
  @Get()
  async get(@Req() req: Request): Promise<{ config: TrainingConfig }> {
    const user = await this.currentUser(req);
    return { config: await this.trainingConfigService.getConfig(user.id) };
  }

  /**
   * Replaces the signed-in user's training settings. The account is taken from
   * the session — never from the request body — so one user cannot write
   * another's config.
   */
  @Put()
  async update(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ config: TrainingConfig }> {
    const user = await this.currentUser(req);
    const config = validateTrainingConfigDto(body);
    return {
      config: await this.trainingConfigService.saveConfig(user.id, config),
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
