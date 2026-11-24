-- Semanas 5 y 6: retardos, justificaciones, horas extra, festivos y descansos, aviso de privacidad (ADR 0014).
-- La parte de abajo (CHECK, NULLS NOT DISTINCT, RLS y permisos) se escribió a mano.

-- AlterTable
ALTER TABLE "app"."attendance_record" ADD COLUMN     "check_in_code_expired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "check_in_late" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "check_in_late_minutes" INTEGER;

-- AlterTable
ALTER TABLE "app"."site" ADD COLUMN     "late_tolerance_min" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "rest_days" INTEGER[] DEFAULT ARRAY[0]::INTEGER[];

-- CreateTable
CREATE TABLE "app"."holiday" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "site_id" TEXT,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'custom',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."justification" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "attendance_record_id" UUID,
    "reason" TEXT NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_comment" TEXT,

    CONSTRAINT "justification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."overtime_authorization" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "until" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "authorized_by" TEXT NOT NULL,
    "authorized_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "overtime_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."privacy_acceptance" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "privacy_acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "holiday_company_id_date_idx" ON "app"."holiday"("company_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_company_id_site_id_date_key" ON "app"."holiday"("company_id", "site_id", "date");

-- CreateIndex
CREATE INDEX "justification_company_id_site_id_status_idx" ON "app"."justification"("company_id", "site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "justification_company_id_user_id_work_date_kind_key" ON "app"."justification"("company_id", "user_id", "work_date", "kind");

-- CreateIndex
CREATE INDEX "overtime_authorization_company_id_site_id_work_date_idx" ON "app"."overtime_authorization"("company_id", "site_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_authorization_company_id_user_id_work_date_key" ON "app"."overtime_authorization"("company_id", "user_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_acceptance_company_id_user_id_version_key" ON "app"."privacy_acceptance"("company_id", "user_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_record_id_company_id_key" ON "app"."attendance_record"("id", "company_id");

-- AddForeignKey
ALTER TABLE "app"."holiday" ADD CONSTRAINT "holiday_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."justification" ADD CONSTRAINT "justification_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."justification" ADD CONSTRAINT "justification_attendance_record_id_company_id_fkey" FOREIGN KEY ("attendance_record_id", "company_id") REFERENCES "app"."attendance_record"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."overtime_authorization" ADD CONSTRAINT "overtime_authorization_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Un solo festivo de compañía (sin sede) por fecha: con NULL normal, el índice único los dejaría repetir.
DROP INDEX "app"."holiday_company_id_site_id_date_key";
CREATE UNIQUE INDEX "holiday_company_id_site_id_date_key" ON "app"."holiday"("company_id", "site_id", "date") NULLS NOT DISTINCT;

-- Formas válidas (la API ya las valida; esto cubre cualquier otro camino).
ALTER TABLE app.site ADD CONSTRAINT site_late_tolerance CHECK (late_tolerance_min BETWEEN 0 AND 120);
-- Días 0 (domingo) a 6 (sábado), al menos un día laborable a la semana.
ALTER TABLE app.site ADD CONSTRAINT site_rest_days CHECK (
  rest_days IS NOT NULL AND rest_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6] AND cardinality(rest_days) <= 6
);
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_late_minutes
  CHECK (check_in_late_minutes IS NULL OR check_in_late_minutes >= 0);
-- La entrada tardía con código vencido la hace el trabajador, con código.
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_code_expired_self
  CHECK (NOT check_in_code_expired OR check_in_source = 'self');

ALTER TABLE app.holiday ADD CONSTRAINT holiday_source CHECK (source IN ('statutory', 'custom'));
ALTER TABLE app.holiday ADD CONSTRAINT holiday_name CHECK (length(trim(name)) > 0);

ALTER TABLE app.justification ADD CONSTRAINT justification_kind CHECK (kind IN ('late', 'early-exit', 'absence'));
ALTER TABLE app.justification ADD CONSTRAINT justification_reason CHECK (length(trim(reason)) >= 5);
-- Un retardo o una salida anticipada apuntan a su jornada; una falta no tiene jornada.
ALTER TABLE app.justification ADD CONSTRAINT justification_record CHECK (
  (kind = 'absence') = (attendance_record_id IS NULL)
);
ALTER TABLE app.justification ADD CONSTRAINT justification_status CHECK (
  (status = 'pending' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_comment IS NULL)
  OR (status = 'approved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  OR (status = 'rejected' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
      AND coalesce(length(trim(resolution_comment)), 0) > 0)
);
-- Nadie aprueba o rechaza su propia justificación.
ALTER TABLE app.justification ADD CONSTRAINT justification_not_self CHECK (resolved_by IS DISTINCT FROM user_id);

ALTER TABLE app.overtime_authorization ADD CONSTRAINT overtime_reason CHECK (length(trim(reason)) >= 5);
ALTER TABLE app.overtime_authorization ADD CONSTRAINT overtime_not_self CHECK (authorized_by <> user_id);
ALTER TABLE app.overtime_authorization ADD CONSTRAINT overtime_closed CHECK (
  (closed_at IS NULL) = (closed_by IS NULL)
);

ALTER TABLE app.privacy_acceptance ADD CONSTRAINT privacy_version CHECK (length(trim(version)) > 0);

-- Aislamiento por compañía, igual que el resto de las tablas de negocio.
ALTER TABLE app.holiday                ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.holiday                FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.justification          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.justification          FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.overtime_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.overtime_authorization FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.privacy_acceptance     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.privacy_acceptance     FORCE  ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON app.holiday
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
CREATE POLICY company_isolation ON app.justification
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
CREATE POLICY company_isolation ON app.overtime_authorization
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
CREATE POLICY company_isolation ON app.privacy_acceptance
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());

-- Los festivos son configuración: se borran (con auditoría). Justificaciones y autorizaciones son
-- evidencia: se actualizan (resolver, cerrar) pero no se borran. La aceptación del aviso es de solo
-- inserción.
GRANT SELECT, INSERT, DELETE ON app.holiday TO tempora_app;
GRANT SELECT, INSERT, UPDATE ON app.justification, app.overtime_authorization TO tempora_app;
GRANT SELECT, INSERT ON app.privacy_acceptance TO tempora_app;
