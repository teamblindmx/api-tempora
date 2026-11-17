-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "app";

-- CreateTable
CREATE TABLE "app"."site" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "business_id" TEXT,
    "axeda_site_id" TEXT,
    "name" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "radius_m" INTEGER NOT NULL DEFAULT 500,
    "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."employee_profile" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "site_id" UUID,
    "department" TEXT,
    "position" TEXT,
    "photo_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."audit_log" (
    "id" BIGSERIAL NOT NULL,
    "company_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_axeda_site_id_key" ON "app"."site"("axeda_site_id");

-- CreateIndex
CREATE INDEX "site_company_id_idx" ON "app"."site"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_id_company_id_key" ON "app"."site"("id", "company_id");

-- CreateIndex
CREATE INDEX "employee_profile_company_id_idx" ON "app"."employee_profile"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profile_company_id_user_id_key" ON "app"."employee_profile"("company_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_log_company_id_occurred_at_idx" ON "app"."audit_log"("company_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "app"."employee_profile" ADD CONSTRAINT "employee_profile_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
