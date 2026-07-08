import { BadRequestException } from '@nestjs/common';

export interface LoginDto {
  username: string;
  password: string;
}

const MAX_USERNAME_LENGTH = 100;
const MAX_PASSWORD_LENGTH = 200;

/**
 * Validates and normalizes an untrusted login request body. Assumes hostile
 * input: rejects anything that is not a well-formed { username, password }.
 */
export function validateLoginDto(body: unknown): LoginDto {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('Request body must be a JSON object.');
  }

  const { username, password } = body as Record<string, unknown>;

  if (typeof username !== 'string' || username.trim().length === 0) {
    throw new BadRequestException('username is required.');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new BadRequestException('password is required.');
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    throw new BadRequestException('username is too long.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new BadRequestException('password is too long.');
  }

  return { username: username.trim(), password };
}
