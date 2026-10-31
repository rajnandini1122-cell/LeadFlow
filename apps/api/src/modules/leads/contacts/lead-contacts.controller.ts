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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { AddLeadContactDto, UpdateLeadContactDto } from './lead-contacts.dto';
import { LeadContactsService } from './lead-contacts.service';

const UUID7 = new ParseUUIDPipe({ version: '7' });

/** Points of contact on a lead. Same visibility and permissions as the lead. */
@ApiTags('leads')
@Controller('leads')
export class LeadContactsController {
  constructor(private readonly contacts: LeadContactsService) {}

  @Get(':id/contacts')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'People to contact about this lead, primary first' })
  async list(@Param('id', UUID7) id: string, @CurrentUser() principal: TenantPrincipal) {
    return this.contacts.list(id, principal);
  }

  @Post(':id/contacts')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Add a point of contact',
    description:
      'A phone number already known to the organization links that existing person. ' +
      'Answers 409 DUPLICATE_CONTACT when someone at this lead or company shares the phone ' +
      'or email; resend with allowDuplicate to add anyway.',
  })
  async add(
    @Param('id', UUID7) id: string,
    @Body() dto: AddLeadContactDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.contacts.add(id, dto, principal);
  }

  @Patch(':id/contacts/:linkId')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Edit a point of contact (the person’s details apply wherever they appear)',
  })
  async update(
    @Param('id', UUID7) id: string,
    @Param('linkId', UUID7) linkId: string,
    @Body() dto: UpdateLeadContactDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.contacts.update(id, linkId, dto, principal);
  }

  @Post(':id/contacts/:linkId/primary')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Make this the primary contact (atomic)' })
  async setPrimary(
    @Param('id', UUID7) id: string,
    @Param('linkId', UUID7) linkId: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.contacts.setPrimary(id, linkId, principal);
  }

  @Post(':id/contacts/:linkId/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({
    summary: 'Mark a contact inactive; a primary is replaced by the longest-standing active one',
  })
  async deactivate(
    @Param('id', UUID7) id: string,
    @Param('linkId', UUID7) linkId: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.contacts.deactivate(id, linkId, principal);
  }

  @Post(':id/contacts/:linkId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Mark a contact active again' })
  async reactivate(
    @Param('id', UUID7) id: string,
    @Param('linkId', UUID7) linkId: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.contacts.reactivate(id, linkId, principal);
  }
}
