import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, AuthenticatedUser } from './auth.service';
import { SessionService } from './session.service';
import {
  clearSessionCookie,
  readSessionToken,
  setSessionCookie,
} from './cookie.util';
import { validateLoginDto } from './dto/login.dto';
import { validateChangePasswordDto } from './dto/change-password.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Verifies credentials, opens a server-side session and sets an HttpOnly
   * session cookie. The response body carries only the non-secret user identity;
   * the session token lives solely in the cookie.
   */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true; user: AuthenticatedUser }> {
    const { username, password } = validateLoginDto(body);
    const user = await this.authService.validateUser(username, password);
    const { token, maxAgeMs } = await this.sessionService.createSession(
      user.id,
    );
    setSessionCookie(res, token, maxAgeMs);
    return { success: true, user };
  }

  /**
   * Returns the currently authenticated user based on the session cookie, so the
   * frontend can restore state after a refresh without trusting client storage.
   * 401 when there is no valid session.
   */
  @Get('me')
  async me(@Req() req: Request): Promise<{ user: AuthenticatedUser }> {
    const user = await this.currentUser(req);
    return { user };
  }

  /** Ends the current session and clears the cookie. Idempotent. */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    await this.sessionService.destroySession(readSessionToken(req));
    clearSessionCookie(res);
    return { success: true };
  }

  /**
   * Changes the signed-in user's password. The account is taken from the session
   * — never from the request body — and the current password is re-verified
   * server-side. All of the user's sessions are then invalidated so a stolen
   * token stops working, and a fresh session is issued for this client.
   */
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    const user = await this.currentUser(req);
    const { currentPassword, newPassword } = validateChangePasswordDto(body);
    await this.authService.changePassword(
      user.username,
      currentPassword,
      newPassword,
    );

    await this.sessionService.destroySessionsForUser(user.id);
    const { token, maxAgeMs } = await this.sessionService.createSession(
      user.id,
    );
    setSessionCookie(res, token, maxAgeMs);
    return { success: true };
  }

  /** Resolves the session user or throws 401. Enforced server-side. */
  private async currentUser(req: Request): Promise<AuthenticatedUser> {
    const user = await this.sessionService.getUserForToken(
      readSessionToken(req),
    );
    if (!user) {
      throw new UnauthorizedException('Not authenticated.');
    }
    return user;
  }
}
