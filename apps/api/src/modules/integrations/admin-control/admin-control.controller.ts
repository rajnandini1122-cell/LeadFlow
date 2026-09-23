import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { Public } from '../../auth/decorators/public.decorator';
import { AdminControlService, type AdminCommandContext } from './admin-control.service';
import { AdminControlOperations, type AdminControlSummary } from './admin-control.operations';
import { CreateTeamDto, UpdateTeamDto, AddTeamMemberDto, UpdateTeamMemberDto } from '../../teams/dto/teams.dto';
import {
  CreateAssignmentRuleDto,
  PreviewAssignmentDto,
  UpdateAssignmentRuleDto,
} from '../../assignment-rules/dto/assignment-rules.dto';
import {
  AddTerritoryCoverageDto,
  CreateTerritoryDto,
  ResolveTerritoryDto,
  UpdateTerritoryDto,
} from '../../territories/dto/territories.dto';
import { IntakeQueryDto, RetryIntakeDto } from '../intake-processing/dto/intake-operations.dto';

/**
 * The Central Admin control plane.
 *
 * NOT a browser endpoint. There is no session and no bearer token; the caller
 * is an approved backend holding a shared secret, and it proves that by signing
 * each request. CORS, Origin, Referer, User-Agent and source IP take no part in
 * anything here — every one of them is set by whoever is calling, which makes
 * them decoration rather than authentication.
 *
 * AN ALLOWLIST, NOT A PROXY. Every operation below is a named method calling an
 * existing LeadFlow service. There is no route that accepts a controller name,
 * a model, a path or a query to dispatch on, because a generic dispatcher makes
 * the boundary a runtime string comparison — and a boundary like that erodes one
 * convenient exception at a time. Adding an operation here is a deliberate act
 * with a diff, which is the property worth having.
 *
 * The domain logic is NOT reimplemented. Every validation, invariant and refusal
 * is the same code the human-facing controllers call: a team archived while
 * rules point at it is refused here exactly as it is there, because it is the
 * same method. "Admin" is not a reason to bypass a business rule.
 *
 * Excluded from the API docs. It is not part of the product's public surface,
 * and publishing the header names and the signing scheme only helps somebody
 * probing an endpoint that has to accept traffic from outside.
 *
 * Rate limiting: the GENERAL policy, like any other route. Deliberately not the
 * credential one — five attempts per quarter hour exists to make password
 * guessing expensive, and applying it to a trusted backend would throttle a
 * working integration into silence.
 */
@ApiExcludeController()
@Controller('integrations/admin-control')
@Public()
export class AdminControlController {
  constructor(
    private readonly control: AdminControlService,
    private readonly operations: AdminControlOperations,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  @Get('summary')
  async summary(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0): Promise<AdminControlSummary> {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.summary());
  }

