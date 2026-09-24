\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
VALUES ('81000000-0000-4000-8000-000000000001','OP-SQL-001','Operador SQL Sintético','ATIVO',now(),now());

INSERT INTO operador_papel (operator_id, papel, ativo, concedido_em)
VALUES ('81000000-0000-4000-8000-000000000001','PREPARADOR',true,now());

INSERT INTO operador (id, codigo, nome_exibicao, status, criado_em, atualizado_em)
VALUES ('81000000-0000-4000-8000-000000000002','OP-SQL-002','Outro Operador SQL','ATIVO',now(),now());

INSERT INTO operador_token (id, operator_id, token_hash, status, criado_em)
VALUES ('82000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001',repeat('a',64),'ATIVO',now());

INSERT INTO operador_sessao (id, operator_id, token_id, session_hash, status, criada_em, expira_em)
VALUES ('83000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001',
'82000000-0000-4000-8000-000000000001',repeat('b',64),'ATIVA',now(),now()+interval '1 hour');

DO $cross_link$
BEGIN
  INSERT INTO operador_sessao (
    id, operator_id, token_id, session_hash, status, criada_em, expira_em
  ) VALUES (
    '83000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    repeat('d',64),'ATIVA',now(),now()+interval '1 hour'
  );
  RAISE EXCEPTION 'sessão vinculada a token de outro operador deveria falhar';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END
$cross_link$;

INSERT INTO evento_auditoria (
  id, agregado_tipo, agregado_id, tipo, ator_id, operator_id, ocorreu_em, hash_evento
) VALUES (
  '84000000-0000-4000-8000-000000000001','OPERADOR',
  '81000000-0000-4000-8000-000000000001','OPERADOR_TESTE_SQL',
  '81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001',
  now(),repeat('c',64)
);

DO $$
BEGIN
  UPDATE evento_auditoria SET tipo='MUTADO'
   WHERE id='84000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'UPDATE em auditoria deveria ser bloqueado';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'evento_auditoria é append-only' THEN RAISE; END IF;
END
$$;

UPDATE operador SET status='SUSPENSO', atualizado_em=now(), suspenso_em=now()
 WHERE id='81000000-0000-4000-8000-000000000001';
UPDATE operador_token SET status='REVOGADO', revogado_em=now()
 WHERE operator_id='81000000-0000-4000-8000-000000000001';
UPDATE operador_sessao SET status='REVOGADA', revogada_em=now()
 WHERE operator_id='81000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM operador_sessao s
    JOIN operador o ON o.id=s.operator_id
    JOIN operador_token t ON t.id=s.token_id
    WHERE s.session_hash=repeat('b',64)
      AND s.status='ATIVA' AND o.status='ATIVO' AND t.status='ATIVO'
  ) THEN
    RAISE EXCEPTION 'sessão permaneceu autorizável após suspensão';
  END IF;
END
$$;

ROLLBACK;
