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
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ProductsService } from './products.service';
import { ProductKpiService } from './product-kpi.service';
import { ProductMappingService } from './product-mapping.service';
import { resolveDateRange, DateRangeError } from '../reports/date-range';
import { AppException } from '../../common/errors/app.exception';
import {
  CreateProductDto,
  ListProductsDto,
  MapLeadsToProductDto,
  ProductRangeDto,
  UnmappedLeadsDto,
  UpdateProductDto,
} from './dto/products.dto';

/**
 * Product master and product intelligence.
 *
 * Permissions reuse the existing catalogue rather than inventing a product
 * pair, and the split follows what each action actually is:
 *
 *   - READING the catalogue is `org.view`, which every role holds. A sales rep
 *     has to pick a product when creating a lead, so anything narrower would
 *     break lead creation for the people who do most of it.
 *   - MANAGING it is `org.update`. A product list is organization
 *     configuration, exactly like the lead sources it sits beside.
 *   - KPIs are `report.view`, matching the reports module.
 *
 * The KPI figures themselves are additionally narrowed by the caller's own lead
 * visibility, so a rep sees product numbers over their own leads rather than
 * the organization's.
 */
@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly kpi: ProductKpiService,
    private readonly mapping: ProductMappingService,
  ) {}

  // --- catalogue -------------------------------------------------------------

  @Get()
  @RequirePermissions(PERMISSIONS.ORG_VIEW)
  @ApiOperation({ summary: 'The product catalogue' })
  async list(@Query() query: ListProductsDto) {
    return this.products.list(query);
  }

  @Get('categories')
  @RequirePermissions(PERMISSIONS.ORG_VIEW)
  @ApiOperation({ summary: 'Categories in use, for filtering' })
  async categories() {
    return { categories: await this.products.categories() };
  }

  // --- intelligence ----------------------------------------------------------
  //
  // Declared BEFORE the ':id' routes. Express matches in order, so 'kpi' would
  // otherwise be read as a product id and fail the UUID pipe.

  @Get('kpi/performance')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Full KPI row per product' })
  async performance(@Query() query: ProductRangeDto, @CurrentUser() principal: TenantPrincipal) {
    // A range is optional here: without one the figures are all-time and the
    // trend column is simply absent rather than invented.
    const range = query.preset || query.from ? await this.resolveRange(query) : undefined;
    return this.kpi.performance(principal, range);
  }

  @Get('kpi/trend')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Leads per product per day' })
  async trend(@Query() query: ProductRangeDto, @CurrentUser() principal: TenantPrincipal) {
    const range = await this.resolveRange(query);
    return this.kpi.demandTrendSeries(principal, range);
  }

  @Get('kpi/by-source')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Product against lead source' })
  async bySource(@CurrentUser() principal: TenantPrincipal) {
    return this.kpi.bySource(principal);
  }

  @Get('kpi/by-agent')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Product against assigned salesperson' })
  async byAgent(@CurrentUser() principal: TenantPrincipal) {
    return this.kpi.byAgent(principal);
  }

  @Get('kpi/loss-analysis')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Why deals are lost, per product' })
  async lossAnalysis(@CurrentUser() principal: TenantPrincipal) {
    return this.kpi.lossAnalysis(principal);
  }

  // --- backfill --------------------------------------------------------------

  @Get('mapping/progress')
  @RequirePermissions(PERMISSIONS.ORG_VIEW)
  @ApiOperation({ summary: 'How many leads still have no product' })
  async mappingProgress(@CurrentUser() principal: TenantPrincipal) {
    return this.kpi.mappingProgress(principal);
  }

  @Get('mapping/unmapped')
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Leads with no product yet' })
  async unmapped(@Query() query: UnmappedLeadsDto) {
    return this.mapping.unmapped(query);
  }

  @Get('mapping/suggestions/:leadId')
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Products whose name appears in a lead’s enquiry text' })
  async suggestions(@Param('leadId', new ParseUUIDPipe({ version: '7' })) leadId: string) {
    return this.mapping.suggestions(leadId);
  }

  @Post('mapping/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Attach a product to leads a person has chosen' })
  async assign(@Body() dto: MapLeadsToProductDto, @CurrentUser() principal: TenantPrincipal) {
    return this.mapping.assign(dto, principal);
  }

  // --- one product -----------------------------------------------------------

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ORG_VIEW)
  @ApiOperation({ summary: 'One product' })
  async findOne(@Param('id', new ParseUUIDPipe({ version: '7' })) id: string) {
    return this.products.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Add a product to the catalogue' })
  async create(@Body() dto: CreateProductDto, @CurrentUser() principal: TenantPrincipal) {
    return this.products.create(dto, principal);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Edit a product' })
  async update(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.products.update(id, dto, principal);
  }

  /**
   * Retires a product.
   *
   * DELETE, but only ever a real delete for one that has never been used. Once
   * a product has leads it is deactivated instead, because removing it would
   * take it out of historical reporting as well as the offering. The response
   * says which happened.
   */
  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Deactivate a product, or delete one never used' })
  async deactivate(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.products.deactivate(id, principal);
  }

  private async resolveRange(query: ProductRangeDto) {
    const timezone = await this.kpi.organizationTimezone();

    try {
      const range = resolveDateRange(query, timezone);
      return { from: range.from, to: range.to, timezone: range.timezone };
    } catch (error) {
      if (error instanceof DateRangeError) {
        throw AppException.validation(error.message, { range: [error.message] });
      }
      throw error;
    }
  }
}
