-- 0004 — F18: binding one-time do fluxo OAuth em PostgreSQL (serverless-safe).
--
-- Motivação: OauthBindingStore em Map/Set por processo não sobrevive a START
-- (instância A) → CALLBACK (instância B) em Vercel serverless. O binding
-- passa a ser persistido:
--   nonce_hash (SHA-256 do nonce) — o nonce BRUTO nunca é persistido;
--   expira_em — TTL curto (600 s) verificado server-side;
--   consumida_em — consumo one-time atômico (UPDATE ... RETURNING).
--
-- Justificativa de PostgreSQL (vs. cookie stateless): o one-time REAL do
-- binding exige estado compartilhado entre instâncias — um cookie não
-- garante consumo único entre A e B; a corrida de callbacks simultâneos
-- precisa de atomicidade transacional, que o banco fornece nativamente.
--
-- Idempotente: re-execução é inofensiva (IF NOT EXISTS / DO $$ condicional).
-- Nenhum dado existente é alterado.

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_flow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_hash CHAR(64) NOT NULL
    CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  expira_em TIMESTAMPTZ NOT NULL,
  consumida_em TIMESTAMPTZ,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_flow_consumida_expira_check CHECK (
    consumida_em IS NULL OR consumida_em <= expira_em
  )
);

-- Consumo one-time atômico: UPDATE com RETURNING vence exatamente uma vez
-- mesmo sob corrida (row lock implícito no UPDATE concorrente).
CREATE INDEX IF NOT EXISTS oauth_flow_nonce_hash_idx
  ON oauth_flow (nonce_hash);

-- Higiene de bindings antigos (a checagem funcional usa expira_em/consumida_em).
CREATE INDEX IF NOT EXISTS oauth_flow_expira_em_idx
  ON oauth_flow (expira_em);

-- Privilégios do runtime (aplicados apenas quando a role já existir — ex.:
-- reexecução da migration em ambiente já provisionado por 0002):
-- INSERT (START), SELECT (diagnóstico) e UPDATE (consumo atômico).
-- DELETE/TRUNCATE/REFERENCES/TRIGGER permanecem ausentes deliberadamente:
-- evidências de binding não são removidas pelo runtime (append-only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'integra_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON oauth_flow TO integra_runtime;
  END IF;
END
$$;

COMMIT;
