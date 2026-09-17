# Regras dos scanners de secrets e PII

Comandos reproduzíveis (idênticos local e CI, sem chamadas externas ou
telemetria):

```sh
npm run security:secrets
npm run security:pii
```

Ambos varrem apenas arquivos rastreados pelo git (`git ls-files --cached`),
lendo o working tree com fallback para `HEAD`. Saída exibe somente arquivo,
linha e a regra que casou — **nunca o conteúdo do match**. Exit code != 0
em qualquer violação.

## Secret scan (`security:secrets`)

Cobre no mínimo:

| Regra | Padrão |
| --- | --- |
| private-key | `-----BEGIN ... PRIVATE KEY-----` |
| github-pat / oauth / app | `ghp_` / `gho_` / `ghs_` / `ghr_` + 36+ chars |
| google-oauth-client-secret | `GOCSPX-...` |
| google-api-key | `AIza...` |
| resend-api-key | `re_...` (30+ chars) |
| slack-token | `xox...` |
| dsn-with-credentials | `postgres://user:senha@...` e similares |
| config-sensivel-nao-vazio | `.env.example` não vazio (fora de política) |

## PII scan (`security:pii`)

Foca testes, fixtures, docs e exemplos. Cobre:

| Regra | Padrão |
| --- | --- |
| cpf-formatado | `000.000.000-00` |
| cnpj-formatado | `00.000.000/0000-00` |
| email-institucional | domínios institucionais conhecidos |
| telefone-br | formatos brasileiros com/sem +55 |

Exclui por política: fixtures sintéticas homologadas de
`packages/domain/test` e `packages/validation/test` (valores inválidos
propositalmente — zeros/repetidos — usados pelos testes de dígito
verificador).

## Allowlist mínima

`scripts/security-scan.mjs` (define as regras),
`tests/security-scan.test.mjs` (testes),
`docs/security/scan-rules.md` (esta página),
`.github/workflows/ci.yml`.

Qualquer adição à allowlist exige revisão humana na PR.

## Limitações

São **guardrails heurísticos, não prova absoluta** de ausência de
secrets/PII:

- padrões simples podem escapar (secrets codificados, divididos,
  ofuscados ou de provedores não listados);
- o PII scan é focado em fixtures/docs e não cobre todos os formatos;
- a allowlist reduz falso-positivos mas também limita a cobertura.

A política estrutural (`npm run policy:repo`) continua sendo a barreira
primária contra arquivos de ambiente e dados operacionais.
