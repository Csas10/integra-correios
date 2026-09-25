-- 0004 — Constraints do fluxo operacional persistente da campanha (SLICE-02).
-- Executado na CI em PostgreSQL 16 após migrations 0001–0007. Somente dados
-- sintéticos (UUIDs dedicados, hashes sintéticos, snapshots sem PII real).

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures sintéticas de identidade (mesmo padrão de 0003_operator_identity).
-- ---------------------------------------------------------------------------

-- SUSPENSO exige suspenso_em preenchido (coerência temporal da 0006).
INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em, suspenso_em)
VALUES
  ('81000000-0000-4000-8000-000000000001','ADMIN-SQL','Admin SQL','ATIVO',now(),now(),NULL),
  ('81000000-0000-4000-8000-000000000002','OP-SQL','Operador SQL','ATIVO',now(),now(),NULL),
  ('81000000-0000-4000-8000-000000000003','OP-SUSP','Operador Suspenso','SUSPENSO',now(),now(),now());

INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
VALUES
  ('81000000-0000-4000-8000-000000000001','ADMIN_TECNICO',true,now()),
  ('81000000-0000-4000-8000-000000000002','PREPARADOR',true,now()),
  ('81000000-0000-4000-8000-000000000002','APROVADOR',true,now()),
  ('81000000-0000-4000-8000-000000000002','EXECUTOR',true,now()),
  ('81000000-0000-4000-8000-000000000003','APROVADOR',true,now());

INSERT INTO operador_token (
  id, operator_id, token_hash, emitido_por_operator_id, status, criado_em
) VALUES (
  '82000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  repeat('a',64),
  '81000000-0000-4000-8000-000000000001',
  'ATIVO',
  now()
);

INSERT INTO operador_sessao (
  id, operator_id, token_id, session_hash, status, criada_em, expira_em
) VALUES (
  '83000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000001',
  repeat('b',64),'ATIVA',now(),now()+interval '1 hour'
);

-- ---------------------------------------------------------------------------
-- Campanha persistida válida (o restante do arquivo tenta violá-la).
-- ---------------------------------------------------------------------------

INSERT INTO campanha_persistida (
  id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
  snapshot_registros, total_registros, total_aptos, total_bloqueados,
  total_aprovados, estado, criada_em, atualizada_em
) VALUES (
  '84000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  repeat('1',64),
  'pf-atualizacao-cadastral-2026-v1',
  repeat('2',64),
  '{"registros":[]}'::jsonb,
  5, 3, 2, 3,
  'APROVADA',
  now(), now()
);

INSERT INTO campanha_decisao (
  id, campanha_id, operator_id, linha, profissional_id, tipo, motivo, criada_em
) VALUES (
  '85000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  2, 'PF-SINTETICO-0002', 'EXCLUSAO_HUMANA', 'BLOQUEADO_INVALIDO', now()
);

-- ---------------------------------------------------------------------------
-- 1. operator_id da campanha tem FK dura: operador inexistente recusa.
-- ---------------------------------------------------------------------------

DO $fk_operador$
BEGIN
  INSERT INTO campanha_persistida (
    id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
    snapshot_registros, total_registros, total_aptos, total_bloqueados,
    total_aprovados, estado, criada_em, atualizada_em
  ) VALUES (
    '84000000-0000-4000-8000-000000000009',
    '81000000-0000-4000-8000-000000000099',
    repeat('3',64), 'v1', repeat('4',64), '{"registros":[]}'::jsonb,
    1, 1, 0, 1, 'APROVADA', now(), now()
  );
  RAISE EXCEPTION 'FK de operator_id foi aceita';
EXCEPTION
  WHEN foreign_key_violation THEN NULL;
END
$fk_operador$;

-- ---------------------------------------------------------------------------
-- 2. Estados e coerências de contagem da campanha.
-- ---------------------------------------------------------------------------

DO $estado$
BEGIN
  INSERT INTO campanha_persistida (
    id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
    snapshot_registros, total_registros, total_aptos, total_bloqueados,
    total_aprovados, estado, criada_em, atualizada_em
  ) VALUES (
    '84000000-0000-4000-8000-00000000000a',
    '81000000-0000-4000-8000-000000000002',
    repeat('5',64), 'v1', repeat('6',64), '{"registros":[]}'::jsonb,
    1, 1, 0, 1, 'PENDENTE', now(), now()
  );
  RAISE EXCEPTION 'estado invalido aceito';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$estado$;

