import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception';
import { PERMISSIONS, type InviteUserResponse, type UserListItem } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { UsersService } from './users.service';
import { OffboardingService } from './offboarding.service';
import { InvitationsService } from '../invitations/invitations.service';
import { InviteUserDto, UpdateUserDto } from './dto/users.dto';
import { OffboardMemberDto, TransferAdminDto } from './dto/offboarding.dto';
import { AvatarService, MAX_AVATAR_BYTES, type UploadedAvatar } from './avatar.service';

/**
 * Controllers stay thin (spec §33): validate shape, delegate, return.
 * No business logic, no data access, no envelope construction.
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
    private readonly offboarding: OffboardingService,
    private readonly avatars: AvatarService,
  ) {}

  /**
   * Set your own profile picture.
   *
   * Deliberately only ever the CALLER's own — there is no route for setting
   * somebody else's face, which removes "an admin changed my photo" before it
   * can be asked. No permission beyond being signed in: a person's own picture
   * is not organization configuration.
   *
   * The size cap is enforced by the PARSER, before the bytes are fully read.
   * Checking afterwards would mean accepting an arbitrarily large upload into
   * memory in order to reject it.
   */
  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } }),
  )
  @ApiOperation({ summary: 'Upload your profile picture' })
  async uploadAvatar(
    @CurrentUser() principal: TenantPrincipal,
    @UploadedFile() file?: UploadedAvatar,
  ) {
    return this.avatars.upload(principal.userId, file);
  }

  @Delete('me/avatar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove your profile picture' })
  async removeAvatar(@CurrentUser() principal: TenantPrincipal): Promise<void> {
    await this.avatars.remove(principal.userId);
  }

  /**
   * Someone's profile picture.
   *
   * Readable by anyone who shares an organization with them — enforced in the
   * service, because a User is global and its id is therefore not tenant
   * scoped. Without that check a signed-in account could walk ids and collect
   * photographs of people at every other company on the deployment.
   */
  @Get(':id/avatar')
  @ApiOperation({ summary: "A member's profile picture" })
  async avatar(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const avatar = await this.avatars.read(id);

    response.setHeader('Content-Type', avatar.mimeType);
    // Belt and braces: the type was detected from the bytes on upload, and the
    // browser is told not to second-guess it either.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    /*
     * Cached privately, and only by the person who fetched it.
     *
     * The URL carries a version that changes whenever the picture does, so a
     * long max-age is safe and keeps avatars off the network on every screen
     * that lists people. `private` keeps it out of any shared cache: this is
     * one organization's staff, not public content.
     */
    response.setHeader('Cache-Control', 'private, max-age=86400');

    response.end(Buffer.from(avatar.data));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.USER_VIEW)
  @ApiOperation({ summary: 'List members of the current organization' })
  async list(): Promise<UserListItem[]> {
    return this.users.list();
  }

  @Post('invite')
  @RequirePermissions(PERMISSIONS.USER_INVITE)
  @ApiOperation({ summary: 'Invite a user into the current organization' })
  async invite(
    @Body() dto: InviteUserDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<InviteUserResponse> {
    return this.users.invite(dto, principal);
  }

  /**
   * Declared before the `:id` routes — Nest matches in declaration order, so
   * `/users/invitations` would otherwise be captured by `/users/:id` and fail
   * UUID validation.
   */
  @Get('invitations')
  @RequirePermissions(PERMISSIONS.USER_VIEW)
  @ApiOperation({ summary: 'Pending invitations for the current organization' })
  async pendingInvitations() {
    return this.invitations.listPending();
  }

  @Post('invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.USER_INVITE)
  @ApiOperation({
    summary: 'Resend an invitation',
    description: 'Rotates the token, which invalidates the previous link.',
  })
  async resendInvitation(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.invitations.resend(id);
  }

  @Delete('invitations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.USER_INVITE)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revokeInvitation(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    await this.invitations.revoke(id);
  }

  @Post('transfer-admin')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    summary: 'Hand admin responsibility to another active member',
    description:
      'Owner-only. Exists as its own operation because an owner cannot change ' +
      'their own role — without it, a departing owner has no way to name a ' +
      'successor. With stepDown the caller becomes an ADMIN, keeping ' +
      'day-to-day access while giving up ownership.',
  })
  async transferAdmin(
    @Body() dto: TransferAdminDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    if (principal.role !== 'OWNER') {
      throw AppException.forbidden('Only an owner can transfer admin responsibility.');
    }
    return this.offboarding.transferAdmin(
      { toUserId: dto.toUserId, stepDown: dto.stepDown !== false },
      principal,
    );
  }

  @Get(':id/workload')
  @RequirePermissions(PERMISSIONS.USER_UPDATE)
  @ApiOperation({
    summary: 'What a member is currently carrying',
    description:
      'Active leads and open follow-ups are what block an exit; won, lost and ' +
      'archived counts are shown alongside so the consequences of a handover ' +
      'are visible before it is confirmed.',
  })
  async workload(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.offboarding.workload(id);
  }

  @Post(':id/offboard')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.USER_REMOVE)
  @ApiOperation({
    summary: 'Hand a member’s work over, then deactivate or remove them',
    description:
      'Strictly in that order: reassign first, deactivate second. The reverse ' +
      'would leave a window in which live customers had an owner who could no ' +
      'longer sign in. Returns 409 REASSIGNMENT_REQUIRED, with counts, when ' +
      'active work exists and no successor was named.',
  })
  async offboard(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: OffboardMemberDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.offboarding.offboard(
      id,
      {
        action: dto.action,
        reassignToId: dto.reassignToId,
        includeHistorical: dto.includeHistorical,
        reason: dto.reason,
      },
      principal,
    );
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.USER_VIEW)
  @ApiOperation({ summary: 'Get one member of the current organization' })
  async findOne(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string): Promise<UserListItem> {
    return this.users.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_UPDATE)
  @ApiOperation({ summary: 'Update a member’s profile, role or status' })
  async update(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<UserListItem> {
    return this.users.update(id, dto, principal);
  }
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.USER_REMOVE)
  @ApiOperation({
    summary: 'Remove a member from the organization',
    description:
      'Soft removal. The membership row is retained so leads and activities ' +
      'keep a valid assignee; access is revoked immediately.',
  })
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<void> {
    await this.users.remove(id, principal);
  }
}
