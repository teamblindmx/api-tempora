-- Semana 3: marcado manual del líder, distinguible del que hace el trabajador (ADR 0013).
-- La parte de abajo (relleno y CHECK) se escribió a mano.

-- AlterTable
ALTER TABLE "app"."attendance_record" ADD COLUMN     "check_in_by" TEXT,
ADD COLUMN     "check_in_comment" TEXT,
ADD COLUMN     "check_in_source" TEXT NOT NULL DEFAULT 'self',
ADD COLUMN     "check_out_by" TEXT,
ADD COLUMN     "check_out_comment" TEXT,
ADD COLUMN     "check_out_source" TEXT,
ALTER COLUMN "daily_code_id" DROP NOT NULL;

-- Salidas ya registradas (semana 2): todas las hizo el trabajador. RLS está forzado también para el
-- dueño, así que sin compañía fijada el UPDATE no vería ninguna fila: se quita FORCE solo durante el
-- relleno, dentro de la transacción de la migración.
ALTER TABLE app.attendance_record NO FORCE ROW LEVEL SECURITY;
UPDATE app.attendance_record SET check_out_source = 'self' WHERE check_out_at IS NOT NULL;
ALTER TABLE app.attendance_record FORCE ROW LEVEL SECURITY;

-- Entrada: la del trabajador lleva código; la manual, autor y comentario, y no lleva código.
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_check_in_source CHECK (
  (check_in_source = 'self' AND daily_code_id IS NOT NULL AND check_in_by IS NULL AND check_in_comment IS NULL)
  OR (check_in_source = 'manual' AND daily_code_id IS NULL AND check_in_by IS NOT NULL
      AND coalesce(length(trim(check_in_comment)), 0) > 0)
);
-- Salida: hay origen si y solo si hay salida; la manual, con autor y comentario. coalesce: un CHECK
-- que da NULL pasa, así que ninguna rama puede quedar en NULL.
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_check_out_source CHECK (
  (check_out_at IS NULL AND check_out_source IS NULL AND check_out_by IS NULL AND check_out_comment IS NULL)
  OR (check_out_at IS NOT NULL AND coalesce(check_out_source, '') = 'self'
      AND check_out_by IS NULL AND check_out_comment IS NULL)
  OR (check_out_at IS NOT NULL AND coalesce(check_out_source, '') = 'manual' AND check_out_by IS NOT NULL
      AND coalesce(length(trim(check_out_comment)), 0) > 0)
);
-- Nadie se marca a sí mismo a mano: eso saltaría el código y la ubicación.
ALTER TABLE app.attendance_record ADD CONSTRAINT attendance_manual_not_self CHECK (
  check_in_by IS DISTINCT FROM user_id AND check_out_by IS DISTINCT FROM user_id
);

-- Para el calendario del trabajador y la exportación por rango de fechas.
CREATE INDEX attendance_record_company_id_work_date_idx ON app.attendance_record (company_id, work_date);
