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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ContactsService } from './contacts.service';
import {
  CreateContactDto,
  ListContactsDto,
  MergeContactsDto,
  UpdateContactDto,
} from './dto/contacts.dto';

/**
 * Contact endpoints.
 *
 * A contact is the person; a lead is one buying conversation with them. The
 * same person coming back six months later is a second lead on the same
 * contact, which is what makes their history survive a closed deal.
 *
 * Every permission here is enforced by the API. The web app hides what a user
 * cannot do, but hiding a button is presentation, not authorization.
 */
@ApiTags('contacts')
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CONTACT_VIEW)
  @ApiOperation({ summary: 'List contacts, newest first' })
  async list(@Query() dto: ListContactsDto) {
    return this.contacts.list({ search: dto.search, cursor: dto.cursor, limit: dto.limit });
  }

  /**
   * Declared before `:id`, or Nest's declaration-order matching would send
   * `/contacts/duplicates` into the `:id` route and fail UUID validation.
   */
  @Get('duplicates')
  @RequirePermissions(PERMISSIONS.CONTACT_UPDATE)
  @ApiOperation({
    summary: 'Duplicate clusters awaiting review',
    description:
      'Candidates only — nothing is merged automatically. Contacts are grouped ' +
      'by exact E.164 mobile or lowercased email; names and companies are ' +
      'deliberately not matched on, because a false positive here merges two ' +
      'real customers irreversibly.',
  })
  async duplicates() {
    return this.contacts.duplicateGroups();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CONTACT_UPDATE)
  @ApiOperation({ summary: 'Create a contact' })
  async create(@Body() dto: CreateContactDto, @CurrentUser() principal: TenantPrincipal) {
    return this.contacts.create(dto, principal);
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONTACT_MERGE)
  @ApiOperation({
    summary: 'Merge two contacts after explicit confirmation',
    description:
      'Moves every lead from source to target, keeps the source as a tombstone ' +
      'pointing at the target, and records the merge on each affected lead ' +
      'timeline. Nothing is deleted. Requires contact.merge, which is separate ' +
      'from contact.update because the operation cannot be undone.',
  })
  async merge(@Body() dto: MergeContactsDto, @CurrentUser() principal: TenantPrincipal) {
    return this.contacts.merge(dto, principal);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CONTACT_VIEW)
  @ApiOperation({ summary: 'Get one contact with every lead attached to it' })
  async findOne(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.contacts.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CONTACT_UPDATE)
  @ApiOperation({ summary: 'Update a contact' })
  async update(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: UpdateContactDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.contacts.update(id, dto, principal);
  }

  @Get(':id/duplicates')
  @RequirePermissions(PERMISSIONS.CONTACT_UPDATE)
  @ApiOperation({ summary: 'Candidate duplicates of one contact' })
  async duplicatesOf(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.contacts.duplicatesOf(id);
  }
}