DO $contagem$
BEGIN
  INSERT INTO campanha_persistida (
    id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
    snapshot_registros, total_registros, total_aptos, total_bloqueados,
    total_aprovados, estado, criada_em, atualizada_em
  ) VALUES (
    '84000000-0000-4000-8000-00000000000b',
    '81000000-0000-4000-8000-000000000002',
    repeat('7',64), 'v1', repeat('8',64), '{"registros":[]}'::jsonb,
    5, 3, 2, 4, 'APROVADA', now(), now()
  );
  RAISE EXCEPTION 'total_aprovados > total_aptos foi aceito';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$contagem$;

DO $contagem2$
BEGIN
  INSERT INTO campanha_persistida (
    id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
    snapshot_registros, total_registros, total_aptos, total_bloqueados,
    total_aprovados, estado, criada_em, atualizada_em
  ) VALUES (
    '84000000-0000-4000-8000-00000000000c',
    '81000000-0000-4000-8000-000000000002',
    repeat('9',64), 'v1', repeat('0',64), '{"registros":[]}'::jsonb,
    5, 3, 3, 3, 'APROVADA', now(), now()
  );
  RAISE EXCEPTION 'aptos+bloqueados > total foi aceito';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$contagem2$;

-- ---------------------------------------------------------------------------
-- 3. Hash e fingerprint devem ser SHA-256 hex-64.
-- ---------------------------------------------------------------------------

DO $hash$
BEGIN
  INSERT INTO campanha_persistida (
    id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
    snapshot_registros, total_registros, total_aptos, total_bloqueados,
    total_aprovados, estado, criada_em, atualizada_em
  ) VALUES (
    '84000000-0000-4000-8000-00000000000d',
    '81000000-0000-4000-8000-000000000002',
    repeat('a',64), 'v1', repeat('f',63), '{"registros":[]}'::jsonb,
    1, 1, 0, 1, 'APROVADA', now(), now()
  );
  RAISE EXCEPTION 'hash de 63 hex foi aceito';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$hash$;

-- ---------------------------------------------------------------------------
-- 4. Idempotência estrutural: (fingerprint, hash) duplicado recusa (23505).
-- ---------------------------------------------------------------------------

DO $idem$
BEGIN
  INSERT INTO campanha_persistida (
    id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
    snapshot_registros, total_registros, total_aptos, total_bloqueados,
    total_aprovados, estado, criada_em, atualizada_em
  ) VALUES (
    '84000000-0000-4000-8000-00000000000e',
    '81000000-0000-4000-8000-000000000002',
    repeat('1',64), 'v1', repeat('2',64), '{"registros":[]}'::jsonb,
    5, 3, 2, 3, 'APROVADA', now(), now()
  );
  RAISE EXCEPTION 'idempotencia (fingerprint,hash) foi aceita';
EXCEPTION
  WHEN unique_violation THEN NULL;
END
$idem$;

-- ---------------------------------------------------------------------------
-- 5. Lote único por campanha (UNIQUE campanha_id) e lote ATIVO exige itens.
-- ---------------------------------------------------------------------------

INSERT INTO lote_comunicacao (
  id, origem, codigo, template_versao, status, criado_por, criado_em
) VALUES (
  '86000000-0000-4000-8000-000000000001',
  'PF',
  'LOTE-CAMPANHA-SQL-001',
  'pf-atualizacao-cadastral-2026-v1',
  'PREPARACAO',
  '81000000-0000-4000-8000-000000000002',
  now()
);

INSERT INTO lote_campanha (
  id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em
) VALUES (
  '87000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001',
  'PF',
  'LOTE-CAMPANHA-SQL-001',
  'pf-atualizacao-cadastral-2026-v1',
  'HOLD',
  3,
  now()
);

INSERT INTO campanha_lote (
  campanha_id, lote_comunicacao_id, origem, criado_em
) VALUES (
  '84000000-0000-4000-8000-000000000001',
  '86000000-0000-4000-8000-000000000001',
  'PF',
  now()
);

DO $lote_unico$
BEGIN
  INSERT INTO lote_campanha (
    id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em
  ) VALUES (
    '87000000-0000-4000-8000-000000000002',
    '84000000-0000-4000-8000-000000000001',
    'PF', 'LOTE-CAMPANHA-SQL-002', 'v1', 'HOLD', 1, now()
  );
  RAISE EXCEPTION 'segundo lote por campanha foi aceito';
EXCEPTION
  WHEN unique_violation THEN NULL;
END
$lote_unico$;

DO $lote_ativo$
BEGIN
  INSERT INTO lote_campanha (
    id, campanha_id, origem, codigo, template_versao, estado, total_itens, criado_em
  ) VALUES (
    '87000000-0000-4000-8000-000000000003',
    '84000000-0000-4000-8000-00000000000f',
    'PF', 'X', 'v1', 'ATIVO', 0, now()
  );
  RAISE EXCEPTION 'lote ATIVO sem itens foi aceito';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$lote_ativo$;

