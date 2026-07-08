import { BadRequestException } from '@nestjs/common';

export interface DeployNotificationDto {
  version?: string;
  ref?: string;
  actor?: string;
}

const MAX_FIELD_LENGTH = 200;

/**
 * Validates an untrusted deploy-webhook body. Every field is optional metadata
 * about the release; anything present must be a short, single-line string
 * (control characters stripped) because it is echoed into a Telegram message.
 */
export function validateDeployNotificationDto(
  body: unknown,
): DeployNotificationDto {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  const { version, ref, actor } = body as Record<string, unknown>;
  return {
    version: sanitizeOptional(version, 'version'),
    ref: sanitizeOptional(ref, 'ref'),
    actor: sanitizeOptional(actor, 'actor'),
  };
}

function sanitizeOptional(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string.`);
  }
  if (value.length > MAX_FIELD_LENGTH) {
    throw new BadRequestException(`${field} is too long.`);
  }
  // Replace control chars (incl. newlines) with spaces so the value stays a
  // single clean line when echoed into the Telegram message.
  const cleaned = Array.from(value)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
