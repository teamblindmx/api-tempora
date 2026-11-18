-- Semana 2: código diario por sede, entrada con ubicación y salida.
-- La parte de abajo (CHECK, RLS y permisos) se escribió a mano: Prisma no modela políticas.

-- AlterTable
ALTER TABLE "app"."site" ADD COLUMN     "shift_end" TEXT,
ADD COLUMN     "shift_start" TEXT;

-- CreateTable
CREATE TABLE "app"."daily_code" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."attendance_record" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "check_in_at" TIMESTAMPTZ(3) NOT NULL,
    "check_in_latitude" DECIMAL(9,6),
    "check_in_longitude" DECIMAL(9,6),
    "check_in_accuracy_m" INTEGER,
    "check_in_distance_m" INTEGER,
    "daily_code_id" UUID NOT NULL,
    "check_out_at" TIMESTAMPTZ(3),
    "check_out_latitude" DECIMAL(9,6),
    "check_out_longitude" DECIMAL(9,6),
    "check_out_accuracy_m" INTEGER,
    "check_out_distance_m" INTEGER,
    "check_out_kind" TEXT,
    "check_out_reason" TEXT,
    "review_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_code_company_id_site_id_expires_at_idx" ON "app"."daily_code"("company_id", "site_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_code_id_company_id_key" ON "app"."daily_code"("id", "company_id");

-- CreateIndex
CREATE INDEX "attendance_record_company_id_site_id_work_date_idx" ON "app"."attendance_record"("company_id", "site_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_record_company_id_user_id_work_date_key" ON "app"."attendance_record"("company_id", "user_id", "work_date");

-- AddForeignKey
ALTER TABLE "app"."daily_code" ADD CONSTRAINT "daily_code_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."attendance_record" ADD CONSTRAINT "attendance_record_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."attendance_record" ADD CONSTRAINT "attendance_record_daily_code_id_company_id_fkey" FOREIGN KEY ("daily_code_id", "company_id") REFERENCES "app"."daily_code"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Formas válidas (la API ya las valida; esto cubre cualquier otro camino).
ALTER TABLE app.site ADD CONSTRAINT site_shift_format CHECK (
  (shift_start IS NULL) = (shift_end IS NULL)
  AND (shift_start IS NULL OR shift_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  AND (shift_end IS NULL OR shift_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
ALTER TABLE app.daily_code ADD CONSTRAINT daily_code_format CHECK (code ~ '^[0-9]{6}$');
ALTER TABLE app.daily_code ADD CONSTRAINT daily_code_window CHECK (expires_at >= created_at);
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_check_out_after_in
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at);
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_check_out_kind
  CHECK (check_out_kind IS NULL OR check_out_kind IN ('regular', 'early'));
-- Regla 6: la salida anticipada lleva motivo.
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_early_exit_reason
  CHECK (check_out_kind IS DISTINCT FROM 'early' OR coalesce(length(trim(check_out_reason)), 0) > 0);

-- Aislamiento por compañía, igual que el resto de las tablas de negocio.
ALTER TABLE app.daily_code        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.daily_code        FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.attendance_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_record FORCE  ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON app.daily_code
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
CREATE POLICY company_isolation ON app.attendance_record
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());

-- La API no borra códigos ni jornadas: son la evidencia del registro. UPDATE sirve para vencer un
-- código al generar otro y para registrar la salida.
GRANT SELECT, INSERT, UPDATE ON app.daily_code, app.attendance_record TO tempora_app;