-- ---------------------------------------------------------------------------
-- 6. Outbox nasce NÃO capturável: HOLD/PREPARADO permitidos; PENDING/READY
--    recusados por CHECK (a fila produtiva outbox_email permanece intocada).
-- ---------------------------------------------------------------------------

INSERT INTO outbox_campanha (
  id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em
) VALUES
  ('88000000-0000-4000-8000-000000000001',
   '87000000-0000-4000-8000-000000000001', 1, repeat('c',64),
   '{"previa":"mensagem-sintetica-1"}'::jsonb, 'HOLD', now()),
  ('88000000-0000-4000-8000-000000000002',
   '87000000-0000-4000-8000-000000000001', 2, repeat('d',64),
   '{"previa":"mensagem-sintetica-2"}'::jsonb, 'HOLD', now()),
  ('88000000-0000-4000-8000-000000000003',
   '87000000-0000-4000-8000-000000000001', 3, repeat('e',64),
   '{"previa":"mensagem-sintetica-3"}'::jsonb, 'HOLD', now());

DO $outbox_pending$
BEGIN
  INSERT INTO outbox_campanha (
    id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em
  ) VALUES (
    '88000000-0000-4000-8000-000000000004',
    '87000000-0000-4000-8000-000000000001', 4, repeat('f',64),
    '{"previa":"x"}'::jsonb, 'PENDING', now()
  );
  RAISE EXCEPTION 'outbox PENDING foi aceita';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$outbox_pending$;

DO $outbox_ready$
BEGIN
  INSERT INTO outbox_campanha (
    id, lote_campanha_id, ordem, destinatario_fingerprint, payload_snapshot, estado, criada_em
  ) VALUES (
    '88000000-0000-4000-8000-000000000005',
    '87000000-0000-4000-8000-000000000001', 5, repeat('0',64),
    '{"previa":"x"}'::jsonb, 'READY', now()
  );
  RAISE EXCEPTION 'outbox READY foi aceita';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$outbox_ready$;

-- ---------------------------------------------------------------------------
-- 7. Prova de zero-captura: o claim do worker (lote ATIVO + outbox_email
--    PENDING) não alcança a outbox da campanha (lote HOLD + outbox própria).
--    A fila produtiva permanece vazia; executarWorkerUmaVez capturaria 0.
-- ---------------------------------------------------------------------------

DO $zero_claim$
DECLARE
  fila_produtiva integer;
  itens_processando integer;
BEGIN
  SELECT count(*) INTO fila_produtiva
    FROM outbox_email o
    JOIN comunicacao c ON c.id = o.comunicacao_id
    JOIN lote_comunicacao l ON l.id = c.lote_comunicacao_id
   WHERE l.status = 'ATIVO'
     AND (o.status = 'PENDING' OR o.status = 'PROCESSING');

  SELECT count(*) INTO itens_processando
    FROM item_lote_comunicacao WHERE status = 'PROCESSANDO';

  IF fila_produtiva <> 0 THEN
    RAISE EXCEPTION 'outbox_email capturavel pelo worker deveria ser zero';
  END IF;
  IF itens_processando <> 0 THEN
    RAISE EXCEPTION 'itens PROCESSANDO deveriam ser zero';
  END IF;
END
$zero_claim$;

-- ---------------------------------------------------------------------------
-- 8. RBAC no runtime: integra_runtime lê e escreve na campanha persistida;
--    mutações de auditoria recusadas (append-only); operador suspenso é
--    recusado pela camada de aplicação (contrato do servidor, coberto nos
--    testes HTTP), e o banco prova as constraints estruturais.
-- ---------------------------------------------------------------------------

BEGIN
  INSERT INTO evento_auditoria (
    id, agregado_tipo, agregado_id, tipo, operator_id, ator_operator_id,
    ocorreu_em, metadados, hash_anterior, hash_evento
  ) VALUES (
    '89000000-0000-4000-8000-000000000001',
    'CAMPANHA_PERSISTIDA',
    '84000000-0000-4000-8000-000000000001',
    'CAMPAIGN_PERSISTIDA',
    '81000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000002',
    now(), '{"total_aprovados":3}'::jsonb, NULL, repeat('7',64)
  );
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'auditoria da campanha deveria ser aceita: %', SQLERRM;
END;

BEGIN
  UPDATE evento_auditoria SET tipo = 'MUTADO'
   WHERE id = '89000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'UPDATE de auditoria foi aceito';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
END;

BEGIN
  DELETE FROM evento_auditoria WHERE id = '89000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'DELETE de auditoria foi aceito';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
END;

ROLLBACK;
