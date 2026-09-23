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
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  type TerritoryDetail,
  type TerritoryListItem,
  type TerritoryResolution,
} from '@leadflow/api-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { userActor } from '../../common/audit/mutation-actor';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { TerritoriesService } from './territories.service';
import {
  AddTerritoryCoverageDto,
  CreateTerritoryDto,
  ResolveTerritoryDto,
  UpdateTerritoryDto,
} from './dto/territories.dto';

/**
 * Territories: the geography routing is written against.
 *
 * There is no DELETE. A territory that once decided where enquiries went is
 * the explanation for why a customer reached the team they did; archiving
 * keeps that and stops it resolving.
 *
 * Read and manage are separate permissions. Redrawing which pincodes belong to
 * which territory changes where every future enquiry from those places lands,
 * which is a different power from being able to look at the map.
 */
@ApiTags('territories')
@Controller('territories')
export class TerritoriesController {
  constructor(private readonly territories: TerritoriesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TERRITORY_VIEW)
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiOperation({ summary: 'Territories, active first' })
  async list(@Query('includeArchived') includeArchived?: string): Promise<TerritoryListItem[]> {
    return this.territories.list(includeArchived === 'true');
  }

  /**
   * Where a location resolves to.
   *
   * Declared before `:id` so "resolve" is not read as a territory id. POST
   * because it takes a body; it writes nothing — no lead, no intake, no rule,
   * and no change to the coverage it read.
   */
  @Post('resolve')
  @RequirePermissions(PERMISSIONS.TERRITORY_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a location to a territory',
    description:
      'Read-only. Most specific configured selector wins: postal code, then city, then state, ' +
      'then country. Nothing is created, changed or assigned.',
  })
  async resolve(@Body() dto: ResolveTerritoryDto): Promise<TerritoryResolution> {
    return this.territories.preview(dto);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TERRITORY_VIEW)
  @ApiOperation({ summary: 'One territory, with the places it covers' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<TerritoryDetail> {
    return this.territories.findOne(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TERRITORY_MANAGE)
  @ApiOperation({ summary: 'Add a territory' })
  async create(
    @Body() dto: CreateTerritoryDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TerritoryDetail> {
    return this.territories.create(dto, userActor(principal));
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.TERRITORY_MANAGE)
  @ApiOperation({
    summary: 'Rename a territory, or archive and reactivate it',
    description:
      'Archiving is refused while active assignment rules route to it, and releases the places ' +
      'it covered so another territory may claim them.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTerritoryDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TerritoryDetail> {
    return this.territories.update(id, dto, userActor(principal));
  }

  @Post(':id/coverage')
  @RequirePermissions(PERMISSIONS.TERRITORY_MANAGE)
  @ApiOperation({
    summary: 'Cover a place',
    description:
      'One explicit selector — a country, a state, a city, or a postal code. A place has one ' +
      'live owner per organization; claiming one somebody else holds is refused and names them.',
  })
  async addCoverage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTerritoryCoverageDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TerritoryDetail> {
    return this.territories.addCoverage(id, dto, userActor(principal));
  }

  /**
   * Stops a place resolving here.
   *
   * POST .../remove rather than DELETE, following the team-member endpoint:
   * the row is kept, so this is a state change rather than a deletion, and
   * calling it DELETE would promise something it does not do. Explicit 200 —
   * Nest answers POST with 201 by default, which would claim something was
   * created.
   */
  @Post(':id/coverage/:coverageId/remove')
  @RequirePermissions(PERMISSIONS.TERRITORY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop covering a place',
    description:
      'Keeps the history, leaves the territory in place and changes no assignment rule — that ' +
      'selector simply no longer resolves here.',
  })
  async removeCoverage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('coverageId', ParseUUIDPipe) coverageId: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TerritoryDetail> {
    return this.territories.removeCoverage(id, coverageId, userActor(principal));
  }
}
