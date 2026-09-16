BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE arquivo_importacao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  nome_original TEXT NOT NULL CHECK (btrim(nome_original) <> ''),
  mime_type TEXT NOT NULL CHECK (btrim(mime_type) <> ''),
  tamanho_bytes BIGINT NOT NULL CHECK (tamanho_bytes >= 0),
  sha256 VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key TEXT NOT NULL CHECK (btrim(storage_key) <> ''),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, origem)
);

CREATE INDEX arquivo_importacao_sha256_idx ON arquivo_importacao (sha256);
CREATE INDEX arquivo_importacao_origem_criado_idx
  ON arquivo_importacao (origem, criado_em DESC);

CREATE TABLE perfil_mapeamento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  nome VARCHAR(120) NOT NULL CHECK (btrim(nome) <> ''),
  versao INTEGER NOT NULL CHECK (versao > 0),
  definicao JSONB NOT NULL CHECK (jsonb_typeof(definicao) = 'object'),
  confirmado_por TEXT NOT NULL CHECK (btrim(confirmado_por) <> ''),
  confirmado_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origem, nome, versao),
  UNIQUE (id, origem)
);

CREATE TABLE importacao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arquivo_importacao_id UUID NOT NULL,
  perfil_mapeamento_id UUID,
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  status VARCHAR(24) NOT NULL CHECK (
    status IN ('RECEBIDA', 'MAPEADA', 'VALIDADA', 'CONCLUIDA', 'FALHOU')
  ),
  total_linhas INTEGER NOT NULL DEFAULT 0 CHECK (total_linhas >= 0),
  linhas_validas INTEGER NOT NULL DEFAULT 0 CHECK (linhas_validas >= 0),
  linhas_pendentes INTEGER NOT NULL DEFAULT 0 CHECK (linhas_pendentes >= 0),
  iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em TIMESTAMPTZ,
  CONSTRAINT importacao_contagens_check CHECK (
    linhas_validas + linhas_pendentes <= total_linhas
  ),
  CONSTRAINT importacao_arquivo_origem_fk FOREIGN KEY (arquivo_importacao_id, origem)
    REFERENCES arquivo_importacao (id, origem) ON DELETE RESTRICT,
  CONSTRAINT importacao_perfil_origem_fk FOREIGN KEY (perfil_mapeamento_id, origem)
    REFERENCES perfil_mapeamento (id, origem) ON DELETE RESTRICT
);

CREATE INDEX importacao_origem_status_idx ON importacao (origem, status, iniciada_em DESC);

CREATE TABLE linha_importada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  importacao_id UUID NOT NULL,
  folha TEXT NOT NULL CHECK (btrim(folha) <> ''),
  numero_linha INTEGER NOT NULL CHECK (numero_linha > 0),
  dados_brutos_ciphertext BYTEA NOT NULL CHECK (octet_length(dados_brutos_ciphertext) > 0),
  dados_brutos_nonce BYTEA NOT NULL CHECK (octet_length(dados_brutos_nonce) = 12),
  dados_brutos_auth_tag BYTEA NOT NULL CHECK (octet_length(dados_brutos_auth_tag) = 16),
  chave_versao VARCHAR(80) NOT NULL CHECK (btrim(chave_versao) <> ''),
  documento_fingerprint VARCHAR(64)
    CHECK (documento_fingerprint IS NULL OR documento_fingerprint ~ '^[0-9a-f]{64}$'),
  status VARCHAR(24) NOT NULL CHECK (
    status IN ('RECEBIDA', 'VALIDA', 'PENDENTE', 'INVALIDA', 'DUPLICADA')
  ),
  inconsistencias JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(inconsistencias) = 'array'),
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT linha_importada_importacao_fk FOREIGN KEY (importacao_id)
    REFERENCES importacao (id) ON DELETE RESTRICT,
  UNIQUE (importacao_id, folha, numero_linha)
);

CREATE INDEX linha_importada_fingerprint_idx ON linha_importada (documento_fingerprint);
CREATE INDEX linha_importada_status_idx ON linha_importada (importacao_id, status);

