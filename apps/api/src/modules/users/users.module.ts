import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { OffboardingService } from './offboarding.service';
import { OffboardingRepository } from './offboarding.repository';
import { UsersRepository } from './users.repository';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository, OffboardingService, OffboardingRepository],
  exports: [UsersService, UsersRepository, OffboardingService],
})
export class UsersModule {}
