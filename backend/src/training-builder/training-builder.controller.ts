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
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import {
  validateAddExerciseDto,
  validateNameDto,
  validateReorderDto,
} from './dto/training-builder.dto';
import {
  TrainingBuilderService,
  type TemplateDay,
  type TemplateDayExercise,
  type TemplateDetail,
  type TemplateSummary,
} from './training-builder.service';

// Ids come from the URL, so they are untrusted. Bound the length as well as the
// shape: a 40-digit "integer" would survive a bare \d+ and overflow downstream.
const ID_PATTERN = /^[1-9][0-9]{0,9}$/;

/**
 * The Training Builder API. Every endpoint requires a session and acts only on
 * the session user's own templates — ownership is re-checked in the service for
 * every mutation, so an id from the URL can never reach another user's data.
 */
@Controller('training-templates')
export class TrainingBuilderController {
  constructor(
    private readonly builder: TrainingBuilderService,
    private readonly sessionService: SessionService,
  ) {}

  /** The user's templates, without their days. */
  @Get()
  async list(@Req() req: Request): Promise<{ templates: TemplateSummary[] }> {
    const user = await this.currentUser(req);
    return { templates: await this.builder.listTemplates(user.id) };
  }

  /** Creates a template. */
  @Post()
  async create(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ template: TemplateSummary }> {
    const user = await this.currentUser(req);
    const { name } = validateNameDto(body);
    return { template: await this.builder.createTemplate(user.id, name) };
  }

  /** One template with its days and exercises. */
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ template: TemplateDetail }> {
    const user = await this.currentUser(req);
    return {
      template: await this.builder.getTemplate(user.id, this.id(id)),
    };
  }

  /** Renames a template. */
  @Put(':id')
  async rename(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ template: TemplateSummary }> {
    const user = await this.currentUser(req);
    const { name } = validateNameDto(body);
    return {
      template: await this.builder.renameTemplate(user.id, this.id(id), name),
    };
  }

  /** Deletes a template. Workout history is kept. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const user = await this.currentUser(req);
    await this.builder.deleteTemplate(user.id, this.id(id));
  }

  /** Adds a day to a template. */
  @Post(':id/days')
  async createDay(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ day: TemplateDay }> {
    const user = await this.currentUser(req);
    const { name } = validateNameDto(body);
    return {
      day: await this.builder.createDay(user.id, this.id(id), name),
    };
  }

  /** Renames a day. */
  @Put('days/:dayId')
  @HttpCode(204)
  async renameDay(
    @Param('dayId') dayId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.currentUser(req);
    const { name } = validateNameDto(body);
    await this.builder.renameDay(user.id, this.id(dayId), name);
  }

  /** Deletes a day. Workout history is kept. */
  @Delete('days/:dayId')
  @HttpCode(204)
  async deleteDay(
    @Param('dayId') dayId: string,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.currentUser(req);
    await this.builder.deleteDay(user.id, this.id(dayId));
  }

  /** Adds a library exercise to the end of a day. */
  @Post('days/:dayId/exercises')
  async addExercise(
    @Param('dayId') dayId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ exercise: TemplateDayExercise }> {
    const user = await this.currentUser(req);
    const { exerciseLibraryId } = validateAddExerciseDto(body);
    return {
      exercise: await this.builder.addExercise(
        user.id,
        this.id(dayId),
        exerciseLibraryId,
      ),
    };
  }

  /** Removes an exercise from a day (soft delete — history is kept). */
  @Delete('days/:dayId/exercises/:exerciseId')
  @HttpCode(204)
  async removeExercise(
    @Param('dayId') dayId: string,
    @Param('exerciseId') exerciseId: string,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.currentUser(req);
    await this.builder.removeExercise(
      user.id,
      this.id(dayId),
      this.id(exerciseId),
    );
  }

  /** Reorders a day's exercises. */
  @Put('days/:dayId/order')
  @HttpCode(204)
  async reorder(
    @Param('dayId') dayId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<void> {
    const user = await this.currentUser(req);
    const { orderedIds } = validateReorderDto(body);
    await this.builder.reorderExercises(user.id, this.id(dayId), orderedIds);
  }

  private id(value: string): number {
    if (!ID_PATTERN.test(value)) {
      throw new BadRequestException('Invalid id.');
    }
    return Number(value);
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