CREATE TABLE profissional (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  codigo_operacional TEXT NOT NULL CHECK (btrim(codigo_operacional) <> ''),
  tipo_documento VARCHAR(4) NOT NULL CHECK (tipo_documento IN ('CPF', 'CNPJ')),
  documento_ciphertext BYTEA NOT NULL CHECK (octet_length(documento_ciphertext) > 0),
  documento_nonce BYTEA NOT NULL CHECK (octet_length(documento_nonce) = 12),
  documento_auth_tag BYTEA NOT NULL CHECK (octet_length(documento_auth_tag) = 16),
  documento_chave_versao VARCHAR(80) NOT NULL CHECK (btrim(documento_chave_versao) <> ''),
  documento_fingerprint VARCHAR(64) NOT NULL
    CHECK (documento_fingerprint ~ '^[0-9a-f]{64}$'),
  status VARCHAR(40) NOT NULL CHECK (status IN (
    'RECEBIDO', 'CARTEIRA_IDENTIFICADA', 'PENDENCIA_TRIAGEM', 'APTO_CONTATO',
    'EMAIL_PENDENTE', 'EMAIL_ENVIADO', 'AGUARDANDO_CONFIRMACAO',
    'CONFIRMADO_SEM_ALTERACAO', 'CONFIRMADO_COM_ALTERACAO', 'EM_VALIDACAO',
    'PENDENCIA_CADASTRAL', 'APTO_PREPOSTAGEM', 'INCLUIDO_EM_LOTE', 'POSTADO',
    'PENDENTE', 'EM_LOTE', 'ENVIADO', 'CONFIRMADO', 'REJEITADO', 'RETESTE'
  )),
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao > 0),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profissional_tipo_origem_check CHECK (
    (origem = 'PF' AND tipo_documento = 'CPF') OR
    (origem = 'PJ' AND tipo_documento = 'CNPJ')
  ),
  UNIQUE (origem, codigo_operacional),
  UNIQUE (origem, documento_fingerprint),
  UNIQUE (id, origem)
);

CREATE INDEX profissional_status_idx ON profissional (origem, status);

CREATE TABLE snapshot_cadastral (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profissional_id UUID NOT NULL,
  tipo VARCHAR(16) NOT NULL CHECK (tipo IN ('ORIGINAL', 'CONFIRMADO')),
  conteudo_ciphertext BYTEA NOT NULL CHECK (octet_length(conteudo_ciphertext) > 0),
  conteudo_nonce BYTEA NOT NULL CHECK (octet_length(conteudo_nonce) = 12),
  conteudo_auth_tag BYTEA NOT NULL CHECK (octet_length(conteudo_auth_tag) = 16),
  chave_versao VARCHAR(80) NOT NULL CHECK (btrim(chave_versao) <> ''),
  fonte VARCHAR(32) NOT NULL CHECK (
    fonte IN ('IMPORTACAO', 'CONFIRMACAO_WEB', 'REVISAO_OPERADOR')
  ),
  vigente BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT snapshot_profissional_fk FOREIGN KEY (profissional_id)
    REFERENCES profissional (id) ON DELETE RESTRICT,
  UNIQUE (id, profissional_id)
);

CREATE UNIQUE INDEX snapshot_cadastral_vigente_idx
  ON snapshot_cadastral (profissional_id, tipo)
  WHERE vigente;

CREATE TABLE confirmacao (
  id UUID PRIMARY KEY,
  profissional_id UUID NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  template_versao VARCHAR(80) NOT NULL CHECK (btrim(template_versao) <> ''),
  status VARCHAR(16) NOT NULL CHECK (status IN ('PENDING', 'SUBMITTED', 'EXPIRED', 'REVOKED')),
  decisao VARCHAR(16) CHECK (decisao IN ('CONFIRMAR', 'ATUALIZAR')),
  snapshot_confirmado_id UUID,
  emitida_em TIMESTAMPTZ NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL,
  consumida_em TIMESTAMPTZ,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT confirmacao_expiracao_check CHECK (expira_em > emitida_em),
  CONSTRAINT confirmacao_consumo_check CHECK (
    (status = 'SUBMITTED' AND consumida_em IS NOT NULL AND decisao IS NOT NULL) OR
    (status <> 'SUBMITTED' AND consumida_em IS NULL AND decisao IS NULL)
  ),
  CONSTRAINT confirmacao_profissional_fk FOREIGN KEY (profissional_id)
    REFERENCES profissional (id) ON DELETE RESTRICT,
  CONSTRAINT confirmacao_snapshot_profissional_fk
    FOREIGN KEY (snapshot_confirmado_id, profissional_id)
    REFERENCES snapshot_cadastral (id, profissional_id) ON DELETE RESTRICT,
  UNIQUE (id, profissional_id)
);

