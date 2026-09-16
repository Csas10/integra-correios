# Integra Correios

Fundação da versão 2.0 do fluxo operacional de pré-postagem dos Correios.

O projeto reúne PF e PJ em um único motor, mantendo identidade, lotes, retornos e
auditoria segregados por origem. XLSX, CSV, JSON, TXT e PDF são formatos de
entrada, saída ou evidência; não são o estado transacional da aplicação.

## Escopo desta fundação

- domínio PF/PJ e identidade operacional (`PF|CODIGO` ou `PJ|CODIGO`);
- estados e gates para contato, confirmação, validação, lote, retorno e reteste;
- Perfil Ouro PPN como contrato tipado e testado;
- contratos dos quatro templates oficiais, sem publicar as linhas de exemplo;
- adaptador Correios sem rede, credenciais ou chamadas reais;
- cockpit web React/Vite e shells compiláveis de API e worker;
- cockpit Apps Script somente leitura para o ecossistema Sheets/Drive atual;
- baseline Apps Script V1.8.5 preservada sem reformatação;
- CI com gates independentes de typecheck, testes, build e política do repositório.

Não existem neste repositório bases cadastrais, consultas SQL, migrations, seeds,
credenciais, arquivos `.env`, templates XLSX binários nem chamadas reais ao PPN.

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
apps/
  api/                    contrato stateless, sem servidor publicado
  web/                    cockpit React/Vite, sem fonte operacional conectada
  worker/                 orquestração por portas injetadas
  apps-script-cockpit/    primeira interface sobre Sheets/Drive
packages/
  domain/                 origem, identidade, estados e lotes
  correios/               Perfil Ouro, DTO e gateway
  importers/              contratos estruturais dos templates
  validation/             CPF, CNPJ, CEP e cabeçalhos
  audit/                  SHA-256, gates e eventos
  shared/                 tipos utilitários
assets/correios/templates/ manifesto dos originais mantidos fora do GitHub
docs/                     arquitetura, decisões e homologação
legacy/apps-script/       baseline V1.8.5 congelada
```

## Requisitos

- Node.js 22 ou 24
- npm 10 ou superior

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
| PostgreSQL | evolução documentada; não implementado nesta fase |
| Vercel | Preview da branch; produção continua vinculada à `main` |

Consulte [docs/architecture/overview.md](docs/architecture/overview.md) para os
limites completos da fundação.
