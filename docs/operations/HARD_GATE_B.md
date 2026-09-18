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
| **F1** Preview sem backend operacional | Alto | FIX_NOW | `despachar()` headless em apps/api reutilizado por `api/index.ts` (adapter serverless); `vercel.json` roteia `/api/*`; UI usa a mesma origem no Preview (localhost apenas em dev local) | Backend real provado: `/api/health`, `/api/readiness` e todas as rotas pela MESMA ROTAS do servidor Node — nenhuma regra duplicada |
| **F2** OAuth Gmail não conectado ponta a ponta | Alto | FIX_NOW | `GET /api/oauth/gmail/start` (state assinado HMAC, epoch ms) + `/api/oauth/gmail/callback` (troca server-side, tokens cifrados, `saveOauthConnection`, auditoria sem secrets; tokens JAMAIS retornam ao browser); readiness lê `oauth_connection` via `existeConexaoGmailAtiva()` | `connected=false` fixo removido |
| **F3** Gateway LIVE sem token | Alto | FIX_NOW | `criarAccessTokenProvider`: oauth_connection → decrypt → expiry → refresh → `refreshOauthAccessToken` persiste o envelope renovado → GmailHttpTransport | LIVE possível por construção (sem secrets em log) |
| **F4** threadId do Gmail descartado | Alto | FIX_NOW | `MailReceipt.threadId` opcional; propagado GmailHttpTransport → gateway → worker → `markOutboxAccepted` → `comunicacao.provider_thread_id` | Regressão V0 persiste e lê o threadId |
| **F5** Confirmação somente visual | Alto | FIX_NOW | `GET /api/confirmation?token=` (contexto mínimo) + `POST /api/confirmation` (consumePending CAS → snapshot decidido cifrado → workflow → APTO_PREPOSTAGEM/PENDENCIA_CADASTRAL → auditoria); ConfirmationPage chama o backend real | Replay/expiração FAIL CLOSED; sem CPF/código/UUID na URL |
| **F6** Browser escolhia LIVE | Alto | FIX_NOW | run-once executa `executarWorkerUmaVez` (DRY_RUN hardcoded server-side; corpo da requisição ignorado); LIVE em `executarWorkerUmaVezLive` separado, não exposto por rota nenhuma | `REAL_SEND_EXECUTED=false` |
| **F7** DRY_RUN indistinguível de LIVE | Alto | FIX_NOW | Migration 0003: `lote_comunicacao.modo` (DRY_RUN\|LIVE_PILOT, nascido no INSERT, auditado) + `provider='DRY_RUN'` na comunicação; claim filtra por lote; worker valida divergência de modo (fail-closed) | messageId sintético nunca ocupa identidade Gmail |
| **F8** Importação não atômica | Alto | FIX_NOW | `registrarImportacaoPf` no persistence package: UMA transação (arquivo → importação → linhas → profissionais → snapshots → auditoria); intake só pré-processa | Teste de falha no meio: ROLLBACK integral nas 6 tabelas |
| **F9** `linhas_validas` incorreta | Alto | FIX_NOW | Contagens semânticas no persistence: válidas (elegíveis) / pendentes / inválidas / criados separados | Regressão: 1ª importação e reimportação do mesmo SHA (criados=0, válidas=2) |
| **F10** Rotas operacionais abertas | Alto | FIX_NOW | `OPERATOR_TOKEN` (Bearer, comparação em tempo constante) em TODA rota operacional; fail-closed sem o segredo; `ROTAS_PUBLICAS` explícitas (health, confirmação) | `/api/confirmation` permanece pública por capability token |
| **F11** Preflight com chave fixa | Médio | FIX_NOW | Dedup em memória por `Set` do documento normalizado; nenhum fingerprint com chave de desenvolvimento é persistido | Semântica de segurança correta |
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
| Gmail OAuth (conexão persistida) | — | CONNECTED somente após fluxo start/callback do titular |
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
- `.env.example` não pôde ser editado (escrita em `.env*` bloqueada pela
  plataforma); `OPERATOR_TOKEN` e gates estão documentados na
  CONFIGURATION_MATRIX.
- A conexão OAuth real (start/callback do titular) e o DRY_RUN E2E no Preview
  dependem das variáveis externas listadas na CONFIGURATION_MATRIX
  (BLOCKED_EXTERNAL até a configuração).
- A CI com PostgreSQL 16 aplica as migrations e roda a suíte completa
  (incluindo concorrência e rollback); localmente, sem DATABASE_URL, os
  cenários de banco são pulados com motivo explícito.