CREATE INDEX confirmacao_pendente_idx
  ON confirmacao (expira_em)
  WHERE status = 'PENDING';

CREATE TABLE lote_comunicacao (
  id UUID PRIMARY KEY,
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  codigo VARCHAR(80) NOT NULL CHECK (btrim(codigo) <> ''),
  template_versao VARCHAR(80) NOT NULL CHECK (btrim(template_versao) <> ''),
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('PREPARACAO', 'ATIVO', 'CONCLUIDO', 'CANCELADO')
  ),
  criado_por TEXT NOT NULL CHECK (btrim(criado_por) <> ''),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ativado_em TIMESTAMPTZ,
  concluido_em TIMESTAMPTZ,
  UNIQUE (origem, codigo),
  UNIQUE (id, origem)
);

CREATE TABLE comunicacao (
  id UUID PRIMARY KEY,
  profissional_id UUID NOT NULL,
  confirmacao_id UUID NOT NULL,
  lote_comunicacao_id UUID NOT NULL,
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  provider VARCHAR(32) NOT NULL CHECK (provider IN ('PENDING', 'GMAIL', 'RESEND')),
  provider_message_id TEXT,
  provider_thread_id TEXT,
  destinatario_fingerprint VARCHAR(64) NOT NULL
    CHECK (destinatario_fingerprint ~ '^[0-9a-f]{64}$'),
  template_versao VARCHAR(80) NOT NULL CHECK (btrim(template_versao) <> ''),
  idempotency_key VARCHAR(180) NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('QUEUED', 'ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED')
  ),
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  aceita_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  falhou_em TIMESTAMPTZ,
  CONSTRAINT comunicacao_profissional_origem_fk FOREIGN KEY (profissional_id, origem)
    REFERENCES profissional (id, origem) ON DELETE RESTRICT,
  CONSTRAINT comunicacao_confirmacao_profissional_fk
    FOREIGN KEY (confirmacao_id, profissional_id)
    REFERENCES confirmacao (id, profissional_id) ON DELETE RESTRICT,
  CONSTRAINT comunicacao_lote_origem_fk FOREIGN KEY (lote_comunicacao_id, origem)
    REFERENCES lote_comunicacao (id, origem) ON DELETE RESTRICT,
  UNIQUE (confirmacao_id),
  UNIQUE (id, profissional_id, lote_comunicacao_id, origem)
);

CREATE INDEX comunicacao_profissional_status_idx
  ON comunicacao (profissional_id, status, criada_em DESC);

CREATE TABLE oauth_connection (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(32) NOT NULL CHECK (provider IN ('GMAIL')),
  conta_fingerprint VARCHAR(64) NOT NULL
    CHECK (conta_fingerprint ~ '^[0-9a-f]{64}$'),
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),
  access_token_ciphertext BYTEA NOT NULL CHECK (octet_length(access_token_ciphertext) > 0),
  access_token_nonce BYTEA NOT NULL CHECK (octet_length(access_token_nonce) = 12),
  access_token_auth_tag BYTEA NOT NULL CHECK (octet_length(access_token_auth_tag) = 16),
  refresh_token_ciphertext BYTEA CHECK (
    refresh_token_ciphertext IS NULL OR octet_length(refresh_token_ciphertext) > 0
  ),
  refresh_token_nonce BYTEA,
  refresh_token_auth_tag BYTEA,
  chave_versao VARCHAR(80) NOT NULL CHECK (btrim(chave_versao) <> ''),
  expira_em TIMESTAMPTZ,
  revogada_em TIMESTAMPTZ,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_refresh_token_envelope_check CHECK (
    (refresh_token_ciphertext IS NULL AND refresh_token_nonce IS NULL AND refresh_token_auth_tag IS NULL) OR
    (refresh_token_ciphertext IS NOT NULL AND octet_length(refresh_token_ciphertext) > 0 AND
      refresh_token_nonce IS NOT NULL AND octet_length(refresh_token_nonce) = 12 AND
      refresh_token_auth_tag IS NOT NULL AND octet_length(refresh_token_auth_tag) = 16)
  ),
  UNIQUE (provider, conta_fingerprint)
);

