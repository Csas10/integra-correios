-- 0007 — Fluxo operacional persistente da Campanha PF (SLICE-02).
-- Persistência controlada da campanha aprovada + criação de lote + outbox.
-- O gate de EXECUÇÃO continua fechado: canExecute=false e a outbox nasce em
-- estado NÃO capturável pelo worker (HOLD, exclusive com PENDING/PROCESSING).
-- Nenhum e-mail é enviado por esta migration.
--
-- Dependências: 0001 (tabelas operacionais base), 0002 (role integra_runtime),
-- 0006 (identidade operacional individual).

BEGIN;

-- ---------------------------------------------------------------------------
-- Campanha persistente: identificador imutável, operator_id exclusivo da
-- sessão autenticada, fingerprint da origem, versão do template, hash de
-- aprovação congelado e snapshot dos registros aprovados (sem e-mail bruto:
-- apenas o normalizado já validado pela avaliação em memória).
-- ---------------------------------------------------------------------------

CREATE TABLE campanha_persistida (
  id UUID PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operador (id) ON DELETE RESTRICT,
  fingerprint_arquivo VARCHAR(64) NOT NULL CHECK (fingerprint_arquivo ~ '^[0-9a-f]{64}$'),
  template_versao VARCHAR(80) NOT NULL CHECK (btrim(template_versao) <> ''),
  hash_aprovacao CHAR(64) NOT NULL CHECK (hash_aprovacao ~ '^[0-9a-f]{64}$'),
  snapshot_registros JSONB NOT NULL CHECK (jsonb_typeof(snapshot_registros) = 'object'),
  total_registros INTEGER NOT NULL CHECK (total_registros >= 0),
  total_aptos INTEGER NOT NULL CHECK (total_aptos >= 0),
  total_bloqueados INTEGER NOT NULL CHECK (total_bloqueados >= 0),
  total_aprovados INTEGER NOT NULL CHECK (total_aprovados >= 0),
  decisoes_humanas JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(decisoes_humanas) = 'array'),
  estado VARCHAR(24) NOT NULL CHECK (
    estado IN ('APROVADA', 'LOTE_CRIADO', 'CANCELADA')
  ),
  criada_em TIMESTAMPTZ NOT NULL,
  atualizada_em TIMESTAMPTZ NOT NULL,
  CHECK (total_aprovados <= total_aptos),
  CHECK (total_aptos + total_bloqueados <= total_registros)
);

COMMENT ON TABLE campanha_persistida IS
  'Campanha PF aprovada e persistida (SLICE-02); hash de aprovação recalculado e congelado no servidor.';

CREATE INDEX campanha_persistida_operador_idx
  ON campanha_persistida (operator_id, criada_em DESC);

CREATE INDEX campanha_persistida_hash_idx
  ON campanha_persistida (hash_aprovacao);

-- Idempotência por fingerprint/origem + hash: repetição segura não duplica.
CREATE UNIQUE INDEX campanha_persistida_fingerprint_hash_uk
  ON campanha_persistida (fingerprint_arquivo, hash_aprovacao);

-- ---------------------------------------------------------------------------
-- Decisões humanas da campanha (exclusões/inconsistências julgadas) —
-- rastro estrutural sem PII além dos identificadores institucionais do
-- snapshot já aprovado.
-- ---------------------------------------------------------------------------

CREATE TABLE campanha_decisao (
  id UUID PRIMARY KEY,
  campanha_id UUID NOT NULL REFERENCES campanha_persistida (id) ON DELETE RESTRICT,
  operator_id UUID NOT NULL REFERENCES operador (id) ON DELETE RESTRICT,
  linha INTEGER NOT NULL CHECK (linha >= 1),
  profissional_id VARCHAR(80) NOT NULL CHECK (btrim(profissional_id) <> ''),
  tipo VARCHAR(40) NOT NULL CHECK (
    tipo IN ('EXCLUSAO_HUMANA', 'INCONSISTENCIA_JULGADA')
  ),
  motivo VARCHAR(80) NOT NULL CHECK (btrim(motivo) <> ''),
  criada_em TIMESTAMPTZ NOT NULL,
  UNIQUE (campanha_id, linha)
);

