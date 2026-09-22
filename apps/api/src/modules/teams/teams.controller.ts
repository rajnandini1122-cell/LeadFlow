import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type TeamAgentCandidate, type TeamDetail, type TeamListItem } from '@leadflow/api-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { TeamsService } from './teams.service';
import {
  AddTeamMemberDto,
  CreateTeamDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from './dto/teams.dto';

/**
 * Sales teams.
 *
 * Reading is separated from managing on the same line the user endpoints
 * already draw: a manager sees the structure they work in (TEAM_VIEW, granted
 * to MANAGER and above), and restructuring it is administration (TEAM_MANAGE,
 * ADMIN and above). A sales rep has neither, so the screens are invisible to
 * them AND the endpoints refuse them — the guard is the authority, the
 * navigation is a convenience.
 *
 * There is deliberately no DELETE. A team that once owned work is part of the
 * record: archiving keeps who was in it and what they did, which deleting
 * would destroy. Archiving also touches nothing else — no lead is unassigned,
 * no follow-up is cancelled, no login changes.
 */
@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  @ApiOperation({
    summary: 'Sales teams in this organization',
    description: 'Active teams by default; pass includeArchived=true for the full history.',
  })
  async list(@Query('includeArchived') includeArchived?: string): Promise<TeamListItem[]> {
    return this.teams.list(includeArchived === 'true');
  }

  /**
   * The people a team can be built from.
   *
   * Declared BEFORE the `:id` route: Nest matches in declaration order, and
   * "agents" would otherwise be read as a team id and answered with a 400 from
   * the UUID pipe.
   */
  @Get('agents')
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  @ApiOperation({
    summary: 'Organization members available for team management',
    description:
      'Every member except those removed from the organization, with the teams they are ' +
      'in and whether their role may receive automatically assigned work.',
  })
  async agents(): Promise<TeamAgentCandidate[]> {
    return this.teams.agents();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TEAM_VIEW)
  @ApiOperation({ summary: 'One team, with its current members' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<TeamDetail> {
    return this.teams.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @ApiOperation({ summary: 'Create a sales team' })
  async create(
    @Body() dto: CreateTeamDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TeamDetail> {
    return this.teams.create(dto, principal);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @ApiOperation({
    summary: 'Rename a team, change its manager, or archive it',
    description:
      'Archiving is how a team is retired — there is no delete. Nothing else changes: ' +
      'leads keep their owners and follow-ups keep their dates.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TeamDetail> {
    return this.teams.update(id, dto, principal);
  }

  @Post(':id/members')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @ApiOperation({
    summary: 'Add an existing organization member to the team',
    description:
      'Adds somebody who is already in the organization. Inviting a new colleague stays ' +
      'with the existing invitation flow — this endpoint creates no accounts.',
  })
  async addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTeamMemberDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TeamDetail> {
    return this.teams.addMember(id, dto, principal);
  }

  @Patch(':id/members/:memberId')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  @ApiOperation({
    summary: 'Pause or resume future automatic assignment for one member',
    description:
      'An operational toggle only: it does not suspend a login, withdraw a permission, ' +
      'unassign an existing lead or cancel a follow-up.',
  })
  async setMemberAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateTeamMemberDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TeamDetail> {
    return this.teams.setMemberAssignment(id, memberId, dto, principal);
  }

  /**
   * Removal is soft, and it is a POST rather than a DELETE for that reason:
   * the row stays, carrying when they joined and when they left, so "who was
   * in this team when that deal closed" remains answerable.
   */
  @Post(':id/members/:memberId/remove')
  @RequirePermissions(PERMISSIONS.TEAM_MANAGE)
  // 200, not the POST default of 201: this creates nothing. It closes a
  // membership that already existed and answers with the team as it now is.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a member from the team, keeping the history' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TeamDetail> {
    return this.teams.removeMember(id, memberId, principal);
  }
}
