import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService, AuthenticatedUser } from './auth.service';
import { validateLoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
  ): Promise<{ success: true; user: AuthenticatedUser }> {
    const { username, password } = validateLoginDto(body);
    const user = await this.authService.validateUser(username, password);
    return { success: true, user };
  }
}
