import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import {
  ExerciseLibraryService,
  type LibraryExercise,
} from './exercise-library.service';

// Ids come from the URL, so they are untrusted. Bound the length as well as the
// shape: a 40-digit "integer" would survive a bare \d+ and overflow downstream.
const ID_PATTERN = /^[1-9][0-9]{0,9}$/;

/**
 * The exercise library API — the catalogue of movements the user can browse.
 * Every endpoint requires a session, mirroring the rest of the app; nothing here
 * is public. The list is read-only for now; connecting these exercises to
 * training plans comes later.
 */
@Controller('exercises')
export class ExerciseLibraryController {
  constructor(
    private readonly exerciseLibrary: ExerciseLibraryService,
    private readonly sessionService: SessionService,
  ) {}

  /** The library, optionally filtered by category and/or muscle group. */
  @Get()
  async list(
    @Query('category') category: unknown,
    @Query('muscleGroup') muscleGroup: unknown,
    @Req() req: Request,
  ): Promise<{ exercises: LibraryExercise[] }> {
    await this.requireSession(req);
    return {
      exercises: await this.exerciseLibrary.list(
        this.optionalString(category),
        this.optionalString(muscleGroup),
      ),
    };
  }

  /** One exercise by id. 404 when it does not exist. */
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ exercise: LibraryExercise }> {
    await this.requireSession(req);
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestException('Invalid exercise id.');
    }
    const exercise = await this.exerciseLibrary.findOne(Number(id));
    if (!exercise) {
      throw new NotFoundException('Exercise not found.');
    }
    return { exercise };
  }

  /** A trimmed query-string value, or undefined when absent or blank. */
  private optionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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
