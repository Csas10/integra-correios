-- 0005 — FINAL CLOSURE GATE item 2: fonte persistida do registro da
-- comunicação (CONTROLADO_SINTETICO | INSTITUCIONAL_XLSX) e colunas de PKCE
-- server-side do oauth_flow (item 1).
--
-- Motivação (item 2): o GATE 2 do modo controlado exige provar que a
-- comunicação NÃO provém do XLSX institucional. Sem uma coluna de fonte,
-- essa prova não é possível no banco. A migração:
--   1. cria comunicacao.fonte_registro com DEFAULT 'INSTITUCIONAL_XLSX'
--      (conservador: toda comunicação pré-existente é tratada como
--      institucional — o modo controlado jamais a enviará);
--   2. restringe os valores por CHECK.
--
-- Motivação (item 1): oauth_flow ganha as colunas de PKCE server-side
-- (code_verifier cifrado + operador_hash) e o consumo atômico passa a
-- exigir a MESMA sessão do operador do START.
--
-- Nenhum dado existente é alterado ou removido — apenas classificado.

BEGIN;

ALTER TABLE comunicacao
  ADD COLUMN IF NOT EXISTS fonte_registro VARCHAR(24) NOT NULL DEFAULT 'INSTITUCIONAL_XLSX';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comunicacao_fonte_registro_check'
  ) THEN
    ALTER TABLE comunicacao
      ADD CONSTRAINT comunicacao_fonte_registro_check
      CHECK (fonte_registro IN ('CONTROLADO_SINTETICO', 'INSTITUCIONAL_XLSX'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS comunicacao_fonte_registro_idx
  ON comunicacao (fonte_registro);

ALTER TABLE oauth_flow
  ADD COLUMN IF NOT EXISTS code_verifier_ciphertext BYTEA,
  ADD COLUMN IF NOT EXISTS code_verifier_nonce BYTEA,
  ADD COLUMN IF NOT EXISTS code_verifier_auth_tag BYTEA,
  ADD COLUMN IF NOT EXISTS code_verifier_chave_versao VARCHAR(8),
  ADD COLUMN IF NOT EXISTS operador_hash CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_flow_operador_hash_check'
  ) THEN
    ALTER TABLE oauth_flow
      ADD CONSTRAINT oauth_flow_operador_hash_check
      CHECK (operador_hash IS NULL OR operador_hash ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;

COMMIT;
