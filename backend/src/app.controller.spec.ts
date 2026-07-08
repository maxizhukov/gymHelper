import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('getMessage', () => {
    it('returns a message from the backend', () => {
      expect(appController.getMessage()).toEqual({
        message: 'Hello from NestJS 👋 — auto-deployed from main! 🚀',
      });
    });
  });
});
