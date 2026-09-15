# ADR-002 — Cockpit Apps Script primeiro

- Estado: aceito
- Data: 2026-09-15

## Contexto

O fluxo PJ já foi validado em planilha e Apps Script. Uma migração imediata para
React, API, worker e PostgreSQL acrescentaria infraestrutura antes de comprovar a
experiência operacional PF/PJ.

## Decisão

Entregar primeiro um cockpit somente leitura no ecossistema Sheets/Drive. Ele
calcula indicadores agregados e não expõe linhas cadastrais. A baseline V1.8.5
permanece separada e imutável.

## Consequências

- nenhuma escrita ou chamada PPN é acionada pela interface inicial;
- autenticação segue o domínio Google durante a prova controlada;
- web/API/worker permanecem shells compiláveis para migração futura;
- habilitar ações exige gate específico e testes sobre cópia controlada.
