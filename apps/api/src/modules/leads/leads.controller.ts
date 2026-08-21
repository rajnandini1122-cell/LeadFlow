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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type Paginated } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { LeadsService, type LeadSummary } from './leads.service';
import { ListLeadsDto } from './dto/leads.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import {
  AssignLeadDto,
  CreateNoteDto,
  LogActivityDto,
  UpdateLeadDto,
} from './dto/update-lead.dto';
import { LeadMutationsService } from './lead-mutations.service';
import { LeadImportService } from './import/lead-import.service';
import { ImportLeadsDto, PreviewImportDto } from './dto/import-leads.dto';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { CreateFollowUpDto } from '../follow-ups/dto/follow-ups.dto';
import { Inject, forwardRef } from '@nestjs/common';

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
  constructor(
    private readonly leads: LeadsService,
    private readonly mutations: LeadMutationsService,
    private readonly imports: LeadImportService,
    @Inject(forwardRef(() => FollowUpsService))
    private readonly followUps: FollowUpsService,
  ) {}

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

  /**
   * Preview and import are both declared before `:id`, for the same
   * declaration-order reason as `assignable-users`.
   */
  @Post('import/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @ApiOperation({
    summary: 'Validate a CSV and preview what would be imported',
    description:
      'Nothing is written. Returns the suggested column mapping, per-row ' +
      'validation errors and duplicate matches so the user can confirm before ' +
      'committing. Importing straight from a file gives no chance to notice a ' +
      'mismapped column, and there is no undo for two thousand wrong leads.',
  })
  async previewImport(@Body() dto: PreviewImportDto) {
    return this.imports.preview(dto);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @ApiOperation({
    summary: 'Import leads from a CSV',
    description:
      'Rows are written individually and reported individually: a partial ' +
      'import is legible, whereas one bad row rolling back a whole file is ' +
      'not. Duplicates of existing active leads are skipped by default.',
  })
  async importLeads(
    @Body() dto: ImportLeadsDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.imports.import(dto, principal);
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

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Update a lead',
    description:
      'Status changes are checked against the pipeline rules: a won deal cannot ' +
      'be reopened, a lost lead cannot go straight to won, and marking lost ' +
      'requires a reason.',
  })
  async update(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    await this.mutations.update(id, dto, principal);
    return this.leads.findOne(id, principal);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_ASSIGN)
  @ApiOperation({
    summary: 'Reassign a lead',
    description: 'The new owner must be an active member of this organization.',
  })
  async assign(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: AssignLeadDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    await this.mutations.assign(id, dto, principal);
    return this.leads.findOne(id, principal);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.LEAD_DELETE)
  @ApiOperation({
    summary: 'Archive a lead',
    description:
      'Soft delete. Activities cascade from the lead, so a hard delete would ' +
      'erase every call made and quotation sent.',
  })
  async archive(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<void> {
    await this.mutations.archive(id, principal);
  }

  @Get(':id/activities')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Paginated activity timeline' })
  async activities(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Query() query: { cursor?: string; limit?: string },
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.mutations.listActivities(id, principal, {
      cursor: query.cursor,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  }

  @Post(':id/activities')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Log a call or message',
    description:
      'Only user-performed types are accepted. System events such as ' +
      'STATUS_CHANGED are written by the server, so a client cannot fabricate ' +
      'history that never happened.',
  })
  async logActivity(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: LogActivityDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    await this.mutations.logActivity(id, dto, principal);
    return { logged: true };
  }

  @Post(':id/notes')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Add a note to the timeline' })
  async addNote(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: CreateNoteDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    await this.mutations.addNote(id, dto, principal);
    return { added: true };
  }

  @Get(':id/follow-ups')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Follow-ups scheduled on this lead' })
  async leadFollowUps(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.followUps.listForLead(id, principal);
  }

  @Post(':id/follow-ups')
  @RequirePermissions(PERMISSIONS.FOLLOW_UP_CREATE)
  @ApiOperation({ summary: 'Schedule a follow-up on this lead' })
  async createFollowUp(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: CreateFollowUpDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.followUps.create(id, dto, principal);
  }
}