  @Get('teams')
  async teams(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.teams());
  }

  @Get('teams/:id')
  async team(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.team(id));
  }

  @Get('agents')
  async agents(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.agents());
  }

  @Get('assignment-rules')
  async rules(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.rules());
  }

  @Get('assignment-rules/:id')
  async rule(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.rule(id));
  }

  @Get('territories')
  async territories(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.territories());
  }

  @Get('territories/:id')
  async territory(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.territory(id));
  }

  @Get('intakes')
  async intakes(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Query() query: IntakeQueryDto,
  ) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.intakes(query));
  }

  @Get('intakes/:id')
  async intake(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.intake(id));
  }

  // ---------------------------------------------------------------------------
  // Read-only POSTs
  //
  // POST because they take a body, NOT because they change anything. They get
  // no ledger row: recording a command that mutated nothing would fill the
  // table with rows nobody consults and bury the ones that matter.
  // ---------------------------------------------------------------------------

  @Post('assignment-rules/preview')
  @HttpCode(HttpStatus.OK)
  async previewAssignment(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Body() dto: PreviewAssignmentDto,
  ) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.previewAssignment(dto));
  }

  @Post('territories/resolve')
  @HttpCode(HttpStatus.OK)
  async resolveTerritory(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Body() dto: ResolveTerritoryDto,
  ) {
    this.authenticate(request, headers);
    return this.control.read(() => this.operations.resolveTerritory(dto));
  }

  // ---------------------------------------------------------------------------
  // Mutations
  //
  // Each one is recorded in the command ledger inside the same transaction as
  // the change it describes, so the pair commits or neither does.
  // ---------------------------------------------------------------------------

  @Post('teams')
  async createTeam(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Body() dto: CreateTeamDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'team.create',
      async (tx, actor) => {
        const team = await this.operations.createTeam(dto, actor, tx);
        return { value: team, entityType: 'Team', entityId: team.id };
      },
      (tx, recorded) => this.operations.team(recorded.entityId as string, tx),
    );
  }

  @Patch('teams/:id')
  async updateTeam(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'team.update',
      async (tx, actor) => {
        const team = await this.operations.updateTeam(id, dto, actor, tx);
        return { value: team, entityType: 'Team', entityId: id };
      },
      (tx) => this.operations.team(id, tx),
    );
  }

  @Post('teams/:id/members')
  async addTeamMember(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTeamMemberDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'team.member.add',
      async (tx, actor) => {
        const team = await this.operations.addTeamMember(id, dto, actor, tx);
        return { value: team, entityType: 'Team', entityId: id };
      },
      (tx) => this.operations.team(id, tx),
    );
  }

  @Post('teams/:id/members/:memberId/remove')
  @HttpCode(HttpStatus.OK)
  async removeTeamMember(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() _body: RetryIntakeDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'team.member.remove',
      async (tx, actor) => {
        const team = await this.operations.removeTeamMember(id, memberId, actor, tx);
        return { value: team, entityType: 'Team', entityId: id };
      },
      (tx) => this.operations.team(id, tx),
    );
  }

  @Patch('teams/:id/members/:memberId')
  async setTeamMemberAssignment(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'team.member.assignment',
      async (tx, actor) => {
        const team = await this.operations.setTeamMemberAssignment(id, memberId, dto, actor, tx);
        return { value: team, entityType: 'Team', entityId: id };
      },
      (tx) => this.operations.team(id, tx),
    );
  }

  @Post('assignment-rules')
  async createRule(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Body() dto: CreateAssignmentRuleDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'assignment_rule.create',
      async (tx, actor) => {
        const rule = await this.operations.createRule(dto, actor, tx);
        return { value: rule, entityType: 'AssignmentRule', entityId: rule.id };
      },
      (tx, recorded) => this.operations.rule(recorded.entityId as string, tx),
    );
  }

  @Patch('assignment-rules/:id')
  async updateRule(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssignmentRuleDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'assignment_rule.update',
      async (tx, actor) => {
        const rule = await this.operations.updateRule(id, dto, actor, tx);
        return { value: rule, entityType: 'AssignmentRule', entityId: id };
      },
      (tx) => this.operations.rule(id, tx),
    );
  }

  @Post('territories')
  async createTerritory(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Body() dto: CreateTerritoryDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'territory.create',
      async (tx, actor) => {
        const territory = await this.operations.createTerritory(dto, actor, tx);
        return { value: territory, entityType: 'Territory', entityId: territory.id };
      },
      (tx, recorded) => this.operations.territory(recorded.entityId as string, tx),
    );
  }

  @Patch('territories/:id')
  async updateTerritory(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTerritoryDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'territory.update',
      async (tx, actor) => {
        const territory = await this.operations.updateTerritory(id, dto, actor, tx);
        return { value: territory, entityType: 'Territory', entityId: id };
      },
      (tx) => this.operations.territory(id, tx),
    );
  }

  @Post('territories/:id/coverage')
  async addCoverage(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTerritoryCoverageDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'territory.coverage.add',
      async (tx, actor) => {
        const territory = await this.operations.addCoverage(id, dto, actor, tx);
        return { value: territory, entityType: 'Territory', entityId: id };
      },
      (tx) => this.operations.territory(id, tx),
    );
  }

  @Post('territories/:id/coverage/:coverageId/remove')
  @HttpCode(HttpStatus.OK)
  async removeCoverage(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('coverageId', ParseUUIDPipe) coverageId: string,
    @Body() _body: RetryIntakeDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'territory.coverage.remove',
      async (tx, actor) => {
        const territory = await this.operations.removeCoverage(id, coverageId, actor, tx);
        return { value: territory, entityType: 'Territory', entityId: id };
      },
      (tx) => this.operations.territory(id, tx),
    );
  }

  /**
   * Routes a blocked enquiry again.
   *
   * Takes no payload, exactly as the native endpoint does not: retry means
   * "evaluate what the customer sent, now that the configuration is fixed",
   * never "submit these values instead".
   */
  @Post('intakes/:id/retry')
  @HttpCode(HttpStatus.OK)
  async retryIntake(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: RetryIntakeDto,
  ) {
    const context = this.authenticate(request, headers);

    return this.control.mutate(
      context,
      'intake.retry',
      async (tx) => {
        const result = await this.operations.retryIntake(id, tx);
        return { value: result, entityType: 'IntegrationIntake', entityId: id };
      },
      (tx) => this.operations.intakeCommandResult(id, tx),
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Proves the caller holds the secret, before anything else happens.
   *
   * A disabled control plane is INVISIBLE rather than forbidden. 404 is the
   * honest answer for a route this deployment does not offer, and it tells
   * somebody scanning for control endpoints nothing about whether one exists
   * here and is merely switched off — which is the same choice the website
   * intake boundary makes.
   *
   * The signed path is `request.path`: the full path as routed, without the
   * query string. Filters on a read change nothing, and binding them would make
   * the caller's URL-encoding choices part of the contract.
   */
  private authenticate(
    request: RawBodyRequest<Request>,
    headers: Headers0,
  ): AdminCommandContext {
    if (!this.control.enabled) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Not found.');
    }

    return this.control.authenticate({
      method: request.method,
      path: request.path,
      rawBody: request.rawBody,
      signature: header(headers, 'x-cravion-admin-signature'),
      timestamp: header(headers, 'x-cravion-admin-timestamp'),
      requestId: header(headers, 'x-cravion-admin-request-id'),
      actorRef: header(headers, 'x-cravion-admin-actor'),
    });
  }
}

/** Express lower-cases header names; this is the shape they arrive in. */
type Headers0 = Record<string, string | string[] | undefined>;

/**
 * One header value.
 *
 * A repeated header arrives as an array, and picking one of several would let a
 * caller send two signatures and have us choose. Refused by returning nothing,
 * which the verifier treats as missing.
 */
function header(headers: Headers0, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}
