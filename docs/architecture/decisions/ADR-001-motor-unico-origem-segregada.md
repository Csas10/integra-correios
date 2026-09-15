# ADR-001 — Motor único com origem segregada

- Estado: aceito
- Data: 2026-09-15

## Contexto

PF e PJ seguem o mesmo fluxo geral de normalização, validação, pré-postagem,
retorno e auditoria. Manter dois sistemas duplicaria regras e correções.

## Decisão

Usar um único motor e tornar `ORIGEM = PF | PJ` obrigatória na identidade, nos
lotes e nos eventos. Um item PJ nunca pode integrar lote PF, e vice-versa.

## Consequências

- regras técnicas são reutilizadas;
- filtros operacionais podem exibir todos, profissionais ou empresas;
- auditoria e reconciliação permanecem independentes;
- documentos duplicados podem ser registrados como inconsistência.
