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
import { PERMISSIONS, type LeadSourceIntake, type Paginated } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { IdempotencyKey } from '../../common/web/idempotency-key.decorator';
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
import {
  ImportLeadsDto,
  PreviewImportDto,
  SaveMappingTemplateDto,
} from './dto/import-leads.dto';
import { LeadLifecycleService } from './lead-lifecycle.service';
import { DeactivateLeadDto, ReactivateLeadDto } from './dto/lead-lifecycle.dto';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { IntakeOperationsService } from '../integrations/intake-processing/intake-operations.service';
import { CreateFollowUpDto, RecordAttemptDto } from '../follow-ups/dto/follow-ups.dto';
import { RecordOutcomeDto } from '../follow-ups/dto/record-outcome.dto';
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
    private readonly lifecycle: LeadLifecycleService,
    @Inject(forwardRef(() => FollowUpsService))
    private readonly followUps: FollowUpsService,
    private readonly intakes: IntakeOperationsService,
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

  /**
   * Past imports, newest first.
   *
   * Declared with the other `import/` routes and before `:id`, for the same
   * reason they are: Nest matches in declaration order, so `:id` would
   * otherwise swallow `import/batches` and try to parse it as a uuid.
   */
  @Get('import/batches')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @ApiOperation({
    summary: 'Past CSV imports',
    description:
      'Each batch reports what it created and how many of those leads are ' +
      'still live — which is what makes a badly mapped run correctable.',
  })
  async importBatches(@Query('limit') limit?: string) {
    return this.imports.listBatches(limit ? Number(limit) : undefined);
  }

  @Get('import/batches/:batchId')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @ApiOperation({ summary: 'One past CSV import' })
  async importBatch(
    @Param('batchId', new ParseUUIDPipe({ version: '7' })) batchId: string,
  ) {
    return this.imports.findBatch(batchId);
  }

  @Get('import/mappings')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @ApiOperation({ summary: 'Saved column mappings' })
  async mappingTemplates() {
    return this.imports.listTemplates();
  }

  @Post('import/mappings')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @ApiOperation({
    summary: 'Save a reusable column mapping',
    description:
      'Saving under an existing name replaces it, so refining one mapping ' +
      'over three attempts leaves one template rather than three.',
  })
  async saveMappingTemplate(
    @Body() dto: SaveMappingTemplateDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.imports.saveTemplate(dto, principal);
  }

  @Delete('import/mappings/:templateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  @ApiOperation({ summary: 'Delete a saved column mapping' })
  async deleteMappingTemplate(
    @Param('templateId', new ParseUUIDPipe({ version: '7' })) templateId: string,
  ): Promise<void> {
    await this.imports.deleteTemplate(templateId);
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

  /**
   * The website enquiry this lead came from, if it came from one.
   *
   * Gated on seeing the LEAD rather than on the intake operations permission,
   * and deliberately: the salesperson who has to answer this customer needs
   * their actual words, and they have no business in the operations queue. The
   * service still applies the same visibility rules as lead detail, so this
   * cannot be used to read the enquiry behind somebody else's lead.
   *
   * Null rather than 404 when the lead was created by hand — "no enquiry
   * behind it" is an answer, not a missing resource.
   */
  @Get(':id/source-intake')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'The website enquiry behind this lead' })
  async sourceIntake(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<LeadSourceIntake | null> {
    // Re-reads the lead through the same path lead detail uses, so visibility
    // is enforced once rather than reimplemented here.
    await this.leads.findOne(id, principal);

    return this.intakes.forLead(id);
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

  /**
   * Takes a lead out of the live pipeline, reversibly.
   *
   * NOT the same thing as archiving it below, and not the same thing as marking
   * it LOST. A wrongly imported lead is neither a lost opportunity nor
   * something to erase: it is a record that should not be live work, and this
   * is the only one of the three that records WHY and can be undone.
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_DEACTIVATE)
  @ApiOperation({
    summary: 'Deactivate a lead',
    description:
      'Removes it from the active pipeline, cancels its open follow-ups and ' +
      'records who did it and why. Nothing is deleted: the lead, its ' +
      'timeline, its contact, its account link and its originating enquiry ' +
      'all remain. Its mobile and email are released, so the corrected lead ' +
      'can be created with the same details.',
  })
  async deactivate(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: DeactivateLeadDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    await this.lifecycle.deactivate(id, dto, principal);
    return this.leads.findOne(id, principal);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_DEACTIVATE)
  @ApiOperation({
    summary: 'Reactivate a lead',
    description:
      'Can fail with 409: deactivation released this lead\'s mobile and ' +
      'email, so another active lead may have taken them in the meantime. ' +
      'The response names the lead that holds the identifier.',
  })
  async reactivate(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: ReactivateLeadDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    await this.lifecycle.reactivate(id, dto, principal);
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

  /**
   * "I tried and could not reach them."
   *
   * One request for the three facts about one failed call: what happened, the
   * rep's note, and when to try again. It logs the attempt, SUPERSEDES the
   * pending follow-up with one at the retry time, and leaves the sales stage
   * exactly where it was.
   *
   * Deliberately NOT the complete endpoint. An unanswered call is an attempt,
   * not an outcome — the work is still owed, so completing the follow-up would
   * drop the lead out of the queue, which is the opposite of what a missed call
   * means.
   *
   * `lead.update` rather than a new permission: logging that you rang somebody
   * is the same weight of action as logging that you spoke to them, and anybody
   * who may work a lead may record having tried.
   */
  @Post(':id/attempts')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Log a failed contact attempt and schedule the retry',
    description:
      'Records the attempt on the timeline, replaces the pending follow-up ' +
      'with one at the retry time, and returns the lead status unchanged. ' +
      'There is no way to move the sales stage from here: a failed attempt is ' +
      'not contact.',
  })
  async recordAttempt(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: RecordAttemptDto,
    @CurrentUser() principal: TenantPrincipal,
    @IdempotencyKey() idempotencyKey: string | null,
  ) {
    return this.followUps.recordAttempt(id, dto, principal, idempotencyKey);
  }

  /**
   * Logs the outcome of one call — reached or not — and everything it decides.
   *
   * The single action behind "Log outcome". The outcome's rule decides whether
   * the follow-up being worked is completed (the call happened) or superseded
   * by a retry (it did not), whether the stage advances, and which fields are
   * accepted. Same weight as logging an attempt, so it rides on lead.update.
   */
  @Post(':id/outcomes')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Log a call outcome',
    description:
      'Completes the worked follow-up when the customer was reached, or replaces it ' +
      'with a retry when not; schedules exactly one next action unless the lead is ' +
      'closed. Send an Idempotency-Key to make a double submission safe.',
  })
  async recordOutcome(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: RecordOutcomeDto,
    @CurrentUser() principal: TenantPrincipal,
    @IdempotencyKey() idempotencyKey: string | null,
  ) {
    return this.followUps.recordOutcome(id, dto, principal, idempotencyKey);
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
    @IdempotencyKey() idempotencyKey: string | null,
  ) {
    return this.followUps.create(id, dto, principal, idempotencyKey);
  }
}
