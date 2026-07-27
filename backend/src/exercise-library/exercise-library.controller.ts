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
import type { AuthenticatedUser } from '../auth/auth.service';
import { readSessionToken } from '../auth/cookie.util';
import { SessionService } from '../auth/session.service';
import {
  ExerciseLibraryService,
  type ExerciseSearchResult,
  type ExerciseUsage,
  type LibraryExercise,
} from './exercise-library.service';

// Ids come from the URL, so they are untrusted. Bound the length as well as the
// shape: a 40-digit "integer" would survive a bare \d+ and overflow downstream.
const ID_PATTERN = /^[1-9][0-9]{0,9}$/;

// The result page is capped so a single request can never ask for the whole
// table at once; absent/blank limit means "no cap" (the caller wants all rows).
const MAX_LIMIT = 500;
const USAGE_VALUES: ReadonlySet<string> = new Set(['all', 'plans', 'history']);

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

  /**
   * The library, optionally narrowed by free-text search, category, muscle
   * group, and where the user has used the exercise, and paged by limit/offset.
   * Each row carries usage metadata; the response also returns the filtered
   * `total` and the per-bucket `counts`. Kept backward compatible: with no query
   * params it returns every active exercise under the same `exercises` key.
   */
  @Get()
  async list(
    @Query('search') search: unknown,
    @Query('category') category: unknown,
    @Query('muscleGroup') muscleGroup: unknown,
    @Query('usage') usage: unknown,
    @Query('limit') limit: unknown,
    @Query('offset') offset: unknown,
    @Req() req: Request,
  ): Promise<ExerciseSearchResult> {
    const user = await this.requireSession(req);
    return this.exerciseLibrary.search({
      userId: user.id,
      search: this.optionalString(search),
      category: this.optionalString(category),
      muscleGroup: this.optionalString(muscleGroup),
      usage: this.optionalUsage(usage),
      limit: this.optionalCount(limit, 1, MAX_LIMIT),
      offset: this.optionalCount(offset, 0, Number.MAX_SAFE_INTEGER),
    });
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

  /** The usage scope, or undefined when absent or not one of the known values. */
  private optionalUsage(value: unknown): ExerciseUsage | undefined {
    if (typeof value !== 'string' || !USAGE_VALUES.has(value)) return undefined;
    return value === 'all' ? undefined : (value as ExerciseUsage);
  }

  /**
   * A non-negative integer query param clamped to [min, max], or undefined when
   * absent or unparseable. A bad value is ignored rather than rejected so a
   * stray query string never turns a browse into a 400.
   */
  private optionalCount(
    value: unknown,
    min: number,
    max: number,
  ): number | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) return undefined;
    return Math.min(Math.max(parsed, min), max);
  }

  /** Denies the request unless the session cookie resolves to a user. */
  private async requireSession(req: Request): Promise<AuthenticatedUser> {
    const user = await this.sessionService.getUserForToken(
      readSessionToken(req),
    );
    if (!user) {
      throw new UnauthorizedException('Not authenticated.');
    }
    return user;
  }
}