CREATE TABLE outbox_email (
  id UUID PRIMARY KEY,
  comunicacao_id UUID NOT NULL,
  idempotency_key VARCHAR(180) NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  payload_ciphertext BYTEA NOT NULL CHECK (octet_length(payload_ciphertext) > 0),
  payload_nonce BYTEA NOT NULL CHECK (octet_length(payload_nonce) = 12),
  payload_auth_tag BYTEA NOT NULL CHECK (octet_length(payload_auth_tag) = 16),
  chave_versao VARCHAR(80) NOT NULL CHECK (btrim(chave_versao) <> ''),
  status VARCHAR(20) NOT NULL CHECK (
    status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED')
  ),
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  disponivel_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  bloqueada_em TIMESTAMPTZ,
  bloqueada_por TEXT,
  ultimo_erro_codigo VARCHAR(80),
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviada_em TIMESTAMPTZ,
  CONSTRAINT outbox_comunicacao_fk FOREIGN KEY (comunicacao_id)
    REFERENCES comunicacao (id) ON DELETE RESTRICT,
  UNIQUE (comunicacao_id)
);

CREATE INDEX outbox_email_pendente_idx
  ON outbox_email (disponivel_em, criada_em)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE item_lote_comunicacao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_comunicacao_id UUID NOT NULL,
  profissional_id UUID NOT NULL,
  comunicacao_id UUID NOT NULL,
  origem VARCHAR(2) NOT NULL CHECK (origem IN ('PF', 'PJ')),
  status VARCHAR(20) NOT NULL CHECK (
    status IN (
      'RESERVADO', 'ENFILEIRADO', 'PROCESSANDO', 'ENVIADO',
      'FALHOU', 'CONCLUIDO', 'CANCELADO'
    )
  ),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT item_lote_lote_origem_fk FOREIGN KEY (lote_comunicacao_id, origem)
    REFERENCES lote_comunicacao (id, origem) ON DELETE RESTRICT,
  CONSTRAINT item_lote_profissional_origem_fk FOREIGN KEY (profissional_id, origem)
    REFERENCES profissional (id, origem) ON DELETE RESTRICT,
  CONSTRAINT item_lote_comunicacao_contexto_fk
    FOREIGN KEY (comunicacao_id, profissional_id, lote_comunicacao_id, origem)
    REFERENCES comunicacao (id, profissional_id, lote_comunicacao_id, origem) ON DELETE RESTRICT,
  UNIQUE (lote_comunicacao_id, profissional_id),
  UNIQUE (comunicacao_id)
);

CREATE UNIQUE INDEX item_lote_profissional_ativo_idx
  ON item_lote_comunicacao (profissional_id)
  WHERE status IN ('RESERVADO', 'ENFILEIRADO', 'PROCESSANDO', 'ENVIADO', 'FALHOU');

CREATE TABLE evento_auditoria (
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id UUID NOT NULL UNIQUE,
  agregado_tipo VARCHAR(80) NOT NULL CHECK (btrim(agregado_tipo) <> ''),
  agregado_id UUID NOT NULL,
  tipo VARCHAR(120) NOT NULL CHECK (btrim(tipo) <> ''),
  ator_id TEXT,
  ocorreu_em TIMESTAMPTZ NOT NULL,
  metadados JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadados) = 'object'),
  hash_anterior VARCHAR(64) CHECK (hash_anterior IS NULL OR hash_anterior ~ '^[0-9a-f]{64}$'),
  hash_evento VARCHAR(64) NOT NULL UNIQUE CHECK (hash_evento ~ '^[0-9a-f]{64}$')
);

CREATE INDEX evento_auditoria_agregado_idx
  ON evento_auditoria (agregado_tipo, agregado_id, sequencia);

CREATE FUNCTION bloquear_mutacao_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evento_auditoria é append-only';
END;
$$;

CREATE TRIGGER evento_auditoria_append_only
BEFORE UPDATE OR DELETE ON evento_auditoria
FOR EACH ROW EXECUTE FUNCTION bloquear_mutacao_append_only();

CREATE TRIGGER evento_auditoria_sem_truncate
BEFORE TRUNCATE ON evento_auditoria
FOR EACH STATEMENT EXECUTE FUNCTION bloquear_mutacao_append_only();

COMMIT;
