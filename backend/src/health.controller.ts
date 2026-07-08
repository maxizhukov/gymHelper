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
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`Database health check failed: ${message}`);
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
        message,
      });
    }
  }
}
