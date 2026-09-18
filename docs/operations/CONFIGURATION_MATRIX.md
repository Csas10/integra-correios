# CONFIGURATION_MATRIX — Fase B (PF Gmail Pilot)

Inventário exato de toda a configuração usada pela vertical slice, verificado no
código (nomes reais, nada hipotético). Nenhum valor real no Git.

| NAME | OWNER | PURPOSE | REQUIRED_WHEN | SOURCE | SENSITIVE | DEFAULT_ALLOWED | CURRENT_STATUS |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` | Titular/ambiente | Conexão PostgreSQL 16 do estado operacional | API persistente, worker run-once, DRY_RUN | ENVIRONMENT | SIM (DSN) | NÃO | BLOCKED_EXTERNAL no Preview; provisionado na CI de teste |
| `DATA_ENCRYPTION_KEY_BASE64` | Titular/ambiente | Chave AES-256-GCM de dados recuperáveis (CPF, snapshots, outbox) | Persistência, cockpit, worker | ENVIRONMENT | SIM | NÃO | BLOCKED_EXTERNAL no Preview |
| `DATA_ENCRYPTION_KEY_VERSION` | Titular/ambiente | Versão da chave (rotação, envelope autenticado) | Persistência | ENVIRONMENT | NÃO | SIM (`v1`) | Default aplicado |
| `DOCUMENT_FINGERPRINT_KEY_BASE64` | Titular/ambiente | Chave HMAC-SHA-256 de dedup por documento/e-mail | Importação, lote | ENVIRONMENT | SIM | NÃO | BLOCKED_EXTERNAL no Preview |
| `CONFIRMATION_BASE_URL` | Titular/ambiente | Base das URLs de confirmação no e-mail | Lote/preview | ENVIRONMENT | NÃO | SIM (`https://preview.exemplo.test` em preview) | Default seguro de preview |
| `PORT` | Plataforma | Porta de escuta da API (0.0.0.0) | API | ENVIRONMENT | NÃO | SIM (`8787`) | OK |
| `PILOT_MODE` | Operação (env do processo) | Liga a execução controlada do worker run-once | Worker run-once | ENVIRONMENT | NÃO | SIM (`false`) | DISABLED por padrão (fail-closed) |
| `OPERATOR_TOKEN` | Operação (env do processo) | Bearer token das rotas OPERATOR_ROUTE (F10) | Todas as rotas operacionais no Preview | ENVIRONMENT | SIM | NÃO | Fail-closed: sem valor, NENHUMA rota operacional responde (401) |
| `VITE_API_BASE` | Plataforma/build do web | Base da API para o browser (opcional) | Preview/somente se API em outra origem | APPLICATION (build-time) | NÃO | SIM (mesma origem) | Default = mesma origem via adapter serverless `/api/*` — localhost NUNCA é usado no Preview |
| `PILOT_MAX_RECIPIENTS` | Operação (env do processo) | Hard cap server-side do piloto (1–100) | Preview, prepare, activate | ENVIRONMENT | NÃO | SIM (`5`) | OK, aplicado em 4 camadas |
| `REAL_SEND_ENABLED` | Operação (env do processo) | GATE 1 do envio externo (Gmail real) | Worker LIVE_PILOT | ENVIRONMENT | NÃO | SIM (`false`) | DISABLED — envio real proibido nesta fase |
| `MAIL_PROVIDER` | Operação (env do processo) | Seleção do gateway real (`gmail`) | LIVE_PILOT | ENVIRONMENT | NÃO | SIM (ausente = Disabled) | OK |
| `GMAIL_OAUTH_CLIENT_ID` | Titular (Google Cloud) | OAuth client do envio institucional | LIVE_PILOT | EXTERNAL_SECRET | SIM | NÃO | CONFIGURATION_REQUIRED |
| `GMAIL_OAUTH_CLIENT_SECRET` | Titular (Google Cloud) | OAuth client secret (somente server-side) | LIVE_PILOT | EXTERNAL_SECRET | SIM | NÃO | CONFIGURATION_REQUIRED |
| `GMAIL_OAUTH_REDIRECT_URI` | Titular (Google Cloud) | Redirect URI do OAuth (gmail.send) | LIVE_PILOT | EXTERNAL_SECRET | NÃO (URL) | NÃO | CONFIGURATION_REQUIRED |
| `GMAIL_OAUTH_STATE_KEY` | Titular/ambiente | Chave HMAC do state OAuth (CSRF assinado) | OAuth start/callback | ENVIRONMENT | SIM | NÃO | CONFIGURATION_REQUIRED |
| `GMAIL_ACCOUNT_FINGERPRINT` | Derivado | HMAC da conta institucional para `oauth_connection` | Conexão OAuth | DERIVED (da chave HMAC) | NÃO (fingerprint) | NÃO | DERIVED |
| Mapping (colunas → campos) | Operador (UI) | Confirmar mapping assistido do XLSX | Importação | APPLICATION (contrato versionado) | NÃO | NÃO | IMPLEMENTADO |
| `PPN_ENABLED` | — | Motor PPN/Correios | (fora do escopo desta fase) | HUMAN_DECISION | NÃO | SIM (`false`) | DISABLED deliberadamente |
| Liberação do lote (PREPARACAO → ATIVO) | Operador humano | GATE 2: elegibilidade da outbox | Envio (DRY_RUN também exige ATIVO) | HUMAN_DECISION + auditoria | NÃO | NÃO | IMPLEMENTADO (`/api/pilot/activate`) |

## Regras aplicadas

- **SOURCE = EXTERNAL_SECRET**: nunca inventado, nunca contornado; o código fica
  pronto e o estado vira `CONFIGURATION_REQUIRED`/`BLOCKED_EXTERNAL` no
  readiness até o titular configurar.
- **SOURCE = ENVIRONMENT**: lido apenas server-side (`process.env` do processo);
  o browser nunca define parâmetro efetivo.
- **Default allowed**: somente parâmetros não sensíveis e fail-closed.
- `REAL_SEND_ENABLED` e `PILOT_MODE` são GATES, não features: defaults fechados.

## Lista objetiva para o DRY_RUN no Preview (BLOCKED_EXTERNAL)

Para executar o DRY_RUN no Preview, o titular deve configurar **exatamente**:

1. `DATABASE_URL` — PostgreSQL 16 acessível pelo serviço;
2. `DATA_ENCRYPTION_KEY_BASE64` — chave AES-256-GCM (32 bytes, base64);
3. `DOCUMENT_FINGERPRINT_KEY_BASE64` — chave HMAC-SHA-256 (32 bytes, base64);
4. `DATA_ENCRYPTION_KEY_VERSION` — rótulo da versão (ex.: `v1`);
5. `PILOT_MODE=true` — habilita o worker run-once no ambiente;
6. `OPERATOR_TOKEN` — habilita as rotas operacionais (F10; a rota pública de
   confirmação `/api/confirmation` não depende dele).

Não é necessário nenhum segredo do Google para o DRY_RUN (o gateway é
sintético). Para o LIVE_PILOT, adicionam-se as credenciais OAuth do titular
(`GMAIL_OAUTH_*`) e a decisão humana de liberação do lote + `REAL_SEND_ENABLED`.
