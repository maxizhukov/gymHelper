import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import { validateParseFoodDto } from './dto/food.dto';
import { FoodService, type ParsedMeal } from './food.service';

/**
 * Food parsing. The OpenAI key stays on the server (see FoodService): the client
 * only ever posts a description here and receives structured nutrition back.
 * Requires a session so an unauthenticated caller cannot spend the key.
 */
@Controller('food')
export class FoodController {
  constructor(
    private readonly foodService: FoodService,
    private readonly sessionService: SessionService,
  ) {}

  /** Parses a free-text meal into structured, totalled nutrition. */
  @Post('parse')
  @HttpCode(200)
  async parse(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ meal: ParsedMeal }> {
    await this.currentUser(req);
    const { description } = validateParseFoodDto(body);
    return { meal: await this.foodService.parse(description) };
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
