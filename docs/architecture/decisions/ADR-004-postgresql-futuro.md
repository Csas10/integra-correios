# ADR-004 — PostgreSQL é uma evolução futura

- Estado: proposto
- Data: 2026-09-15

PostgreSQL continua sendo a opção prevista quando concorrência, filas e usuários
simultâneos justificarem a migração. Não há migration, seed, conexão ou consulta
SQL nesta fundação.

Antes de implementar, o gate deverá definir:

- reserva concorrente de itens com bloqueio transacional;
- preservação integral de duplicidades de ingestão;
- eventos e gates append-only;
- nenhuma exclusão em cascata de evidência;
- `TIMESTAMPTZ` para timestamps;
- texto para códigos, documentos e CEPs;
- SHA-256 obrigatório nos arquivos.
