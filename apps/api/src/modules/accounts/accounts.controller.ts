import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { AppException } from '../../common/errors/app.exception';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { LeadsRepository } from '../leads/leads.repository';
import { resolveDateRange, DateRangeError } from '../reports/date-range';
import { AccountsService } from './accounts.service';
import { Account360Service } from './account-360.service';
import { AccountKpiService } from './account-kpi.service';
import { AccountMappingService } from './account-mapping.service';
import { RetentionService } from './retention.service';
import {
  ActionQueueDto,
  CreateAccountFollowUpDto,
  CreateRepeatOpportunityDto,
} from './dto/retention.dto';
import type { AccountStatus } from '../../generated/prisma/enums';
import {
  AccountRangeDto,
  AssignToAccountDto,
  ChangeAccountStatusDto,
  CreateAccountDto,
  ListAccountsDto,
  MergeAccountsDto,
  UnmappedQueryDto,
  UpdateAccountDto,
} from './dto/accounts.dto';

/**
 * Customers and Customer 360.
 *
 * Permissions reuse the existing catalogue rather than inventing a parallel
 * framework, and the split follows what each action actually is:
 *
 *   - READING a customer is `account.view`, which every role holds. A rep has
 *     to pick a customer when creating a lead, and anything narrower would
 *     break lead creation for the people who do most of it.
 *   - CREATING one is `account.create`, also held by reps: a rep taking a call
 *     from a company nobody has dealt with must be able to record it, and
 *     duplicate candidates are surfaced on create so the risk is a suggestion
 *     rather than a silent second record.
 *   - EDITING is `account.update` — manager and above.
 *   - RECLASSIFYING is `account.status.change`, separate because it is what
 *     every acquisition and retention figure is counted from.
 *   - MERGING is `account.merge` — admin only, because it is irreversible and
 *     fuses two customers' histories.
 *   - KPIs are `report.view`, matching the reports and products modules.
 *
 * Every read is tenant-scoped by the Prisma extension, so an id from another
 * organization resolves to a 404 — never a 403, which would confirm the id
 * exists and turn the endpoint into an enumeration oracle over the customer
 * list.
 */
