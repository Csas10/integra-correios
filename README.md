# Integra Correios

Fundação da versão 2.0 do fluxo operacional de pré-postagem dos Correios.

O projeto reúne PF e PJ em um único motor, mantendo identidade, lotes, retornos e
auditoria segregados por origem. XLSX, CSV, JSON, TXT e PDF são formatos de
entrada, saída ou evidência; não são o estado transacional da aplicação.

## Escopo desta fundação

- domínio PF/PJ e identidade operacional (`PF|CODIGO` ou `PJ|CODIGO`);
- estados e gates para triagem PF, confirmação, validação, lote, retorno e reteste;
- workflow PF com token seguro, snapshot original/confirmado e comunicação desacoplada;
- adapter Resend de homologação bloqueado por modo e whitelist de até cinco destinatários;
- Perfil Ouro PPN como contrato tipado e testado;
- contratos dos quatro templates oficiais, sem publicar as linhas de exemplo;
- adaptador Correios sem rede, credenciais ou chamadas reais;
- cockpit web React/Vite, webhook efêmero de homologação e worker com comando deliberado;
- cockpit Apps Script somente leitura para o ecossistema Sheets/Drive atual;
- baseline Apps Script V1.8.5 preservada sem reformatação;
- CI com gates independentes de typecheck, testes, build e política do repositório.
- PostgreSQL transacional para intake, snapshots, confirmações, comunicações e auditoria;
- outbox de e-mail persistente, ainda sem adapter Gmail nem envio operacional.

Não existem neste repositório bases cadastrais, seeds, credenciais, arquivos `.env`,
templates XLSX binários nem chamadas reais ao PPN.
O envio de e-mail permanece desabilitado por padrão e não é executado pelos gates.

## Áreas do cockpit

1. Entrada
2. Validação
3. Lotes
4. Retornos
5. Gestão

As quantidades são calculadas em tempo de execução a partir da fonte autorizada.
O código não mantém contagens cadastrais fixas nem dados de demonstração.

## Estrutura

```text
api/
  webhooks/resend.ts      endpoint assinado e sem persistência para o spike
apps/
  api/                    contrato stateless, sem servidor publicado
  web/                    cockpit React/Vite, sem fonte operacional conectada
  worker/                 orquestração e comando controlado de homologação
  apps-script-cockpit/    primeira interface sobre Sheets/Drive
packages/
  domain/                 origem, identidade, estados e lotes
  correios/               Perfil Ouro, DTO e gateway
  importers/              contratos estruturais dos templates
  validation/             CPF, CNPJ, CEP e cabeçalhos
  audit/                  SHA-256, gates e eventos
  shared/                 tipos utilitários
  mail/                   MailGateway, ConversationGateway e templates versionados
  pf-workflow/            triagem, confirmação, validação e gate APTO_PREPOSTAGEM
  persistence/            contratos, criptografia e adapter PostgreSQL
database/
  migrations/             schema operacional versionado
  tests/                  regressões SQL transacionais sem dados reais
assets/correios/templates/ manifesto dos originais mantidos fora do GitHub
docs/                     arquitetura, decisões e homologação
legacy/apps-script/       baseline V1.8.5 congelada
```

## Requisitos

- Node.js 22 ou 24
- npm 10 ou superior
- PostgreSQL 16 para os testes de constraints da migration

## Gates locais

```bash
npm ci
npm run policy:repo
npm run typecheck
npm test
npm run build
npm run build:web
```

Cada gate possui finalidade própria: análise estática, regressão automatizada,
compilação real e verificação de que artefatos proibidos não entraram no Git.

## Estado das integrações

| Integração | Estado nesta fase |
|---|---|
| Google Sheets/Drive | adaptador do cockpit; sem IDs no código novo |
| Correios PPN | contrato e serialização puros; rede desabilitada |
| Resend | adapter de homologação; envio bloqueado sem modo, segredo e whitelist explícitos |
| PostgreSQL | schema operacional e adapter implementados; sem dados ou conexão de produção |
| Gmail | somente contratos de credencial/outbox; API e envio não implementados |
| Vercel | Preview da branch; produção continua vinculada à `main` |

## Confirmação cadastral PF

A carteira PF passa por `triagem → comunicação → confirmação/atualização →
validação` antes de qualquer lote. O cockpit expõe a fila estrutural e uma rota
de formulário `/confirma/:token`; os valores permanecem vazios nesta fase.
Somente `APTO_PREPOSTAGEM` libera a entrada no lote. Consulte
[docs/architecture/pf-confirmation-workflow.md](docs/architecture/pf-confirmation-workflow.md)
e [ADR-005](docs/architecture/decisions/ADR-005-confirmacao-pf-e-mail-desacoplado.md).

## Homologação técnica de e-mail

A etapa `0.5` permite enviar apenas o template sintético `pf-confirmation-v1`
para até cinco destinatários controlados. O comando exige confirmação explícita,
o adapter aplica whitelist antes de chamar o provedor e o webhook registra apenas
identificadores, status e timestamp. Consulte
[o roteiro de homologação](docs/homologation/pf-mail-channel.md) e
[ADR-006](docs/architecture/decisions/ADR-006-homologacao-canal-email.md).

Essa etapa não persiste confirmações, não cria outbox, não promove registros a
`APTO_PREPOSTAGEM` e não autoriza comunicação com profissionais reais.

## Persistência operacional

A migration `0001_operational_persistence.sql` introduz a fronteira transacional
para importação, snapshots, confirmação, comunicação e auditoria. O documento
recuperável, snapshots, payloads da outbox e tokens OAuth são cifrados na
aplicação; deduplicação usa fingerprint HMAC, sem guardar CPF/CNPJ em texto.

O clique futuro em “enviar” deverá somente criar, atomicamente, na **mesma
transação**: `lote_comunicacao`, `item_lote_comunicacao`, `confirmacao`,
`comunicacao`, `outbox_email` e os `evento_auditoria` do lote e de cada item.
Qualquer falha reverte o lote inteiro. O adapter Gmail e o worker de envio não
fazem parte desta entrega. Consulte [database/README.md](database/README.md) e
[ADR-004](docs/architecture/decisions/ADR-004-postgresql-futuro.md).

Em produção, `integra_runtime` é uma role-grupo PostgreSQL `NOLOGIN`. A
`DATABASE_URL` usa um login exclusivo do ambiente, provisionado fora do Git e
associado por `GRANT integra_runtime`; o login administrativo de migrations é
separado e não é usado pela aplicação.

Consulte [docs/architecture/overview.md](docs/architecture/overview.md) para os
limites completos da fundação.
