# Regras dos scanners de secrets e PII

Comandos reproduzíveis (idênticos local e CI, sem chamadas externas ou
telemetria):

```sh
npm run security:secrets
npm run security:pii
```

Ambos sempre varrem o snapshot dos arquivos rastreados pelo git
(`git ls-files --cached`), lendo o working tree com fallback para `HEAD`.
Também verificam cada blob alterado em todos os commits introduzidos no
intervalo base → head: na CI, o intervalo vem de
`SECURITY_SCAN_BASE_SHA`/`SECURITY_SCAN_HEAD_SHA`; localmente, usa-se
`origin/main..HEAD` quando essa referência existe. Assim, adicionar um valor
sensível em um commit e removê-lo em outro não faz o gate passar.

A saída exibe somente arquivo, linha, regra e, para histórico, o SHA abreviado
do commit — **nunca o conteúdo do match**. Exit code != 0 em qualquer
violação. Informar apenas um dos dois SHAs ou um intervalo que não possa ser
resolvido também falha o gate.

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
| dsn-with-credentials | forma `<esquema>://<usuário>:<senha>@<host>` para esquemas suportados |

A regra `config-sensivel-nao-vazio` **não está ativa**: a política
estrutural (`npm run policy:repo`) já é a barreira primária contra arquivos
de ambiente não permitidos; se um dia forem admitidos outros arquivos de
configuração sensíveis, a regra deve ser implementada em
`SENSITIVE_CONFIG_NONEMPTY` com padrões explícitos e documentada aqui.

## PII scan (`security:pii`)

Foca testes, fixtures, docs e exemplos. Cobre:

| Regra | Padrão |
| --- | --- |
| cpf-formatado | forma `DDD.DDD.DDD-DD` |
| cnpj-formatado | forma `DD.DDD.DDD/DDDD-DD` |
| cpf-sem-mascara | 11 dígitos, somente em test/tests/fixtures/docs e com DV válido |
| cnpj-sem-mascara | 14 dígitos, somente em test/tests/fixtures/docs e com DV válido |
| email-institucional | domínios institucionais conhecidos |
| telefone-br | formatos brasileiros com/sem +55 |

Sequências repetidas ou com dígito verificador inválido não são tratadas como
CPF/CNPJ sem máscara. Isso mantém fixtures negativas sintéticas — como zeros e
repetidos — sem reduzir a detecção de identificadores válidos.

## Exceções (narrow, por arquivo + regra)

A allowlist NUNCA exclui um arquivo inteiro do scan — cada exceção é
por arquivo **e** por regra, com motivo declarado:

| Arquivo | Regras | Motivo |
| --- | --- | --- |
| `.github/workflows/ci.yml` | somente `dsn-with-credentials`, e somente o valor sintético exato | DSN do service container efêmero de teste |
| `packages/importers/test/intake-mapping.test.ts` | `cpf-sem-mascara` e `cnpj-sem-mascara`, somente os matches sintéticos exatos já usados pelo teste | preservação tipada e validação do importador |
| `docs/security/scan-rules.md` | `cpf-formatado`, `cnpj-formatado` e `dsn-with-credentials`, somente no histórico e para notações sintéticas exatas presentes em commits anteriores da PR #9 | varredura histórica sem classificar placeholders conhecidos como PII/secret real |
| `tests/security-scan.test.mjs` | `cpf-formatado` e `dsn-with-credentials`, somente no histórico e para fixtures sintéticas exatas presentes em commit anterior da PR #9 | varredura histórica da regressão do próprio scanner |

Não existe wildcard de regra nem exclusão integral de arquivo. Qualquer outro
match, inclusive outra credencial no mesmo arquivo, continua sendo reportado.
Qualquer adição à lista exige revisão humana na PR.

## Limitações

São **guardrails heurísticos, não prova absoluta** de ausência de
secrets/PII:

- padrões simples podem escapar (secrets codificados, divididos,
  ofuscados ou de provedores não listados);
- o histórico anterior ao intervalo base → head não é revarrido por esse gate;
- CPF/CNPJ sem máscara são cobertos apenas em test/tests/fixtures/docs e
  exigem dígito verificador válido; outros tipos de PII podem escapar;
- a allowlist reduz falso-positivos mas também limita a cobertura.

A política estrutural (`npm run policy:repo`) continua sendo a barreira
primária contra arquivos de ambiente e dados operacionais.
