import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type EmailAssetView, type EmailTemplateView } from '@leadflow/api-types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { userActor } from '../../../common/audit/mutation-actor';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { MAX_EMAIL_ASSET_BYTES, TemplatesService, type UploadedAsset } from './templates.service';
import { SaveTemplateDto, UploadAssetDto } from './dto/templates.dto';

/** The template library and campaign attachments (catalogues, brochures). */
@ApiTags('email')
@Controller('email')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('templates')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  async list(@Query('includeArchived') includeArchived?: string): Promise<EmailTemplateView[]> {
    return this.templates.list(includeArchived === 'true');
  }

  @Post('templates')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  @ApiOperation({
    summary: 'Create a template. HTML is sanitized; unknown merge fields are refused.',
  })
  async create(
    @Body() dto: SaveTemplateDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailTemplateView> {
    return this.templates.create(dto, userActor(principal));
  }

  @Put('templates/:id')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveTemplateDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailTemplateView> {
    return this.templates.update(id, dto, userActor(principal));
  }

  @Post('templates/:id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailTemplateView> {
    return this.templates.setArchived(id, true, userActor(principal));
  }

  @Post('templates/:id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailTemplateView> {
    return this.templates.setArchived(id, false, userActor(principal));
  }

  @Get('assets')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  async assets(): Promise<EmailAssetView[]> {
    return this.templates.assets();
  }

  @Post('assets')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_EMAIL_ASSET_BYTES, files: 1 } }),
  )
  @ApiOperation({
    summary: 'Upload a PDF, PNG or JPEG attachment (≤ 5 MB), optionally linked to a product',
  })
  async upload(
    @UploadedFile() file: UploadedAsset | undefined,
    @Body() dto: UploadAssetDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailAssetView> {
    return this.templates.upload(file, dto.productId, userActor(principal));
  }

  @Delete('assets/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  async deleteAsset(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<void> {
    await this.templates.deleteAsset(id, userActor(principal));
  }
}
