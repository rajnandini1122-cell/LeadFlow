import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AvatarService } from './avatar.service';
import { AvatarRepository } from './avatar.repository';
import { OffboardingService } from './offboarding.service';
import { OffboardingRepository } from './offboarding.repository';
import { UsersRepository } from './users.repository';

@Module({
  controllers: [UsersController],
  providers: [
    AvatarService,
    AvatarRepository,UsersService, UsersRepository, OffboardingService, OffboardingRepository],
  exports: [UsersService, UsersRepository, OffboardingService],
})
export class UsersModule {}
