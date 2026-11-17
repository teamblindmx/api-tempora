-- Roles de Tempora. Corre una vez por servidor (Docker lo ejecuta al crear el volumen; en CI y en
-- una instalación local se corre con psql como superusuario). Las contraseñas son de desarrollo:
-- en producción se cambian.
--
--   tempora_owner  Dueño del esquema app. Solo corre migraciones de Prisma. CREATEDB para la base
--                  sombra de `prisma migrate dev` y para la base temporal de las pruebas.
--   tempora_app    El que usa la API para los datos de Tempora. No es dueño de nada, no salta RLS.
--   tempora_auth   Dueño del esquema auth (Better Auth y Axeda). No tiene acceso al esquema app.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tempora_auth') THEN
    CREATE ROLE tempora_auth LOGIN PASSWORD 'auth' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tempora_owner') THEN
    CREATE ROLE tempora_owner LOGIN PASSWORD 'owner' NOSUPERUSER NOBYPASSRLS CREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tempora_app') THEN
    CREATE ROLE tempora_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- El dueño crea el esquema auth a nombre de tempora_auth al preparar cada base (ver 02-database.sql).
GRANT tempora_auth TO tempora_owner;