-- ---------------------------------------------------------------------------
-- Vínculo auditável campanha → lote produtivo: um único lote por campanha.
-- ---------------------------------------------------------------------------

CREATE TABLE campanha_lote (
  campanha_id UUID NOT NULL REFERENCES campanha_persistida (id) ON DELETE RESTRICT,
  lote_comunicacao_id UUID NOT NULL,
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  criado_em TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (campanha_id, lote_comunicacao_id),
  CONSTRAINT campanha_lote_lote_origem_fk
    FOREIGN KEY (lote_comunicacao_id, origem)
    REFERENCES lote_comunicacao (id, origem) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- Lote de comunicação da campanha persistida. Estado HOLD: não ativável
-- enquanto canExecute=false — nenhum caminho de ativação é exposto e o worker
-- só captura outbox de lote ATIVO.
-- ---------------------------------------------------------------------------

CREATE TABLE lote_campanha (
  id UUID PRIMARY KEY,
  campanha_id UUID NOT NULL REFERENCES campanha_persistida (id) ON DELETE RESTRICT,
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  codigo VARCHAR(80) NOT NULL CHECK (btrim(codigo) <> ''),
  template_versao VARCHAR(80) NOT NULL CHECK (btrim(template_versao) <> ''),
  estado VARCHAR(24) NOT NULL CHECK (estado IN ('HOLD', 'PREPARADO', 'ATIVO', 'CANCELADO')),
  total_itens INTEGER NOT NULL CHECK (total_itens >= 0),
  criado_em TIMESTAMPTZ NOT NULL,
  CHECK (estado <> 'ATIVO' OR total_itens > 0),
  CONSTRAINT lote_campanha_unico_por_campanha UNIQUE (campanha_id)
);

COMMENT ON TABLE lote_campanha IS
  'Lote controlado da campanha persistida; nasce em HOLD e só sai de HOLD por gate explícito (canExecute).';

-- ---------------------------------------------------------------------------
-- Outbox da campanha em estado NÃO capturável pelo worker. Isolada de
-- outbox_email (a fila produtiva): nenhum item nasce PENDING/READY, então
-- claimOutbox (que exige lote ATIVO + outbox_email PENDING) captura ZERO.
-- ---------------------------------------------------------------------------

CREATE TABLE outbox_campanha (
  id UUID PRIMARY KEY,
  lote_campanha_id UUID NOT NULL REFERENCES lote_campanha (id) ON DELETE RESTRICT,
  ordem INTEGER NOT NULL CHECK (ordem >= 1),
  destinatario_fingerprint VARCHAR(64) NOT NULL
    CHECK (destinatario_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_snapshot JSONB NOT NULL CHECK (jsonb_typeof(payload_snapshot) = 'object'),
  estado VARCHAR(24) NOT NULL CHECK (
    estado IN ('HOLD', 'PREPARADO', 'ENFILEIRADO', 'ENVIADO', 'FALHOU', 'CANCELADO')
  ),
  criada_em TIMESTAMPTZ NOT NULL,
  UNIQUE (lote_campanha_id, ordem)
);

COMMENT ON COLUMN outbox_campanha.estado IS
  'HOLD/PREPARADO = não capturável pelo worker; ENFILEIRADO só após canExecute=true (fluxo futuro).';

CREATE INDEX outbox_campanha_lote_estado_idx
  ON outbox_campanha (lote_campanha_id, estado);

-- ---------------------------------------------------------------------------
-- Rastro de auditoria operacional da campanha persistente (append-only,
-- herdado da base): operator_id/ator_operator_id já existem desde 0006.
-- ---------------------------------------------------------------------------

CREATE INDEX evento_auditoria_campanha_persistida_idx
  ON evento_auditoria (agregado_tipo, agregado_id)
  WHERE agregado_tipo = 'CAMPANHA_PERSISTIDA';

GRANT SELECT, INSERT, UPDATE ON
  campanha_persistida,
  campanha_decisao,
  campanha_lote,
  lote_campanha,
  outbox_campanha
TO integra_runtime;

COMMIT;
