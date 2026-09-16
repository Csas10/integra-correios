\set ON_ERROR_STOP on

-- Valida, contra PostgreSQL 16, os privilégios da role de runtime sobre
-- evento_auditoria e o encapsulamento do runtime (sem superuser/createrole).

BEGIN;
DO $$
DECLARE
  runtime_role text := 'integra_runtime';
  owner_role text;
  priv text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'role % não existe — aplique 0002_runtime_roles.sql', runtime_role;
  END IF;

  SELECT tableowner INTO owner_role FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'evento_auditoria';

  -- Privilégios exigidos
  IF NOT has_table_privilege(runtime_role, 'public.evento_auditoria', 'INSERT') THEN
    RAISE EXCEPTION 'runtime deve ter INSERT em evento_auditoria';
  END IF;
  IF NOT has_table_privilege(runtime_role, 'public.evento_auditoria', 'SELECT') THEN
    RAISE EXCEPTION 'runtime deve ter SELECT em evento_auditoria';
  END IF;

  -- Privilégios proibidos
  FOR priv IN SELECT unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
  LOOP
    IF has_table_privilege(runtime_role, 'public.evento_auditoria', priv) THEN
      RAISE EXCEPTION 'runtime não pode ter % em evento_auditoria', priv;
    END IF;
  END LOOP;

  -- Runtime nunca é owner nem role privilegiada
  IF owner_role = runtime_role THEN
    RAISE EXCEPTION 'runtime não pode ser owner de evento_auditoria';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = runtime_role
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'runtime não pode ser superuser/createrole/createdb/bypassrls/login';
  END IF;
END
$$;

-- Comportamento em runtime: INSERT ok, UPDATE/DELETE bloqueados por trigger
SET ROLE integra_runtime;

INSERT INTO evento_auditoria (
  id, agregado_tipo, agregado_id, tipo, ocorreu_em, hash_evento
) VALUES (
  '60000000-0000-4000-8000-000000000001', 'TESTE_ROLES', '60000000-0000-4000-8000-000000000002',
  'TESTE_SINTETICO', now(), repeat('8', 64)
);

DO $$
BEGIN
  UPDATE evento_auditoria SET tipo = 'MUTADO'
  WHERE id = '60000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'UPDATE em runtime deveria ser bloqueado';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN raise_exception THEN
    IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
END $$;

DO $$
BEGIN
  DELETE FROM evento_auditoria
  WHERE id = '60000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'DELETE em runtime deveria ser bloqueado';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN raise_exception THEN
    IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
END $$;

RESET ROLE;
ROLLBACK;
