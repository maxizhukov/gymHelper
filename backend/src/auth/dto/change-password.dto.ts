import { BadRequestException } from '@nestjs/common';

export interface ChangePasswordDto {
  username: string;
  currentPassword: string;
  newPassword: string;
}

const MAX_USERNAME_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 200;

/**
 * Validates and normalizes an untrusted change-password request body. Assumes
 * hostile input: rejects anything that is not a well-formed
 * { username, currentPassword, newPassword }.
 *
 * Per product rule, the only strength requirement on the new password is that it
 * has at least one character. The max-length cap is a hostile-input/DoS guard,
 * not a strength rule.
 */
export function validateChangePasswordDto(body: unknown): ChangePasswordDto {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  const { username, currentPassword, newPassword } = body as Record<
    string,
    unknown
  >;

  if (typeof username !== 'string' || username.trim().length === 0) {
    throw new BadRequestException('username is required.');
  }
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw new BadRequestException('currentPassword is required.');
  }
  // Only rule: the new password must have at least one character.
  if (typeof newPassword !== 'string' || newPassword.length < 1) {
    throw new BadRequestException(
      'newPassword must have at least 1 character.',
    );
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    throw new BadRequestException('username is too long.');
  }
  if (
    currentPassword.length > MAX_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH
  ) {
    throw new BadRequestException('password is too long.');
  }

  return { username: username.trim(), currentPassword, newPassword };
}
