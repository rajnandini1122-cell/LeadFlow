-- -----------------------------------------------------------------------------
-- Profile pictures.
--
-- A separate table rather than a column on `users`: Prisma selects every scalar
-- by default, so a bytea on `users` would mean any query missing an explicit
-- `select` quietly loaded an image per row. Here the bytes are read only by the
-- endpoint that serves them.
--
-- Additive only: one new table. Nothing existing is altered, so this cannot
-- fail against existing data and an existing database upgrades cleanly.
-- -----------------------------------------------------------------------------
CREATE TABLE "user_avatars" (
    "user_id" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "mime_type" VARCHAR(60) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_avatars_pkey" PRIMARY KEY ("user_id")
);

-- Cascade: removing a user removes their picture. There is nothing to keep.
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
