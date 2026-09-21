# Ambiente Operacional PF — Validação Controlada

## Objetivo

Este Preview é a superfície única de execução para **Profissionais (PF)** durante a
validação operacional. A interface do operador não expõe PJ, produção, Gmail real
ou PPN. O backend continua modular e preserva os contratos já homologados, mas a
experiência operacional desta etapa é deliberadamente PF-only.

## Separação de produção

- Git: desenvolvimento somente em `feat/pf-gmail-pilot`; `main` não é alterada.
- Checkpoint imutável de referência: `checkpoint/pf-hard-gate-b-9c227f1`.
- Vercel: somente Preview da branch; não promover para Production.
- Banco: Neon `preview` / `integra_correios_preview`, com runtime role dedicado.
- `REAL_SEND_ENABLED=false`.
- `PPN_ENABLED=false`.
- OAuth/Gmail institucional não é requisito para DRY_RUN.

## Superfície do operador

A interface principal deve usar linguagem funcional e não técnica:

1. Importar arquivo.
2. Conferir colunas.
3. Revisar dados.
4. Salvar profissionais.
5. Selecionar contatos.
6. Revisar comunicação.
7. Acompanhar processamento.

Termos como `mapping`, `outbox`, `worker`, nomes de constraints, estados SQL e
detalhes de infraestrutura ficam fora do fluxo principal. Diagnósticos técnicos
podem existir, mas recolhidos em seção opcional para suporte.

## Critério para teste real controlado

O teste real só começa depois de:

- quality-gate verde no HEAD exato;
- Preview Vercel Ready no mesmo HEAD;
- readiness do banco/criptografia/persistência/worker em READY;
- recuperação de fluxo após refresh comprovada;
- DRY_RUN sintético concluído sem envio externo;
- UI PF-only validada visualmente;
- arquivo institucional real usado primeiro em preflight/read-only;
- nenhuma alteração cadastral automática e nenhum envio real nessa etapa.

## Evolução segura

A melhoria da interface não muda o Golden Profile dos Correios, contratos de
persistência, regras de criptografia ou gates de envio. Mudanças nesses domínios
continuam exigindo revisão própria. A camada visual pode evoluir rapidamente,
desde que mantenha os mesmos endpoints e invariantes do kernel operacional.
