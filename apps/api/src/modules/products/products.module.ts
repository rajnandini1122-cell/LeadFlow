import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ProductsRepository } from './products.repository';
import { ProductKpiService } from './product-kpi.service';
import { ProductKpiRepository } from './product-kpi.repository';
import { ProductMappingService } from './product-mapping.service';
import { ProductMappingRepository } from './product-mapping.repository';

/**
 * Product master and product intelligence.
 *
 * Imports LeadsModule for the organization's timezone, which day-bucketing
 * needs — the same dependency the reports module takes, and for the same
 * reason. Nothing here reimplements lead visibility or lead access.
 *
 * `ProductsRepository` is exported so the leads module can validate a product
 * id when one is attached to a lead, through the same tenant-scoped query
 * rather than a second lookup that might not be scoped.
 */
@Module({
  imports: [LeadsModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    ProductsRepository,
    ProductKpiService,
    ProductKpiRepository,
    ProductMappingService,
    ProductMappingRepository,
  ],
  exports: [ProductsRepository],
})
export class ProductsModule {}
