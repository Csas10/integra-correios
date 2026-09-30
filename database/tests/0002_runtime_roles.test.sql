\set ON_ERROR_STOP on

-- Prova em PostgreSQL 16 que integra_runtime é uma role-grupo NOLOGIN e que
-- um login efêmero membro consegue operar as tabelas sem adquirir poderes de
-- DDL, exclusão ou mutação da auditoria.

BEGIN;

DO $$
DECLARE
  runtime_role text := 'integra_runtime';
  tabela text;
  privilegio text;
  tabelas_operacionais text[] := ARRAY[
    'arquivo_importacao', 'perfil_mapeamento', 'importacao', 'linha_importada',
    'profissional', 'snapshot_cadastral', 'confirmacao', 'lote_comunicacao',
    'comunicacao', 'oauth_connection', 'outbox_email', 'item_lote_comunicacao',
    'oauth_flow', 'operador', 'operador_papel', 'operador_token', 'operador_sessao'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    RAISE EXCEPTION 'role % não existe — aplique 0002_runtime_roles.sql', runtime_role;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = runtime_role
      AND (
        rolcanlogin OR rolinherit OR rolsuper OR rolcreaterole OR rolcreatedb OR
        rolreplication OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'runtime deve ser NOLOGIN/NOINHERIT e sem privilégios administrativos';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = runtime_role
  ) THEN
    RAISE EXCEPTION 'runtime não pode ser membro de outras roles';
  END IF;

  IF has_schema_privilege(runtime_role, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'runtime não pode criar objetos no schema public';
  END IF;

  FOREACH tabela IN ARRAY tabelas_operacionais LOOP
    FOREACH privilegio IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
      IF NOT has_table_privilege(runtime_role, format('public.%I', tabela), privilegio) THEN
        RAISE EXCEPTION 'runtime deve ter % em %', privilegio, tabela;
      END IF;
    END LOOP;
    FOREACH privilegio IN ARRAY ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(runtime_role, format('public.%I', tabela), privilegio) THEN
        RAISE EXCEPTION 'runtime não pode ter % em %', privilegio, tabela;
      END IF;
    END LOOP;
  END LOOP;

  -- GF-3 CORRECTIVE-01 (F3) — RUNTIME_CAMPAIGN_GRANTS_AFTER_REAPPLY: 0002
  -- reaplicada DEPOIS de 0007 (REVOKE ALL + regrant condicional) deve deixar
  -- o runtime com SELECT/INSERT/UPDATE nas tabelas da campanha — e NUNCA
  -- DELETE/TRUNCATE/REFERENCES/TRIGGER.
  FOREACH tabela IN ARRAY ARRAY[
    'campanha_persistida', 'campanha_decisao', 'campanha_lote',
    'lote_campanha', 'outbox_campanha'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tabela
    ) THEN
      FOREACH privilegio IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
        IF NOT has_table_privilege(runtime_role, format('public.%I', tabela), privilegio) THEN
          RAISE EXCEPTION 'runtime deve ter % em % (campanha, pós-reapply)', privilegio, tabela;
        END IF;
      END LOOP;
      FOREACH privilegio IN ARRAY ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(runtime_role, format('public.%I', tabela), privilegio) THEN
          RAISE EXCEPTION 'runtime não pode ter % em % (campanha)', privilegio, tabela;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF NOT has_table_privilege(runtime_role, 'public.evento_auditoria', 'SELECT') OR
     NOT has_table_privilege(runtime_role, 'public.evento_auditoria', 'INSERT') THEN
    RAISE EXCEPTION 'runtime deve ter SELECT e INSERT em evento_auditoria';
  END IF;
  FOREACH privilegio IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege(runtime_role, 'public.evento_auditoria', privilegio) THEN
      RAISE EXCEPTION 'runtime não pode ter % em evento_auditoria', privilegio;
    END IF;
  END LOOP;

  IF NOT has_sequence_privilege(
    runtime_role,
    'public.evento_auditoria_sequencia_seq',
    'USAGE'
  ) THEN
    RAISE EXCEPTION 'runtime deve poder gerar a sequência da auditoria';
  END IF;
END
$$;

CREATE ROLE integra_app_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
GRANT integra_runtime TO integra_app_test;

SET ROLE integra_app_test;

-- Intake sintético: INSERT + SELECT + UPDATE pelas permissões herdadas.
INSERT INTO arquivo_importacao (
  id, origem, nome_original, mime_type, tamanho_bytes, sha256, storage_key
) VALUES (
  '61000000-0000-4000-8000-000000000001', 'PF', 'sintetico.xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 1,
  repeat('1', 64), 'test-only/runtime-role'
);

INSERT INTO perfil_mapeamento (
  id, origem, nome, versao, definicao, confirmado_por, confirmado_em
) VALUES (
  '62000000-0000-4000-8000-000000000001', 'PF', 'teste-runtime', 1,
  '{}'::jsonb, 'ator-sintetico', now()
);

INSERT INTO importacao (
  id, arquivo_importacao_id, perfil_mapeamento_id, origem, status
) VALUES (
  '63000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000001', 'PF', 'RECEBIDA'
);

INSERT INTO linha_importada (
  id, importacao_id, folha, numero_linha, dados_brutos_ciphertext,
  dados_brutos_nonce, dados_brutos_auth_tag, chave_versao, status
) VALUES (
  '63000000-0000-4000-8000-000000000002',
  '63000000-0000-4000-8000-000000000001', 'Sintetica', 2,
  decode('01', 'hex'), decode(repeat('02', 12), 'hex'),
  decode(repeat('03', 16), 'hex'), 'test-v1', 'VALIDA'
);

UPDATE importacao SET status = 'MAPEADA'
WHERE id = '63000000-0000-4000-8000-000000000001';

-- Fluxo operacional sintético completo até outbox.
INSERT INTO profissional (
  id, origem, codigo_operacional, tipo_documento,
  documento_ciphertext, documento_nonce, documento_auth_tag,
  documento_chave_versao, documento_fingerprint, status
) VALUES (
  '64000000-0000-4000-8000-000000000001', 'PF', 'SINTETICO-RUNTIME', 'CPF',
  decode('04', 'hex'), decode(repeat('05', 12), 'hex'),
  decode(repeat('06', 16), 'hex'), 'test-v1', repeat('2', 64), 'APTO_CONTATO'
);

INSERT INTO snapshot_cadastral (
  id, profissional_id, tipo, conteudo_ciphertext, conteudo_nonce,
  conteudo_auth_tag, chave_versao, fonte
) VALUES (
  '65000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001', 'ORIGINAL', decode('07', 'hex'),
  decode(repeat('08', 12), 'hex'), decode(repeat('09', 16), 'hex'),
  'test-v1', 'IMPORTACAO'
);

INSERT INTO confirmacao (
  id, profissional_id, token_hash, template_versao, status, emitida_em, expira_em
) VALUES (
  '66000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001', repeat('3', 64),
  'pf-confirmation-v1', 'PENDING', now(), now() + interval '1 hour'
);

INSERT INTO lote_comunicacao (
  id, origem, codigo, template_versao, status, criado_por
) VALUES (
  '67000000-0000-4000-8000-000000000001', 'PF', 'PF-MAIL-RUNTIME-001',
  'pf-confirmation-v1', 'ATIVO', 'ator-sintetico'
);

INSERT INTO comunicacao (
  id, profissional_id, confirmacao_id, lote_comunicacao_id, origem, provider,
  destinatario_fingerprint, template_versao, idempotency_key, status
) VALUES (
  '68000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001',
  '66000000-0000-4000-8000-000000000001',
  '67000000-0000-4000-8000-000000000001', 'PF', 'PENDING', repeat('4', 64),
  'pf-confirmation-v1', 'runtime:test:one', 'QUEUED'
);

INSERT INTO oauth_connection (
  id, provider, conta_fingerprint, scopes, access_token_ciphertext,
  access_token_nonce, access_token_auth_tag, chave_versao
) VALUES (
  '69000000-0000-4000-8000-000000000001', 'GMAIL', repeat('5', 64),
  ARRAY['https://www.googleapis.com/auth/gmail.send'], decode('0a', 'hex'),
  decode(repeat('0b', 12), 'hex'), decode(repeat('0c', 16), 'hex'), 'test-v1'
);

INSERT INTO outbox_email (
  id, comunicacao_id, idempotency_key, payload_ciphertext,
  payload_nonce, payload_auth_tag, chave_versao, status
) VALUES (
  '70000000-0000-4000-8000-000000000001',
  '68000000-0000-4000-8000-000000000001', 'runtime:test:one',
  decode('0d', 'hex'), decode(repeat('0e', 12), 'hex'),
  decode(repeat('0f', 16), 'hex'), 'test-v1', 'PENDING'
);

INSERT INTO item_lote_comunicacao (
  lote_comunicacao_id, profissional_id, comunicacao_id, origem, status
) VALUES (
  '67000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001',
  '68000000-0000-4000-8000-000000000001', 'PF', 'ENFILEIRADO'
);

UPDATE outbox_email SET status = 'PROCESSING', bloqueada_por = 'worker-sintetico'
WHERE id = '70000000-0000-4000-8000-000000000001';

SELECT count(*) AS registros_operacionais_visiveis FROM outbox_email;

-- GF-3 CORRECTIVE-01 (F3) — prova operacional das grants de campanha sob o
-- login herdado: INSERT + SELECT + UPDATE em campanha_persistida (DELETE
-- permanece bloqueado — provado abaixo).
INSERT INTO campanha_persistida (
  id, operator_id, fingerprint_arquivo, template_versao, hash_aprovacao,
  snapshot_registros, total_registros, total_aptos, total_bloqueados,
  total_aprovados, estado, criada_em, atualizada_em
) VALUES (
  '72000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-0000000000f1',
  repeat('7', 64), 'pf-expedicao-carteira-2026-v2', repeat('8', 64),
  '{"registros":[]}'::jsonb, 0, 0, 0, 0, 'APROVADA', now(), now()
);

SELECT count(*) AS campanhas_runtime_visiveis FROM campanha_persistida
WHERE id = '72000000-0000-4000-8000-000000000001';

UPDATE campanha_persistida SET estado = 'APROVADA'
WHERE id = '72000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  DELETE FROM campanha_persistida
  WHERE id = '72000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'DELETE em campanha deveria ser bloqueado';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

INSERT INTO evento_auditoria (
  id, agregado_tipo, agregado_id, tipo, ocorreu_em, hash_evento
) VALUES (
  '71000000-0000-4000-8000-000000000001', 'TESTE_ROLES',
  '64000000-0000-4000-8000-000000000001', 'TESTE_SINTETICO', now(), repeat('6', 64)
);

DO $$
BEGIN
  UPDATE evento_auditoria SET tipo = 'MUTADO'
  WHERE id = '71000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'UPDATE em auditoria deveria ser bloqueado';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

DO $$
BEGIN
  DELETE FROM profissional
  WHERE id = '64000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'DELETE operacional deveria ser bloqueado';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE TABLE runtime_ddl_proibido (id integer)';
  RAISE EXCEPTION 'CREATE no schema public deveria ser bloqueado';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

RESET ROLE;
ROLLBACK;
