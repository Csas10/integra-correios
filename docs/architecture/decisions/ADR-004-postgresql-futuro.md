# ADR-004 — PostgreSQL como estado operacional

- Estado: aceito
- Data: 2026-09-16

PostgreSQL passa a ser a fronteira de consistência para importações, profissionais,
snapshots, confirmações, comunicações, outbox e auditoria. Planilhas continuam
como entrada, saída e oráculo de regressão; não são o estado operacional.

## Decisões

- reserva concorrente da outbox com `FOR UPDATE SKIP LOCKED`;
- preservação integral de duplicidades de ingestão;
- auditoria append-only protegida contra `UPDATE` e `DELETE`;
- nenhuma exclusão em cascata de evidência;
- `TIMESTAMPTZ` para timestamps;
- texto para códigos e fingerprints; documentos recuperáveis são cifrados;
- SHA-256 obrigatório nos arquivos;
- HMAC-SHA-256 com chave separada para deduplicação por documento;
- AES-256-GCM com contexto autenticado e versão de chave para dados recuperáveis;
- índice parcial para impedir o mesmo profissional em dois lotes ativos;
- compare-and-set atômico para consumo único do token de confirmação;
- criação transacional de lote, confirmação, comunicação, outbox e auditoria.

## Limites

A migration e o adapter não incluem credenciais, conexão de produção, Gmail API,
envio real, seeds ou dados amostrais. O PostgreSQL garante a atomicidade entre
processos somente quando o adapter persistente for usado; o owner em memória
continua restrito a testes de processo único.
