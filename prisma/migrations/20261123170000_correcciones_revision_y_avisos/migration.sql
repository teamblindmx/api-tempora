-- Semana 7: corrección de horas, revisión de jornadas "por revisar" y avisos al líder (ADR 0015).
-- La parte de abajo (CHECK, RLS y permisos) se escribió a mano.
-- AlterTable
ALTER TABLE "app"."attendance_record" ADD COLUMN     "corrected_at" TIMESTAMPTZ(3),
ADD COLUMN     "corrected_by" TEXT,
ADD COLUMN     "review_comment" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" TEXT,
ADD COLUMN     "reviewed_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "app"."attendance_correction" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "attendance_record_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "corrected_by" TEXT NOT NULL,
    "corrected_at" TIMESTAMPTZ(3) NOT NULL,
    "check_in_before" TIMESTAMPTZ(3) NOT NULL,
    "check_in_after" TIMESTAMPTZ(3) NOT NULL,
    "check_out_before" TIMESTAMPTZ(3),
    "check_out_after" TIMESTAMPTZ(3),
    "comment" TEXT NOT NULL,

    CONSTRAINT "attendance_correction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."notice" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "attendance_record_id" UUID,
    "justification_id" UUID,
    "detail" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "read_by" TEXT,

    CONSTRAINT "notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_correction_company_id_attendance_record_id_idx" ON "app"."attendance_correction"("company_id", "attendance_record_id");

-- CreateIndex
CREATE INDEX "notice_company_id_site_id_read_at_idx" ON "app"."notice"("company_id", "site_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "justification_id_company_id_key" ON "app"."justification"("id", "company_id");

-- AddForeignKey
ALTER TABLE "app"."attendance_correction" ADD CONSTRAINT "attendance_correction_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."attendance_correction" ADD CONSTRAINT "attendance_correction_attendance_record_id_company_id_fkey" FOREIGN KEY ("attendance_record_id", "company_id") REFERENCES "app"."attendance_record"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."notice" ADD CONSTRAINT "notice_site_id_company_id_fkey" FOREIGN KEY ("site_id", "company_id") REFERENCES "app"."site"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."notice" ADD CONSTRAINT "notice_attendance_record_id_company_id_fkey" FOREIGN KEY ("attendance_record_id", "company_id") REFERENCES "app"."attendance_record"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."notice" ADD CONSTRAINT "notice_justification_id_company_id_fkey" FOREIGN KEY ("justification_id", "company_id") REFERENCES "app"."justification"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Formas válidas (la API ya las valida; esto cubre cualquier otro camino).
-- Revisar: quién y cuándo van juntos; solo se revisan motivos que existen; nadie revisa la suya.
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_reviewed CHECK (
  (reviewed_at IS NULL) = (reviewed_by IS NULL)
  AND (reviewed_at IS NOT NULL OR cardinality(coalesce(reviewed_reasons, '{}')) = 0)
  AND coalesce(reviewed_reasons, '{}') <@ coalesce(review_reasons, '{}')
);
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_corrected CHECK (
  (corrected_at IS NULL) = (corrected_by IS NULL)
);
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_review_correct_not_self CHECK (
  reviewed_by IS DISTINCT FROM user_id AND corrected_by IS DISTINCT FROM user_id
);

ALTER TABLE app.attendance_correction ADD CONSTRAINT correction_comment CHECK (length(trim(comment)) >= 5);
ALTER TABLE app.attendance_correction ADD CONSTRAINT correction_not_self CHECK (corrected_by <> user_id);
-- Toda corrección cambia algo, y la salida nunca queda antes de la entrada.
ALTER TABLE app.attendance_correction ADD CONSTRAINT correction_changes CHECK (
  check_in_before IS DISTINCT FROM check_in_after OR check_out_before IS DISTINCT FROM check_out_after
);
ALTER TABLE app.attendance_correction ADD CONSTRAINT correction_order CHECK (
  check_out_after IS NULL OR check_out_after >= check_in_after
);
-- Se corrige una salida que existe; agregarla es el marcado manual (ADR 0013).
ALTER TABLE app.attendance_correction ADD CONSTRAINT correction_exit_exists CHECK (
  (check_out_before IS NULL) = (check_out_after IS NULL)
);

ALTER TABLE app.notice ADD CONSTRAINT notice_kind CHECK (kind IN ('attendance-review', 'justification'));
-- Un aviso de jornada apunta a su jornada; uno de justificación, a su justificación.
ALTER TABLE app.notice ADD CONSTRAINT notice_target CHECK (
  (kind = 'attendance-review' AND attendance_record_id IS NOT NULL AND justification_id IS NULL)
  OR (kind = 'justification' AND justification_id IS NOT NULL)
);
ALTER TABLE app.notice ADD CONSTRAINT notice_read CHECK ((read_at IS NULL) = (read_by IS NULL));
-- A lo más un aviso pendiente por jornada: una salida que agrega motivos actualiza el que ya hay.
CREATE UNIQUE INDEX notice_one_open_per_record ON app.notice (company_id, attendance_record_id)
  WHERE read_at IS NULL AND kind = 'attendance-review';

-- Aislamiento por compañía, igual que el resto de las tablas de negocio.
ALTER TABLE app.attendance_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_correction FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.notice                ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notice                FORCE  ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON app.attendance_correction
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
CREATE POLICY company_isolation ON app.notice
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());

-- El historial de correcciones es de solo inserción. Los avisos se marcan como atendidos (UPDATE),
-- pero no se borran.
GRANT SELECT, INSERT ON app.attendance_correction TO tempora_app;
GRANT SELECT, INSERT, UPDATE ON app.notice TO tempora_app;
