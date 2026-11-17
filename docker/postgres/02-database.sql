-- Base de desarrollo. La de pruebas la crea test/global-setup.ts con el mismo procedimiento.
SELECT 'CREATE DATABASE tempora OWNER tempora_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tempora') \gexec

\connect tempora
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION tempora_auth;
-- app la crea la primera migración de Prisma, a nombre de tempora_owner.
