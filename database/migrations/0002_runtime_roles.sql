-- Separação de privilégios para a alegação "append-only" não depender
-- apenas de triggers (o owner do banco pode desabilitar triggers).
--
--   integra_admin   → aplica migrations (CREATE/ALTER), owner das tabelas
--   integra_runtime → aplicação operacional; em evento_auditoria somente
--                     INSERT + SELECT; sem UPDATE/DELETE/TRUNCATE/REFERENCES/
--                     TRIGGER; nunca BYPASSRLS nem CREATEROLE
--
-- A CI valida estes privilégios contra PostgreSQL 16 (has_table_privilege).

BEGIN;

DO $$
DECLARE
  runtime_role_name text := 'integra_runtime';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role_name) THEN
    -- NOLOGIN: a senha/credencial de runtime é emitida pelo operador do
    -- ambiente (gerenciador de segredos), nunca versionada no repositório.
    -- NOINHERIT evita herança acidental; sem CREATEROLE/CREATEDB/BYPASSRLS.
    CREATE ROLE integra_runtime NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Runtime lê e grava evidências de auditoria, mas jamais as altera:
-- sem UPDATE, DELETE, TRUNCATE, REFERENCES ou TRIGGER.
GRANT USAGE ON SCHEMA public TO integra_runtime;
GRANT SELECT, INSERT ON evento_auditoria TO integra_runtime;
GRANT SELECT ON evento_auditoria_sequencia_seq TO integra_runtime;

COMMIT;
