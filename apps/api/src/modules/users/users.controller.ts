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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type InviteUserResponse, type UserListItem } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { UsersService } from './users.service';
import { InvitationsService } from '../invitations/invitations.service';
import { InviteUserDto, UpdateUserDto } from './dto/users.dto';

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
  ) {}

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
