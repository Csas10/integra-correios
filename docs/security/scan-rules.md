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

A regra `config-sensivel-nao-vazio` **não está ativa**: a política
estrutural (`npm run policy:repo`) já é a barreira primária contra arquivos
de ambiente não permitidos; se um dia forem admitidos outros arquivos de
configuração sensíveis, a regra deve ser implementada em
`SENSITIVE_CONFIG_NONEMPTY` com padrões explícitos e documentada aqui.

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

## Exceções (narrow, por arquivo + regra)

A allowlist NUNCA exclui um arquivo inteiro do scan — cada exceção é
por arquivo **e** por regra, com motivo declarado:

| Arquivo | Regras | Motivo |
| --- | --- | --- |
| `scripts/security-scan.mjs` | todas | fonte das próprias regras (padrões sintéticos) |
| `tests/security-scan.test.mjs` | todas | fixtures sintéticas dos testes do scanner |
| `docs/security/scan-rules.md` | todas | documentação das formas dos padrões |
| `.github/workflows/ci.yml` | somente `dsn-with-credentials` | DSNs sintéticos do service container efêmero de teste |

Qualquer OUTRA regra que casar nesses arquivos continua sendo
reportada. Qualquer adição à lista exige revisão humana na PR.

## Limitações

São **guardrails heurísticos, não prova absoluta** de ausência de
secrets/PII:

- padrões simples podem escapar (secrets codificados, divididos,
  ofuscados ou de provedores não listados);
- o PII scan é focado em fixtures/docs e não cobre todos os formatos;
- a allowlist reduz falso-positivos mas também limita a cobertura.

A política estrutural (`npm run policy:repo`) continua sendo a barreira
primária contra arquivos de ambiente e dados operacionais.
