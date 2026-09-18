# HARD GATE B — Kernel Operacional Executável (Fase B)

Estado final da branch `feat/pf-gmail-pilot` conforme a diretriz de fechamento
do Runnable Pilot Kernel. Toda decisão seguiu o protocolo FIX_NOW /
SAFE_DEFAULT / BLOCK_EXTERNAL / DEFER_OUT_OF_SCOPE.

## Fluxo provado (um único motor)

```
XLSX (real ou sintético)
  → upload pela UI          POST /api/intake/analyze
  → mapping assistido       (sugestão + confirmação do operador)
  → preflight               POST /api/intake/preflight      (sem side effects)
  → confirmação             POST /api/intake/confirm        (PostgreSQL + snapshot + auditoria)
  → cockpit                 GET  /api/professionals
  → seleção ≤5              (hard cap server-side em 4 camadas)
  → preview                 POST /api/pilot/preview         (nunca envia)
  → lote PREPARACAO         POST /api/pilot/prepare         (outbox persistida, não elegível)
  → LIBERAÇÃO humana        POST /api/pilot/activate        (CAS PREPARACAO → ATIVO + auditoria)
  → worker run-once         POST /api/pilot/worker/run-once (uma iteração, mesmo motor do CLI)
  → DRY_RUN: gateway sintético → receipt persistido → auditoria
  → LIVE_PILOT: GmailHttpTransport (messages.send) — exige GATE 1 + GATE 2
```

## EXECUTION MODES — um só motor

| Modo | Gateway | Gate externo | Estado |
|---|---|---|---|
| PREFLIGHT | — | nenhum side effect | sempre disponível |
| DRY_RUN | `DryRunMailGateway` (sintético) | nenhum (rede não tocada) | implementado e testado |
| LIVE_PILOT | `GmailHttpTransport` (messages.send real) | GATE 1 (`REAL_SEND_ENABLED=true`) E GATE 2 (lote `ATIVO`) | implementado; execução proibida nesta fase |

## DECISION_LOG

| ISSUE | IMPACT_ON_PILOT | DECISION | ACTION | RESULT |
|---|---|---|---|---|
| Lote nascia `ATIVO` (envio liberado sem decisão humana) | Alto | FIX_NOW | `enqueueCommunicationBatch` cria `PREPARACAO`; `ativarLoteComunicacao` com CAS + auditoria | Gate 2 implementado e testado |
| `claimOutbox` não considerava o lote | Alto | FIX_NOW | JOIN com `lote_comunicacao`; só `ATIVO` é claimed | Regressões: PREPARACAO/CANCELADO não claimed |
| "Gmail não implementado" inaceitável | Alto | FIX_NOW | `composeMimeMessage` (RFC 2822/2047), `GmailHttpTransport` (base64url, messages.send, refresh, erros sanitizados) | Implementado; não executado (sem credenciais) |
| Readiness ambíguo | Médio | FIX_NOW | Contrato server-side `avaliarReadiness` + painel "Prontidão operacional" | Estados explícitos na UI, sem secrets |
| Worker não executável de ponta a ponta | Alto | FIX_NOW | `executarWorkerUmaVez` (readiness → claim → send → receipt → auditoria) + CLI one-shot + endpoint run-once | DRY_RUN E2E provado em teste |
| OAuth state quebrado (ISO com ms) | Alto | FIX_NOW | Payload em epoch ms assinado com HMAC | Teste de expiração/adulteração passa |
| Endereços completos não chegavam a PARSED | Médio | FIX_NOW | `extrairUf` preserva separadores | Testes de parsing passam |
| `.env.example` sem os parâmetros novos | Baixo | BLOCK_EXTERNAL | Escrita em `.env*` é bloqueada pela plataforma Freebuff; parâmetros documentados na CONFIGURATION_MATRIX | Doc entregue; arquivo a ajustar fora do sandbox |
| `DATABASE_URL`/chaves ausentes no Preview | Alto | BLOCK_EXTERNAL | Readiness marca `BLOCKED_EXTERNAL`; lista objetiva na CONFIGURATION_MATRIX | Única ação humana: configurar 5 variáveis |
| Credenciais Google OAuth ausentes | Alto | BLOCK_EXTERNAL | `GMAIL_OAUTH_* = CONFIGURATION_REQUIRED`; conexão real pelo titular | Código pronto; nada inventado |
| Envio real / ativação de lote real | Alto | BLOCK_EXTERNAL | `REAL_SEND_ENABLED=false`; `PPN` desabilitado; nenhum lote liberado | `REAL_SEND_EXECUTED=false` |
| Suíte E2E por tela (Playwright) | Nenhum para o piloto | DEFER_OUT_OF_SCOPE | UI funcional cobre o fluxo; automação de browser fica para PR própria | Não impede o piloto |

## READINESS_MATRIX (comportamento do endpoint `/api/readiness`)

| Subsistema | Sem env externo | Com DATABASE_URL + chaves + PILOT_MODE |
|---|---|---|
| Database | BLOCKED_EXTERNAL | READY |
| Cryptography | BLOCKED_EXTERNAL | READY |
| Intake | READY | READY |
| Persistence | BLOCKED_EXTERNAL | READY |
| Outbox | READY | READY |
| Worker | DISABLED (PILOT_MODE) | READY |
| Gmail transport | DISABLED | DISABLED (GATE 1 fechado) |
| Gmail OAuth | CONFIGURATION_REQUIRED | CONFIGURATION_REQUIRED |
| Real send | DISABLED | DISABLED |
| PPN | DISABLED | DISABLED |
| Modo | PREFLIGHT | DRY_RUN |

## INTERNAL_TODOS = 0

Caminho XLSX → mapping → persistence → cockpit → pilot batch → outbox →
worker → Gmail adapter → confirmation → audit: sem pendências internas.
Pendentes apenas EXTERNAL_CONFIGURATION e HUMAN_RELEASE (ver DECISION_LOG).

## Limitações conhecidas

- O E2E por tela (browser automatizado) é DEFER_OUT_OF_SCOPE; o fluxo da UI é
  funcional e o DRY_RUN E2E é provado por suíte de integração com PostgreSQL.
- `GMAIL_OAUTH_STATE_KEY` ainda não é lida automaticamente no construtor
  (`OauthStateSigner` é instanciado com chave explícita na ativação do OAuth do
  titular — Fase de conexão real).
- A CI com PostgreSQL 16 aplica as migrations e roda a suíte completa
  (incluindo concorrência e rollback); localmente, sem DATABASE_URL, os
  cenários de banco são pulados com motivo explícito.
