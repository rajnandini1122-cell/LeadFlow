import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { QualificationNoteDto, RefineLeadDto, RevertToRoughDto } from './lead-qualification.dto';
import { LeadQualificationService } from './lead-qualification.service';

const UUID7 = new ParseUUIDPipe({ version: '7' });

/** Rough -> Refined qualification. Same lead visibility everywhere. */
@ApiTags('leads')
@Controller('leads')
export class LeadQualificationController {
  constructor(private readonly qualification: LeadQualificationService) {}

  @Get(':id/qualification')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Rough or Refined, what refining still needs, and who refined it' })
  async view(@Param('id', UUID7) id: string, @CurrentUser() principal: TenantPrincipal) {
    return this.qualification.view(id, principal);
  }

  @Post(':id/qualification/notes')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Record qualification work on a Rough lead',
    description:
      'Research or a qualification call. Never schedules sales work and never refines the lead.',
  })
  async addNote(
    @Param('id', UUID7) id: string,
    @Body() dto: QualificationNoteDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.qualification.addNote(id, dto, principal);
  }

  @Post(':id/refine')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_QUALIFY)
  @ApiOperation({
    summary: 'Mark a Rough lead as Refined',
    description:
      'Needs a company, a contact with a phone or email, and businessFitConfirmed. Records who, when ' +
      'and the outcome; an assigned lead with nothing queued gets its first sales follow-up.',
  })
  async refine(
    @Param('id', UUID7) id: string,
    @Body() dto: RefineLeadDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.qualification.refine(id, dto, principal);
  }

  @Post(':id/revert-to-rough')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_QUALIFY)
  @ApiOperation({
    summary: 'Send a Refined lead back to Rough (reason required)',
    description: 'Follow-ups are kept but leave the sales queues until the lead is refined again.',
  })
  async revert(
    @Param('id', UUID7) id: string,
    @Body() dto: RevertToRoughDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.qualification.revert(id, dto, principal);
  }
}
