\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
VALUES
  ('81000000-0000-4000-8000-000000000001','ADMIN-SQL','Admin SQL','ATIVO',now(),now()),
  ('81000000-0000-4000-8000-000000000002','OP-SQL','Operador SQL','ATIVO',now(),now());

INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
VALUES
  ('81000000-0000-4000-8000-000000000001','ADMIN_TECNICO',true,now()),
  ('81000000-0000-4000-8000-000000000002','PREPARADOR',true,now());

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

DO $cross_link$
BEGIN
  INSERT INTO operador_sessao (
    id, operator_id, token_id, session_hash, status, criada_em, expira_em
  ) VALUES (
    '83000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    repeat('d',64),'ATIVA',now(),now()+interval '1 hour'
  );
  RAISE EXCEPTION 'sessão vinculada a token de outro operador deveria falhar';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END
$cross_link$;

INSERT INTO evento_auditoria (
  id, agregado_tipo, agregado_id, tipo, ator_id, operator_id, ator_operator_id,
  ocorreu_em, hash_evento
) VALUES (
  '84000000-0000-4000-8000-000000000001','OPERADOR',
  '81000000-0000-4000-8000-000000000002','OPERADOR_TESTE_SQL',
  '81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000001',
  now(),repeat('c',64)
);

DO $actor_fk$
BEGIN
  INSERT INTO evento_auditoria (
    id, agregado_tipo, agregado_id, tipo, ator_id, operator_id, ator_operator_id,
    ocorreu_em, hash_evento
  ) VALUES (
    '84000000-0000-4000-8000-000000000002','OPERADOR',
    '81000000-0000-4000-8000-000000000002','ATOR_INVALIDO',
    '89999999-9999-4999-8999-999999999999',
    '81000000-0000-4000-8000-000000000002',
    '89999999-9999-4999-8999-999999999999',
    now(),repeat('e',64)
  );
  RAISE EXCEPTION 'ator administrativo inexistente deveria falhar';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END
$actor_fk$;

DO $append_only$
BEGIN
  UPDATE evento_auditoria SET tipo='MUTADO'
   WHERE id='84000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'UPDATE em auditoria deveria ser bloqueado';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
END
$append_only$;

ROLLBACK;
