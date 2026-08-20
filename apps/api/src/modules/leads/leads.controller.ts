import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type Paginated } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { LeadsService, type LeadSummary } from './leads.service';
import { ListLeadsDto } from './dto/leads.dto';
import { CreateLeadDto } from './dto/create-lead.dto';

/**
 * Lead endpoints.
 *
 * Reading and creating are implemented. Updating, reassigning and status
 * transitions remain Phase 2 — creation was pulled forward because a CRM you
 * cannot add a lead to is not usable.
 */
@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({
    summary: 'List leads visible to the caller',
    description:
      'A holder of lead.view.own sees only their own leads; lead.view.team and ' +
      'lead.view.all widen this. The scope is derived server-side and cannot be ' +
      'broadened by query parameters.',
  })
  async list(
    @Query() dto: ListLeadsDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<Paginated<LeadSummary>> {
    return this.leads.list(dto, principal);
  }

  /**
   * Declared before `:id` on purpose — Nest matches routes in declaration
   * order, so a later `/leads/assignable` would be swallowed by `/leads/:id`
   * and fail UUID validation.
   */
  @Get('assignable-users')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Members who can be assigned a lead' })
  async assignableUsers(): Promise<{ id: string; fullName: string }[]> {
    return this.leads.assignableUsers();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.LEAD_CREATE)
  @ApiOperation({
    summary: 'Create a lead',
    description:
      'Returns 409 DUPLICATE_LEAD when the mobile already belongs to an active lead ' +
      'in this organization. Resend with allowDuplicate=true to create anyway.',
  })
  async create(
    @Body() dto: CreateLeadDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<LeadSummary> {
    return this.leads.create(dto, principal);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Get one lead with its activity timeline' })
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.leads.findOne(id, principal);
  }
}
