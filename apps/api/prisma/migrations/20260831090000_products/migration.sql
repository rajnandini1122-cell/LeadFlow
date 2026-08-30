-- -----------------------------------------------------------------------------
-- Product master, and the link from a lead to it.
--
-- A real table rather than a string on the lead, because a KPI needs IDENTITY.
-- Free text cannot be grouped — "Packaging line, 500 units/hr" and "packaging
-- line" are different strings for the same thing — and a renamed string would
-- silently rewrite history.
--
-- Additive only: one new table and one nullable column. `product_interest` is
-- untouched and keeps every existing value; the two coexist, with the product
-- as the grouping key and the free text as the enquiry detail.
-- -----------------------------------------------------------------------------
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "sku" VARCHAR(60) NOT NULL,
    "category" VARCHAR(80),
    "description" VARCHAR(1000),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- One SKU per tenant. Two products sharing a code would make the code useless
-- as an identifier and any future import ambiguous.
CREATE UNIQUE INDEX "products_organization_id_sku_key" ON "products"("organization_id", "sku");

-- The catalogue screen lists active products by name.
CREATE INDEX "products_organization_id_active_name_idx" ON "products"("organization_id", "active", "name");

ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- The lead's grouping key.
--
-- Nullable, and permanently so: every existing lead has none, an enquiry can
-- legitimately be for something not yet catalogued, and forcing a value would
-- mean guessing one. Backfill is a deliberate human decision — see the mapping
-- endpoint — not something this migration attempts.
-- -----------------------------------------------------------------------------
ALTER TABLE "leads" ADD COLUMN "product_id" UUID;

-- SET NULL, never CASCADE: removing a catalogue entry must not delete the
-- enquiries that referenced it. The free-text product_interest survives too, so
-- the lead still records what was actually wanted.
ALTER TABLE "leads" ADD CONSTRAINT "leads_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every product KPI groups by product within a tenant; most filter on status.
CREATE INDEX "leads_organization_id_product_id_status_idx"
  ON "leads"("organization_id", "product_id", "status");

-- Demand trend and won/lost aggregation are time-bucketed per product.
CREATE INDEX "leads_organization_id_product_id_created_at_idx"
  ON "leads"("organization_id", "product_id", "created_at");
