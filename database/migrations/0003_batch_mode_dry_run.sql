-- 0003 — Distinguibilidade inequívoca DRY_RUN vs LIVE (F7).
--
-- Justificativa da migration:
--   1. lote_comunicacao.modo persiste a natureza da execução do lote
--      (DRY_RUN | LIVE_PILOT). Um lote DRY_RUN nunca pode virar LIVE
--      silenciosamente: o modo nasce no INSERT e a auditoria registra o modo.
--   2. comunicacao.provider aceita 'DRY_RUN': o receipt sintético é persistido
--      com provider próprio, então nenhum registro DRY_RUN pode ser
--      interpretado como receipt Gmail real.
--   3. idempotência: re-execução é inofensiva (IF NOT EXISTS / condicional).
--
-- Nenhum dado existente é alterado: lotes pré-existentes (base de teste V0)
-- são classificados como DRY_RUN — única execução existente até aqui.

BEGIN;

ALTER TABLE lote_comunicacao
  ADD COLUMN IF NOT EXISTS modo VARCHAR(16) NOT NULL DEFAULT 'DRY_RUN';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lote_comunicacao_modo_check'
  ) THEN
    ALTER TABLE lote_comunicacao
      ADD CONSTRAINT lote_comunicacao_modo_check
      CHECK (modo IN ('DRY_RUN', 'LIVE_PILOT'));
  END IF;
END
$$;

ALTER TABLE comunicacao DROP CONSTRAINT IF EXISTS comunicacao_provider_check;

ALTER TABLE comunicacao
  ADD CONSTRAINT comunicacao_provider_check
  CHECK (provider IN ('PENDING', 'GMAIL', 'RESEND', 'DRY_RUN'));

CREATE INDEX IF NOT EXISTS lote_comunicacao_modo_idx
  ON lote_comunicacao (modo, status);

COMMIT;
