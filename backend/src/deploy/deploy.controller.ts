import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { DeployService } from './deploy.service';
import { validateDeployNotificationDto } from './dto/deploy-notification.dto';

@Controller('deploy')
export class DeployController {
  constructor(private readonly deployService: DeployService) {}

  /**
   * Deploy webhook: called by the CI pipeline a few seconds after a release
   * goes live. Authorized by a shared-secret header, then fans out a "version
   * deployed" notification to the Telegram channel.
   */
  @Post('notify')
  @HttpCode(200)
  async notify(
    @Headers('x-deploy-secret') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ delivered: true }> {
    this.deployService.authorize(secret);
    const details = validateDeployNotificationDto(body);
    await this.deployService.notifyDeployment(details);
    return { delivered: true };
  }
}
