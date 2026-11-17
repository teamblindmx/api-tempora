-- Aislamiento por compañía con Row Level Security y auditoría de solo inserción.
-- Escrita a mano (prisma migrate dev --create-only): Prisma no modela políticas ni triggers.
-- Patrón verificado en la prueba de concepto de RLS con Prisma 7.

-- Compañía de la transacción actual, fijada por la API con set_config('app.company_id', $1, true).
-- NULL si no se fijó, así que sin contexto no coincide nada (falla cerrado). NULLIF cubre el caso de
-- una conexión reutilizada: al terminar la transacción, current_setting devuelve '' y no NULL.
CREATE FUNCTION app.current_company_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.company_id', true), '') $$;

-- ENABLE + FORCE en cada tabla de negocio. FORCE hace que el dueño tampoco la salte.
ALTER TABLE app.site             ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.site             FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.employee_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.employee_profile FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.audit_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log        FORCE  ROW LEVEL SECURITY;

-- USING filtra lo que se lee, actualiza y borra; WITH CHECK impide insertar o mover filas a otra compañía.
CREATE POLICY company_isolation ON app.site
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
CREATE POLICY company_isolation ON app.employee_profile
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
CREATE POLICY company_isolation ON app.audit_log
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());

-- Auditoría de solo inserción, también para el dueño: ni UPDATE, ni DELETE, ni TRUNCATE.
CREATE FUNCTION app.audit_log_is_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción (% no permitido)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_is_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON app.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_is_append_only();

-- Permisos del rol de la API: solo datos, nunca DDL. En audit_log, solo SELECT e INSERT.
GRANT USAGE ON SCHEMA app TO tempora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.site, app.employee_profile TO tempora_app;
GRANT SELECT, INSERT ON app.audit_log TO tempora_app;
GRANT USAGE ON SEQUENCE app.audit_log_id_seq TO tempora_app;
GRANT EXECUTE ON FUNCTION app.current_company_id() TO tempora_app;
-- Ojo: no hay ALTER DEFAULT PRIVILEGES a propósito. Cada tabla nueva concede sus permisos y crea su
-- política en su propia migración; la prueba de catálogo lo vigila.
