import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Behind a reverse proxy (Caddy) in production; trust it so Express reads the
  // real client protocol from X-Forwarded-* and Secure session cookies work.
  app.set('trust proxy', 1);

  // All routes are served under /api.
  app.setGlobalPrefix('api');

  // Allow the frontend dev server to call this API during development.
  // Configurable via CORS_ORIGIN (comma-separated) for other environments.
  // `credentials` is required so the browser sends the session cookie.
  const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((o) =>
    o.trim(),
  ) ?? ['http://localhost:5173'];
  app.enableCors({ origin: corsOrigin, credentials: true });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Backend listening on http://localhost:${port}/api`);
}
void bootstrap();
