import type { CookieOptions, Request, Response } from 'express';
import { SESSION_COOKIE_NAME } from './session.service';

/**
 * Reads the session token from the request's Cookie header. Parsed by hand so we
 * don't need the cookie-parser middleware (one less dependency to audit on a
 * public repo). Returns undefined when the cookie is absent or malformed.
 */
export function readSessionToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Cookie attributes for the session cookie. HttpOnly keeps the token out of
 * reach of JavaScript (XSS can't steal it); SameSite=Lax blocks it from being
 * sent on cross-site requests (CSRF); Secure is enabled in production so the
 * token is only ever sent over HTTPS. `path: '/'` scopes it to the whole app.
 */
function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

/** Sets the session cookie carrying the given token. */
export function setSessionCookie(
  res: Response,
  token: string,
  maxAgeMs: number,
): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: maxAgeMs,
  });
}

/** Clears the session cookie (logout). Attributes must match to reliably clear. */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, baseCookieOptions());
}
