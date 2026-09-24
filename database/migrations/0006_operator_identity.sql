-- 0006 — Identidade operacional individual para a Campanha PF.
-- Não habilita importação, lote, outbox, worker ou Gmail.
--
-- Esta migration permaneceu restrita ao PostgreSQL efêmero da CI durante
-- a PR #12. O vínculo sessão → token → mesmo operador é portanto corrigido
-- diretamente aqui, antes de qualquer promoção para ambiente persistente.

BEGIN;

CREATE TABLE IF NOT EXISTS operador (
  id UUID PRIMARY KEY,
  codigo VARCHAR(80) NOT NULL UNIQUE CHECK (btrim(codigo) <> ''),
  nome_exibicao VARCHAR(160) NOT NULL CHECK (btrim(nome_exibicao) <> ''),
  status VARCHAR(16) NOT NULL CHECK (status IN ('ATIVO', 'SUSPENSO')),
  criado_em TIMESTAMPTZ NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL,
  suspenso_em TIMESTAMPTZ,
  CHECK (
    (status = 'ATIVO' AND suspenso_em IS NULL) OR
    (status = 'SUSPENSO' AND suspenso_em IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS operador_papel (
  operator_id UUID NOT NULL REFERENCES operador(id) ON DELETE RESTRICT,
  papel VARCHAR(32) NOT NULL CHECK (
    papel IN ('PREPARADOR', 'REVISOR', 'APROVADOR', 'EXECUTOR', 'SUPERVISOR', 'ADMIN_TECNICO')
  ),
  ativo BOOLEAN NOT NULL DEFAULT true,
  concedido_em TIMESTAMPTZ NOT NULL,
  revogado_em TIMESTAMPTZ,
  PRIMARY KEY (operator_id, papel),
  CHECK (
    (ativo = true AND revogado_em IS NULL) OR
    (ativo = false AND revogado_em IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS operador_token (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operador(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}
  criado_em TIMESTAMPTZ NOT NULL,
  expira_em TIMESTAMPTZ,
  revogado_em TIMESTAMPTZ,
  CHECK (expira_em IS NULL OR expira_em > criado_em),
  CHECK (
    (status = 'ATIVO' AND revogado_em IS NULL) OR
    (status = 'REVOGADO' AND revogado_em IS NOT NULL)
  ),
  UNIQUE (id, operator_id)
);

CREATE INDEX IF NOT EXISTS operador_token_operator_status_idx
  ON operador_token (operator_id, status);

CREATE TABLE IF NOT EXISTS operador_sessao (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operador(id) ON DELETE RESTRICT,
  token_id UUID NOT NULL,
  session_hash CHAR(64) NOT NULL UNIQUE CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  status VARCHAR(16) NOT NULL CHECK (status IN ('ATIVA', 'REVOGADA')),
  criada_em TIMESTAMPTZ NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL,
  revogada_em TIMESTAMPTZ,
  CHECK (expira_em > criada_em),
  CHECK (
    (status = 'ATIVA' AND revogada_em IS NULL) OR
    (status = 'REVOGADA' AND revogada_em IS NOT NULL)
  ),
  CONSTRAINT operador_sessao_token_operator_fk
    FOREIGN KEY (token_id, operator_id)
    REFERENCES operador_token(id, operator_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS operador_sessao_operator_status_idx
  ON operador_sessao (operator_id, status, expira_em);

ALTER TABLE evento_auditoria
  ADD COLUMN IF NOT EXISTS operator_id UUID,
  ADD COLUMN IF NOT EXISTS ator_operator_id UUID;

DO $audit_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evento_auditoria_operator_fk'
  ) THEN
    ALTER TABLE evento_auditoria
      ADD CONSTRAINT evento_auditoria_operator_fk
      FOREIGN KEY (operator_id) REFERENCES operador(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evento_auditoria_actor_operator_fk'
  ) THEN
    ALTER TABLE evento_auditoria
      ADD CONSTRAINT evento_auditoria_actor_operator_fk
      FOREIGN KEY (ator_operator_id) REFERENCES operador(id) ON DELETE RESTRICT;
  END IF;
END
$audit_fk$;

CREATE INDEX IF NOT EXISTS evento_auditoria_operator_idx
  ON evento_auditoria (operator_id, sequencia)
  WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evento_auditoria_actor_operator_idx
  ON evento_auditoria (ator_operator_id, sequencia)
  WHERE ator_operator_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON
  operador,
  operador_papel,
  operador_token,
  operador_sessao
TO integra_runtime;

COMMIT;
),
  emitido_por_operator_id UUID NOT NULL REFERENCES operador(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL CHECK (status IN ('ATIVO', 'REVOGADO')),
  criado_em TIMESTAMPTZ NOT NULL,
  expira_em TIMESTAMPTZ,
  revogado_em TIMESTAMPTZ,
  CHECK (expira_em IS NULL OR expira_em > criado_em),
  CHECK (
    (status = 'ATIVO' AND revogado_em IS NULL) OR
    (status = 'REVOGADO' AND revogado_em IS NOT NULL)
  ),
  UNIQUE (id, operator_id)
);

CREATE INDEX IF NOT EXISTS operador_token_operator_status_idx
  ON operador_token (operator_id, status);

CREATE TABLE IF NOT EXISTS operador_sessao (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operador(id) ON DELETE RESTRICT,
  token_id UUID NOT NULL,
  session_hash CHAR(64) NOT NULL UNIQUE CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  status VARCHAR(16) NOT NULL CHECK (status IN ('ATIVA', 'REVOGADA')),
  criada_em TIMESTAMPTZ NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL,
  revogada_em TIMESTAMPTZ,
  CHECK (expira_em > criada_em),
  CHECK (
    (status = 'ATIVA' AND revogada_em IS NULL) OR
    (status = 'REVOGADA' AND revogada_em IS NOT NULL)
  ),
  CONSTRAINT operador_sessao_token_operator_fk
    FOREIGN KEY (token_id, operator_id)
    REFERENCES operador_token(id, operator_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS operador_sessao_operator_status_idx
  ON operador_sessao (operator_id, status, expira_em);

ALTER TABLE evento_auditoria
  ADD COLUMN IF NOT EXISTS operator_id UUID;

DO $audit_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evento_auditoria_operator_fk'
  ) THEN
    ALTER TABLE evento_auditoria
      ADD CONSTRAINT evento_auditoria_operator_fk
      FOREIGN KEY (operator_id) REFERENCES operador(id) ON DELETE RESTRICT;
  END IF;
END
$audit_fk$;

CREATE INDEX IF NOT EXISTS evento_auditoria_operator_idx
  ON evento_auditoria (operator_id, sequencia)
  WHERE operator_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON
  operador,
  operador_papel,
  operador_token,
  operador_sessao
TO integra_runtime;

COMMIT;
