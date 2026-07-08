import { BadRequestException } from '@nestjs/common';

export interface ChangePasswordDto {
  currentPassword: string;
  newPassword: string;
}

const MAX_PASSWORD_LENGTH = 200;

/**
 * Validates and normalizes an untrusted change-password request body. Assumes
 * hostile input: rejects anything that is not a well-formed
 * { currentPassword, newPassword }.
 *
 * The account is never taken from the body — it comes from the authenticated
 * session — so no username is accepted here (the client cannot target another
 * user's account).
 *
 * Per product rule, the only strength requirement on the new password is that it
 * has at least one character. The max-length cap is a hostile-input/DoS guard,
 * not a strength rule.
 */
export function validateChangePasswordDto(body: unknown): ChangePasswordDto {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  const { currentPassword, newPassword } = body as Record<string, unknown>;

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw new BadRequestException('currentPassword is required.');
  }
  // Only rule: the new password must have at least one character.
  if (typeof newPassword !== 'string' || newPassword.length < 1) {
    throw new BadRequestException(
      'newPassword must have at least 1 character.',
    );
  }
  if (
    currentPassword.length > MAX_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH
  ) {
    throw new BadRequestException('password is too long.');
  }

  return { currentPassword, newPassword };
}
