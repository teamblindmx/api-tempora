/*
  Warnings:

  - The primary key for the `site` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `axeda_site_id` on the `site` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `site` table. All the data in the column will be lost.

*/

-- Las sedes ahora viven en Axeda (alpha.2) y app.site guarda solo los datos de Tempora de cada una,
-- con el id de la sede de Axeda como llave. Las filas anteriores (antes de alpha.2) no tienen sede en
-- Axeda: en una base de desarrollo, vacía app.site antes de migrar si tenía datos.
-- La tabla se modifica (no se recrea), así que RLS, FORCE, la política y los permisos se conservan.
-- DropForeignKey
ALTER TABLE "app"."employee_profile" DROP CONSTRAINT "employee_profile_site_id_company_id_fkey";

-- DropIndex
DROP INDEX "app"."site_axeda_site_id_key";

-- AlterTable
ALTER TABLE "app"."employee_profile" ALTER COLUMN "site_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "app"."site" DROP CONSTRAINT "site_pkey",
DROP COLUMN "axeda_site_id",
DROP COLUMN "name",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "site_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "app"."employee_profile" ADD CONSTRAINT "employee_profile_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
