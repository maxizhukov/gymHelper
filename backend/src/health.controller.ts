import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from './database/database.service';

@Controller('db-health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check(): Promise<{ status: string; database: string }> {
    try {
      await this.db.ping();
      return { status: 'ok', database: 'up' };
    } catch (err) {
      // The driver's message can name hosts, users, and ports. Log it; tell the
      // client only that the database is down.
      const message = err instanceof Error ? err.stack : String(err);
      this.logger.error(`Database health check failed: ${message}`);
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
        message: 'Database is unavailable.',
      });
    }
  }
}
