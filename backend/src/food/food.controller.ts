import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import type { Targets } from './food.nutrients';
import {
  validateAssistantChatDto,
  validateEntryDto,
  validateParsePhotoDto,
  validateParseTextDto,
  validateTargetsDto,
} from './dto/food.dto';
import {
  FoodService,
  type AssistantReply,
  type DayLog,
  type DraftItem,
  type FoodEntry,
  type ParsedMeal,
} from './food.service';

// Ids come from the URL, so they are untrusted. Bound the length as well as the
// shape: a 40-digit "integer" would survive a bare \d+ and overflow downstream.
const ID_PATTERN = /^[1-9][0-9]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The food tracker API. Every endpoint requires a session, resolved server-side
 * from the cookie; the user id is never taken from the request, so one user can
 * only ever read, write, or delete their own entries. The OpenAI key stays in
 * FoodService — the client posts text or a photo and gets back an editable
 * draft, never a key and never an auto-saved row.
 */
@Controller('food')
export class FoodController {
  constructor(
    private readonly foodService: FoodService,
    private readonly sessionService: SessionService,
  ) {}

  /** The log (entries, totals, targets) for the server's current date. */
  @Get('today')
  async today(@Req() req: Request): Promise<{ day: DayLog }> {
    const user = await this.currentUser(req);
    return { day: await this.foodService.getToday(user.id) };
  }

  /** The log for a specific date. Declared before ':id' routes need not apply. */
  @Get('history')
  async history(
    @Query('date') date: unknown,
    @Req() req: Request,
  ): Promise<{ day: DayLog }> {
    const user = await this.currentUser(req);
    if (typeof date !== 'string' || !DATE_PATTERN.test(date)) {
      throw new BadRequestException('A date (YYYY-MM-DD) is required.');
    }
    return { day: await this.foodService.getDay(user.id, date) };
  }

  /** The user's daily targets, or the defaults when unset. */
  @Get('targets')
  async getTargets(@Req() req: Request): Promise<{ targets: Targets }> {
    const user = await this.currentUser(req);
    return { targets: await this.foodService.getTargets(user.id) };
  }

  /** Replaces the user's daily targets. */
  @Put('targets')
  async putTargets(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ targets: Targets }> {
    const user = await this.currentUser(req);
    const targets = validateTargetsDto(body);
    return { targets: await this.foodService.saveTargets(user.id, targets) };
  }

  /** Parses free text into editable draft items. Saves nothing. */
  @Post('parse-text')
  @HttpCode(200)
  async parseText(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ items: DraftItem[] }> {
    await this.currentUser(req);
    const { description } = validateParseTextDto(body);
    return { items: await this.foodService.parseText(description) };
  }

  /** Parses a nutrition-label photo into editable draft items. Saves nothing. */
  @Post('parse-photo')
  @HttpCode(200)
  async parsePhoto(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ items: DraftItem[] }> {
    await this.currentUser(req);
    const { image, note } = validateParsePhotoDto(body);
    return { items: await this.foodService.parsePhoto(image, note) };
  }

  /** Saves a reviewed entry. */
  @Post('entries')
  async createEntry(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ entry: FoodEntry }> {
    const user = await this.currentUser(req);
    const input = validateEntryDto(body);
    return { entry: await this.foodService.createEntry(user.id, input) };
  }

  /** Edits one of the user's entries. 404 when it is not theirs. */
  @Put('entries/:id')
  async updateEntry(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ entry: FoodEntry }> {
    const user = await this.currentUser(req);
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid entry id.');
    }
    const input = validateEntryDto(body);
    return {
      entry: await this.foodService.updateEntry(user.id, Number(id), input),
    };
  }

  /** Deletes one of the user's entries. 404 when it is not theirs. */
  @Delete('entries/:id')
  @HttpCode(204)
  async deleteEntry(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.currentUser(req);
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid entry id.');
    }
    await this.foodService.deleteEntry(user.id, Number(id));
  }

  /**
   * Answers a nutrition question grounded in the user's own food data. The
   * session decides whose data is used; the OpenAI key stays server-side.
   */
  @Post('assistant/chat')
  @HttpCode(200)
  async assistantChat(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<AssistantReply> {
    const user = await this.currentUser(req);
    const { message, date, historyDays } = validateAssistantChatDto(body);
    return this.foodService.assistantChat(user.id, message, date, historyDays);
  }

  /**
   * Legacy macro-only parser the first Food MVP shipped. Kept so an older
   * frontend bundle still works; new code posts to /food/parse-text.
   */
  @Post('parse')
  @HttpCode(200)
  async parse(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ meal: ParsedMeal }> {
    await this.currentUser(req);
    const { description } = validateParseTextDto(body);
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
