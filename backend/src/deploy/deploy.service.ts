import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { DeployNotificationDto } from './dto/deploy-notification.dto';

@Injectable()
export class DeployService {
  private readonly logger = new Logger(DeployService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Authorizes a deploy webhook using a shared secret, compared in constant
   * time so a caller cannot probe it via response timing. Throws if the secret
   * is unset (webhook disabled) or does not match — never trust the caller.
   */
  authorize(provided: string | undefined): void {
    const expected = this.config.get<string>('DEPLOY_WEBHOOK_SECRET');
    if (!expected) {
      this.logger.warn(
        'Deploy webhook called but DEPLOY_WEBHOOK_SECRET is not set; rejecting.',
      );
      throw new UnauthorizedException('Deploy webhook is not configured.');
    }
    const a = Buffer.from(provided ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid deploy webhook secret.');
    }
  }

  /**
   * Notifies the configured Telegram chat that a new version was deployed.
   * Throws ServiceUnavailableException if Telegram is not configured or the
   * Bot API call fails, so the caller (CI) can surface the problem.
   */
  async notifyDeployment(details: DeployNotificationDto): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const chatId = this.config.get<string>('TELEGRAM_CHAT_ID');
    if (!token || !chatId) {
      this.logger.error(
        'Cannot send deploy notification: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set.',
      );
      throw new ServiceUnavailableException(
        'Telegram notifications are not configured.',
      );
    }

    const text = this.buildMessage(details);

    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`Telegram request failed: ${message}`);
      throw new ServiceUnavailableException('Failed to reach Telegram.');
    }

    if (!response.ok) {
      // Telegram echoes the request; log only the status + a short snippet, and
      // never the bot token (it lives in the URL, not the body).
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Telegram API returned ${response.status}: ${body.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException(
        'Telegram API rejected the message.',
      );
    }

    this.logger.log('Sent deploy notification to Telegram.');
  }

  private buildMessage(details: DeployNotificationDto): string {
    const lines = [
      '🚀 GymHelper deployed',
      `Version: ${details.version ?? 'unknown'}`,
    ];
    if (details.ref) {
      lines.push(`Branch: ${details.ref}`);
    }
    if (details.actor) {
      lines.push(`By: ${details.actor}`);
    }
    return lines.join('\n');
  }
}
