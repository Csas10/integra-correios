-- Separação de privilégios para a alegação "append-only" não depender
-- apenas de triggers (o owner do banco pode desabilitar triggers).
--
--   integra_admin     → login provisionado pelo ambiente; aplica migrations
--                       (CREATE/ALTER) e permanece owner das tabelas
--   integra_app_login → login provisionado pelo ambiente; recebe membership
--                       em integra_runtime e é usado na DATABASE_URL
--   integra_runtime   → role-grupo NOLOGIN de privilégios operacionais;
--                     nas tabelas de negócio: SELECT + INSERT + UPDATE;
--                     em evento_auditoria somente
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
    -- Role-grupo sem credencial. O login específico de cada ambiente é criado
    -- fora da migration, recebe GRANT integra_runtime e permanece no
    -- gerenciador de segredos. Sem CREATEROLE/CREATEDB/BYPASSRLS.
    CREATE ROLE integra_runtime NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = runtime_role_name
      AND (
        rolcanlogin OR rolinherit OR rolsuper OR rolcreaterole OR rolcreatedb OR
        rolreplication OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION
      'role existente % viola os atributos de segurança do runtime',
      runtime_role_name;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = runtime_role_name
  ) THEN
    -- integra_runtime pode ser concedida a logins, mas não pode herdar outra
    -- role: uma membership de saída ampliaria privilégios fora desta migration.
    RAISE EXCEPTION
      'role existente % não pode ser membro de outras roles',
      runtime_role_name;
  END IF;
END
$$;

-- Falha fechado caso a role já existisse com grants mais amplos.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM integra_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM integra_runtime;
REVOKE CREATE ON SCHEMA public FROM integra_runtime;
-- Privilégios são aditivos: remove CREATE de PUBLIC para que membership em
-- integra_runtime não possa ser contornado por um grant global legado.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO integra_runtime;

-- DML mínimo usado pelos repositórios operacionais. Exclusões são deliberadamente
-- ausentes: evidências e histórico não são removidos pelo runtime.
GRANT SELECT, INSERT, UPDATE ON
  arquivo_importacao,
  perfil_mapeamento,
  importacao,
  linha_importada,
  profissional,
  snapshot_cadastral,
  confirmacao,
  lote_comunicacao,
  comunicacao,
  oauth_connection,
  outbox_email,
  item_lote_comunicacao
TO integra_runtime;

-- Runtime lê e grava evidências de auditoria, mas jamais as altera:
-- sem UPDATE, DELETE, TRUNCATE, REFERENCES ou TRIGGER.
GRANT SELECT, INSERT ON evento_auditoria TO integra_runtime;
GRANT USAGE, SELECT ON SEQUENCE evento_auditoria_sequencia_seq TO integra_runtime;

-- F18 — Binding one-time do fluxo OAuth. A tabela nasce na migration 0004,
-- que pode ser aplicada antes OU depois desta re-execução (o REVOKE ALL
-- acima zera TODAS as tabelas): o grant é condicional à existência para que
-- qualquer ordem de aplicação/restauração reconverja para o estado válido.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'oauth_flow'
  ) THEN
    GRANT SELECT, INSERT, UPDATE ON oauth_flow TO integra_runtime;
  END IF;
END
$$;

-- Provisionamento fora do Git (exemplo sem credencial):
--   CREATE ROLE integra_app_login LOGIN ...;
--   GRANT integra_runtime TO integra_app_login;
-- A DATABASE_URL usa integra_app_login, nunca integra_runtime (NOLOGIN).

COMMIT;
