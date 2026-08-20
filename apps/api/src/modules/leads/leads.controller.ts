import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type Paginated } from '@idea001/api-types';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { LeadsService, type LeadSummary } from './leads.service';
import { ListLeadsDto } from './dto/leads.dto';

/**
 * Phase 1 exposes leads READ-ONLY.
 *
 * The purpose is to prove tenant isolation against a real business table rather
 * than only against identity tables, which have special-case handling. Creating,
 * updating and assigning leads — with duplicate detection and status transition
 * rules — is Phase 2.
 */
@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'List leads in the current organization' })
  async list(@Query() dto: ListLeadsDto): Promise<Paginated<LeadSummary>> {
    return this.leads.list(dto);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Get one lead with its activity timeline' })
  async findOne(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.leads.findOne(id);
  }
}