@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly threeSixty: Account360Service,
    private readonly kpi: AccountKpiService,
    private readonly mapping: AccountMappingService,
    private readonly retention: RetentionService,
    private readonly leads: LeadsRepository,
  ) {}

  // --- retention -------------------------------------------------------------

  /**
   * Customers who need attention, and why.
   *
   * Observations, never instructions. Nothing here creates an opportunity,
   * schedules a follow-up or sends a message — a person reads the reason and
   * decides. `report.view` because it summarises the customer base.
   */
  @Get('retention/queue')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'The customer action queue',
    description:
      'Customers with at least one retention signal, strongest first. Signals ' +
      'are computed from history, so filtering happens after scanning a page ' +
      'of customers — `scanned` reports how many were actually examined.',
  })
  async actionQueue(@Query() query: ActionQueueDto) {
    return this.retention.actionQueue(query);
  }

  @Get('retention/summary')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Compact retention counts for the dashboard' })
  async retentionSummary() {
    return this.retention.summary();
  }

  // --- customers -------------------------------------------------------------

  @Get()
  @RequirePermissions(PERMISSIONS.ACCOUNT_VIEW)
  @ApiOperation({ summary: 'The customer list' })
  async list(@Query() query: ListAccountsDto) {
    return this.accounts.list(query);
  }

  /**
   * Customers quiet for longer than the tenant's configured threshold.
   *
   * A REVIEW LIST. Nothing here changes a status — a customer can easily have
   * been active on the phone with nothing written down, and silently
   * reclassifying them would be both wrong and invisible.
   */
  @Get('dormancy-candidates')
  @RequirePermissions(PERMISSIONS.ACCOUNT_UPDATE)
  @ApiOperation({ summary: 'Customers that have gone quiet — for review, not applied' })
  async dormancyCandidates() {
    return this.accounts.dormancyCandidates();
  }

  // --- KPIs ------------------------------------------------------------------

  @Get('kpi/overview')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Customer funnel, retention and repeat business',
    description:
      'Any figure that cannot be calculated comes back as null, never zero. ' +
      'Rates are withheld below a small-sample floor and the underlying counts ' +
      'are reported instead.',
  })
  async overview(@Query() query: AccountRangeDto) {
    const range = await this.range(query);
    return this.kpi.overview(range);
  }

  @Get('kpi/acquisition')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'New customers over time, by first won deal' })
  async acquisition(@Query() query: AccountRangeDto) {
    const range = await this.range(query);
    const timezone = await this.leads.organizationTimezone();

    if (!range) {
      throw AppException.validation('A date range is required for the acquisition trend.', {
        preset: ['required'],
      });
    }

    return this.kpi.acquisitionTrend(range, timezone);
  }

  @Get('kpi/top-customers')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Customers by won value' })
  async topCustomers(@Query() query: AccountRangeDto) {
    const range = await this.range(query);
    return this.kpi.topCustomers(20, range);
  }

  @Get('kpi/product-demand')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Product demand split by new prospect vs existing customer',
    description:
      'Each lead is counted exactly once. Leads with no account are reported ' +
      'as "unknown" rather than attributed to either side. Classification uses ' +
      'whether the account has EVER won a deal, so a company that has since ' +
      'become a customer counts as one for its earlier enquiries too.',
  })
  async productDemand(@Query() query: AccountRangeDto) {
    const range = await this.range(query);
    return this.kpi.demandByCustomerType(range);
  }

  @Get('kpi/demand-by-kind')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Product demand split into first, repeat and expansion business',
    description:
      'Reads the classification recorded when each opportunity was created, ' +
      'so correcting an old deal cannot retrospectively reclassify it. Leads ' +
      'captured before this existed are reported as unclassified rather than ' +
      'counted as first business.',
  })
  async demandByKind(@Query() query: AccountRangeDto) {
    const range = await this.range(query);
    return this.kpi.demandByKind(range);
  }

  // --- backfill --------------------------------------------------------------

  @Get('mapping/progress')
  @RequirePermissions(PERMISSIONS.ACCOUNT_VIEW)
  @ApiOperation({ summary: 'How many leads have a customer attached' })
  async mappingProgress() {
    return this.mapping.progress();
  }

  @Get('mapping/suggestions')
  @RequirePermissions(PERMISSIONS.ACCOUNT_CREATE)
  @ApiOperation({
    summary: 'Unmapped leads grouped by company name, for review',
    description:
      'A PROPOSAL, never an action. Every original spelling is returned so the ' +
      'grouping can be judged, and existing accounts that match exactly are ' +
      'named so a duplicate is not created for a company already on file.',
  })
  async suggestions() {
    return this.mapping.suggestions();
  }

  @Get('mapping/unmapped-leads')
  @RequirePermissions(PERMISSIONS.ACCOUNT_CREATE)
  @ApiOperation({ summary: 'Leads with no customer attached' })
  async unmappedLeads(@Query() query: UnmappedQueryDto) {
    return this.mapping.unmappedLeads(query.search, query.limit ?? 100);
  }

  @Get('mapping/unmapped-contacts')
  @RequirePermissions(PERMISSIONS.ACCOUNT_CREATE)
  @ApiOperation({ summary: 'Contacts with no customer attached' })
  async unmappedContacts(@Query() query: UnmappedQueryDto) {
    return this.mapping.unmappedContacts(query.search, query.limit ?? 100);
  }

  @Get('mapping/suggestions/:leadId')
  @RequirePermissions(PERMISSIONS.ACCOUNT_CREATE)
  @ApiOperation({ summary: 'Existing customers matching one lead by company name' })
  async suggestionsForLead(@Param('leadId', ParseUUIDPipe) leadId: string) {
    return this.mapping.suggestionsForLead(leadId);
  }

  @Post('mapping/assign')
  @RequirePermissions(PERMISSIONS.ACCOUNT_CREATE)
  @ApiOperation({
    summary: 'Attach selected leads and contacts to a customer',
    description:
      'Only records with NO customer are touched, so the returned count may be ' +
      'lower than the number requested. Free-text company names are never ' +
      'overwritten.',
  })
  async assign(@Body() dto: AssignToAccountDto, @CurrentUser() principal: TenantPrincipal) {
    return this.mapping.assign(dto, principal);
  }

  // --- one customer ----------------------------------------------------------

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ACCOUNT_VIEW)
  @ApiOperation({ summary: 'One customer' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.get(id);
  }

  @Get(':id/360')
  @RequirePermissions(PERMISSIONS.ACCOUNT_VIEW)
  @ApiOperation({
    summary: 'Customer 360 — contacts, opportunities, products, conversations, activity',
    description:
      'Commercial figures are CRM opportunity figures, labelled basis: ' +
      'crm-opportunities. LeadFlow has no order table, so no invoiced revenue ' +
      'is reported.',
  })
  async customer360(@Param('id', ParseUUIDPipe) id: string) {
    return this.threeSixty.load(id);
  }

  @Get(':id/duplicates')
  @RequirePermissions(PERMISSIONS.ACCOUNT_UPDATE)
  @ApiOperation({ summary: 'Possible duplicates, with the fields that matched' })
  async duplicates(@Param('id', ParseUUIDPipe) id: string) {
    return { candidates: await this.accounts.duplicatesOf(id) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ACCOUNT_CREATE)
  @ApiOperation({
    summary: 'Create a customer',
    description:
      'Returns 409 DUPLICATE_ACCOUNT with the candidates and matched fields ' +
      'when one looks like the same company. Pass force: true to create anyway.',
  })
  async create(@Body() dto: CreateAccountDto, @CurrentUser() principal: TenantPrincipal) {
    return this.accounts.create(dto, principal);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ACCOUNT_UPDATE)
  @ApiOperation({ summary: 'Update a customer' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.accounts.update(id, dto, principal);
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.ACCOUNT_STATUS_CHANGE)
  @ApiOperation({
    summary: 'Reclassify a customer',
    description:
      'PROSPECT to CUSTOMER is refused: that transition is earned by winning an ' +
      'opportunity, not declared.',
  })
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeAccountStatusDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.accounts.changeStatus(id, dto.status as AccountStatus, dto.reason, principal);
  }

  // --- repeat business -------------------------------------------------------

  /**
   * What this customer has bought, for the repeat picker.
   *
   * The previous won value is returned as CONTEXT. It is never written into a
   * new opportunity unless the salesperson sends it.
   */
  @Get(':id/repeat-options')
  @RequirePermissions(PERMISSIONS.ACCOUNT_VIEW)
  @ApiOperation({ summary: 'Products this customer has bought, for repeat business' })
  async repeatOptions(@Param('id', ParseUUIDPipe) id: string) {
    return this.retention.repeatOptions(id);
  }

  /**
   * Raises the next opportunity for an existing customer.
   *
   * Creates an ORDINARY lead attached to this account — never a second
   * customer, contact or product, and never anything called an order. The
   * customer's status is untouched: winning a repeat deal does not re-acquire
   * a customer.
   *
   * `lead.create` is the permission, because that is exactly what this is.
   * Inventing a repeat-business permission would add a boundary where no new
   * one exists.
   */
  @Post(':id/repeat-opportunity')
  @RequirePermissions(PERMISSIONS.LEAD_CREATE)
  @ApiOperation({
    summary: 'Raise the next opportunity for this customer',
    description:
      'Send an Idempotency-Key header to make a double submission safe: a ' +
      'replay returns the SAME opportunity rather than creating a second one. ' +
      'Two genuinely separate enquiries for one product remain possible.',
  })
  async repeatOpportunity(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRepeatOpportunityDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.retention.createRepeatOpportunity(id, dto, principal, idempotencyKey ?? null);
  }

  // --- customer-level follow-ups ---------------------------------------------

  @Get(':id/follow-ups')
  @RequirePermissions(PERMISSIONS.ACCOUNT_VIEW)
  @ApiOperation({ summary: 'Follow-ups owed on this customer, not on any one deal' })
  async accountFollowUps(@Param('id', ParseUUIDPipe) id: string) {
    return this.retention.accountFollowUps(id);
  }

  /**
   * Schedules an action on the CUSTOMER, with no lead involved.
   *
   * "Call ABC Foods on Monday about a repeat order" is real work. Before this
   * the only way to record it was to invent a lead, which put a fake enquiry
   * in the pipeline and corrupted every conversion figure that counted it.
   */
  @Post(':id/follow-ups')
  @RequirePermissions(PERMISSIONS.FOLLOW_UP_CREATE)
  @ApiOperation({ summary: 'Schedule a follow-up on this customer' })
  async createAccountFollowUp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAccountFollowUpDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.retention.createAccountFollowUp(id, dto, principal);
  }

  @Post(':id/merge')
  @RequirePermissions(PERMISSIONS.ACCOUNT_MERGE)
  @ApiOperation({
    summary: 'Merge this customer into another',
    description:
      'Irreversible. Every lead, contact and follow-up moves to the survivor in ' +
      'one transaction; this record is retained with a pointer so existing ' +
      'references still resolve. Audited with both ids.',
  })
  async merge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeAccountsDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.accounts.merge(id, dto.survivorId, principal);
  }

  // ---------------------------------------------------------------------------

  /** Shared range parsing, in the organization's timezone. */
  private async range(query: AccountRangeDto): Promise<{ from: Date; to: Date } | undefined> {
    if (!query.preset && !query.from && !query.to) return undefined;

    const timezone = await this.leads.organizationTimezone();

    try {
      return resolveDateRange(
        { preset: query.preset, from: query.from, to: query.to },
        timezone,
      );
    } catch (error) {
      if (error instanceof DateRangeError) {
        throw AppException.validation(error.message, { preset: [error.message] });
      }
      throw error;
    }
  }
}
