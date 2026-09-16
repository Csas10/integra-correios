\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  profissional_id UUID := '10000000-0000-4000-8000-000000000001';
  lote_um UUID := '20000000-0000-4000-8000-000000000001';
  lote_dois UUID := '20000000-0000-4000-8000-000000000002';
  lote_pj UUID := '20000000-0000-4000-8000-000000000003';
  confirmacao_um UUID := '30000000-0000-4000-8000-000000000001';
  confirmacao_dois UUID := '30000000-0000-4000-8000-000000000002';
  confirmacao_tres UUID := '30000000-0000-4000-8000-000000000003';
  comunicacao_um UUID := '40000000-0000-4000-8000-000000000001';
  comunicacao_dois UUID := '40000000-0000-4000-8000-000000000002';
  comunicacao_tres UUID := '40000000-0000-4000-8000-000000000003';
  evento_id UUID := '50000000-0000-4000-8000-000000000001';
  afetadas INTEGER;
BEGIN
  INSERT INTO profissional (
    id, origem, codigo_operacional, tipo_documento,
    documento_ciphertext, documento_nonce, documento_auth_tag,
    documento_chave_versao, documento_fingerprint, status
  ) VALUES (
    profissional_id, 'PF', 'SINTETICO-DB-001', 'CPF',
    decode('01', 'hex'), decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
    'test-key-v1', repeat('a', 64), 'APTO_CONTATO'
  );

  INSERT INTO lote_comunicacao (
    id, origem, codigo, template_versao, status, criado_por
  ) VALUES
    (lote_um, 'PF', 'PF-MAIL-TESTE-001', 'pf-confirmation-v1', 'ATIVO', 'teste-integracao'),
    (lote_dois, 'PF', 'PF-MAIL-TESTE-002', 'pf-confirmation-v1', 'ATIVO', 'teste-integracao'),
    (lote_pj, 'PJ', 'PJ-MAIL-TESTE-001', 'pj-test-v1', 'ATIVO', 'teste-integracao');

  INSERT INTO confirmacao (
    id, profissional_id, token_hash, template_versao, status, emitida_em, expira_em
  ) VALUES
    (confirmacao_um, profissional_id, repeat('b', 64), 'pf-confirmation-v1', 'PENDING', now(), now() + interval '1 hour'),
    (confirmacao_dois, profissional_id, repeat('c', 64), 'pf-confirmation-v1', 'PENDING', now(), now() + interval '1 hour'),
    (confirmacao_tres, profissional_id, repeat('d', 64), 'pf-confirmation-v1', 'PENDING', now(), now() + interval '1 hour');

  INSERT INTO comunicacao (
    id, profissional_id, confirmacao_id, lote_comunicacao_id, origem, provider,
    destinatario_fingerprint, template_versao, idempotency_key, status
  ) VALUES
    (comunicacao_um, profissional_id, confirmacao_um, lote_um, 'PF', 'PENDING', repeat('e', 64), 'pf-confirmation-v1', 'test:one', 'QUEUED'),
    (comunicacao_dois, profissional_id, confirmacao_dois, lote_dois, 'PF', 'PENDING', repeat('f', 64), 'pf-confirmation-v1', 'test:two', 'QUEUED');

  INSERT INTO item_lote_comunicacao (
    lote_comunicacao_id, profissional_id, comunicacao_id, origem, status
  ) VALUES (lote_um, profissional_id, comunicacao_um, 'PF', 'ENFILEIRADO');

  BEGIN
    INSERT INTO item_lote_comunicacao (
      lote_comunicacao_id, profissional_id, comunicacao_id, origem, status
    ) VALUES (lote_dois, profissional_id, comunicacao_dois, 'PF', 'RESERVADO');
    RAISE EXCEPTION 'índice parcial aceitou duas reservas ativas';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  UPDATE item_lote_comunicacao SET status = 'CONCLUIDO'
  WHERE comunicacao_id = comunicacao_um;

  BEGIN
    INSERT INTO comunicacao (
      id, profissional_id, confirmacao_id, lote_comunicacao_id, origem, provider,
      destinatario_fingerprint, template_versao, idempotency_key, status
    ) VALUES (
      comunicacao_tres, profissional_id, confirmacao_tres, lote_pj, 'PJ', 'PENDING',
      repeat('1', 64), 'pf-confirmation-v1', 'test:three', 'QUEUED'
    );
    RAISE EXCEPTION 'origens PF/PJ incompatíveis foram aceitas';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  UPDATE confirmacao
  SET status = 'SUBMITTED', consumida_em = now(), decisao = 'CONFIRMAR'
  WHERE id = confirmacao_um AND token_hash = repeat('b', 64)
    AND status = 'PENDING' AND expira_em > now();
  GET DIAGNOSTICS afetadas = ROW_COUNT;
  IF afetadas <> 1 THEN RAISE EXCEPTION 'primeiro consumo deveria afetar uma linha'; END IF;

  UPDATE confirmacao
  SET status = 'SUBMITTED', consumida_em = now(), decisao = 'CONFIRMAR'
  WHERE id = confirmacao_um AND token_hash = repeat('b', 64)
    AND status = 'PENDING' AND expira_em > now();
  GET DIAGNOSTICS afetadas = ROW_COUNT;
  IF afetadas <> 0 THEN RAISE EXCEPTION 'segundo consumo deveria afetar zero linhas'; END IF;

  INSERT INTO evento_auditoria (
    id, agregado_tipo, agregado_id, tipo, ocorreu_em, hash_evento
  ) VALUES (evento_id, 'PROFISSIONAL', profissional_id, 'TESTE_SINTETICO', now(), repeat('9', 64));

  BEGIN
    UPDATE evento_auditoria SET tipo = 'MUTADO' WHERE id = evento_id;
    RAISE EXCEPTION 'UPDATE de auditoria foi aceito';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM evento_auditoria WHERE id = evento_id;
    RAISE EXCEPTION 'DELETE de auditoria foi aceito';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
  END;

  BEGIN
    TRUNCATE evento_auditoria;
    RAISE EXCEPTION 'TRUNCATE de auditoria foi aceito';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
  END;

  IF EXISTS (
    SELECT 1
    FROM information_schema.referential_constraints
    WHERE delete_rule = 'CASCADE'
      AND constraint_schema = current_schema()
  ) THEN
    RAISE EXCEPTION 'migration contém ON DELETE CASCADE';
  END IF;
END;
$$;

ROLLBACK;
