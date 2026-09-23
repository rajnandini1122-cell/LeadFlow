import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  type AssignmentPreviewResult,
  type AssignmentRuleView,
} from '@leadflow/api-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { userActor } from '../../common/audit/mutation-actor';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { AssignmentRulesService } from './assignment-rules.service';
import {
  CreateAssignmentRuleDto,
  PreviewAssignmentDto,
  UpdateAssignmentRuleDto,
} from './dto/assignment-rules.dto';

/**
 * The routing table: which team handles which work.
 *
 * Read and manage are separate permissions, and manage is NOT team.manage:
 * staffing a team decides who does the work, while this decides which
 * customers reach which team at all. Somebody trusted with one is not
 * automatically trusted with the other.
 *
 * There is no DELETE. A rule that once routed work is the explanation for why
 * a customer went where they did; archiving keeps that and stops it running.
 */
@ApiTags('assignment-rules')
@Controller('assignment-rules')
export class AssignmentRulesController {
  constructor(private readonly rules: AssignmentRulesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ASSIGNMENT_RULE_VIEW)
  @ApiOperation({
    summary: 'The routing table',
    description: 'Active rules first, in the order they are evaluated, with the fallback last.',
  })
  async list(): Promise<AssignmentRuleView[]> {
    return this.rules.list();
  }

  /**
   * Where a piece of work would go, without sending it there.
   *
   * Declared before `:id` so "preview" is not read as a rule id. POST because
   * it takes a body; it writes nothing at all — no lead, no intake, no
   * follow-up, no cursor.
   */
  @Post('preview')
  @RequirePermissions(PERMISSIONS.ASSIGNMENT_RULE_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Evaluate the rules against a hypothetical enquiry',
    description:
      'Read-only. Returns the matching rule, the target team and who in it could receive ' +
      'work right now — never a chosen person, and never a change to any record.',
  })
  async preview(@Body() dto: PreviewAssignmentDto): Promise<AssignmentPreviewResult> {
    return this.rules.preview(dto);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ASSIGNMENT_RULE_VIEW)
  @ApiOperation({ summary: 'One rule' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<AssignmentRuleView> {
    return this.rules.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ASSIGNMENT_RULE_MANAGE)
  @ApiOperation({ summary: 'Add a routing rule' })
  async create(
    @Body() dto: CreateAssignmentRuleDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<AssignmentRuleView> {
    return this.rules.create(dto, userActor(principal));
  }

  /**
   * Everything else, including pausing, activating and archiving.
   *
   * Status is a field rather than three action endpoints, following the same
   * style the teams and subscriptions controllers already use — one place
   * where a change is validated, audited and refused.
   */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ASSIGNMENT_RULE_MANAGE)
  @ApiOperation({
    summary: 'Edit a rule, or pause, activate or archive it',
    description:
      'Archiving is how a rule is retired; there is no delete, and an archived rule is not ' +
      'reactivated — write a new one.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssignmentRuleDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<AssignmentRuleView> {
    return this.rules.update(id, dto, userActor(principal));
  }
}
