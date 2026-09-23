import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  type IntakeRetryResponse,
  type IntegrationIntakeDetail,
  type IntegrationIntakePage,
} from '@leadflow/api-types';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { IntakeOperationsService } from './intake-operations.service';
import { IntakeQueryDto, RetryIntakeDto } from './dto/intake-operations.dto';

/**
 * The website intake queue.
 *
 * An operations surface, and a narrow one. It reads what arrived and what
 * routing did with it, and offers exactly one action: evaluate the same
 * enquiry again. There is no create, no edit and no delete — the customer's
 * submission is the record, and a tool that could rewrite it would eventually
 * be used to.
 *
 * Nothing from the public HMAC route is exposed: no signature, no payload
 * hash, no event id. Those authenticate a caller and have no operational
 * meaning to a person reading a queue.
 */
@ApiTags('integration-intakes')
@Controller('integration-intakes')
export class IntakeOperationsController {
  constructor(private readonly operations: IntakeOperationsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INTEGRATION_INTAKE_VIEW)
  @ApiOperation({
    summary: 'Website enquiries and what routing did with them',
    description: 'Newest first. Filter by status, source or arrival time.',
  })
  async list(@Query() query: IntakeQueryDto): Promise<IntegrationIntakePage> {
    return this.operations.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INTEGRATION_INTAKE_VIEW)
  @ApiOperation({ summary: 'One enquiry, with the customer’s original message' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<IntegrationIntakeDetail> {
    return this.operations.findOne(id);
  }

  /**
   * Evaluates the same enquiry again.
   *
   * Takes NO body. Retry means "run the routing again now that the
   * configuration is fixed", never "submit these values instead" — accepting a
   * payload here would make an operations endpoint a way to author a
   * customer's enquiry on their behalf.
   *
   * Explicit 200: Nest answers POST with 201 by default, which would claim
   * something was created even when the answer is "already processed".
   */
  @Post(':id/retry')
  @RequirePermissions(PERMISSIONS.INTEGRATION_INTAKE_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Route this enquiry again',
    description:
      'Re-evaluates the SAME stored enquiry. The submission is never altered and no new event ' +
      'id is minted. Idempotent: an enquiry somebody else just converted reports that lead.',
  })
  async retry(
    @Param('id', ParseUUIDPipe) id: string,
    // A real (empty) DTO class, declared and ignored. Without a class the
    // global pipe has nothing to validate against and would accept a rewritten
    // submission silently; with one, any property at all is refused.
    @Body() _body: RetryIntakeDto,
  ): Promise<IntakeRetryResponse> {
    return this.operations.retry(id);
  }
}
