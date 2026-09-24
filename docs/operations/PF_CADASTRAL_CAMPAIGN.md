# Campanha de Atualização Cadastral PF — fundação

Esta branch cria uma superfície operacional nova e independente, preservando
integralmente o piloto Gmail controlado e o lote `CONTROLLED_GMAIL_TEST`.

## Hard gates da campanha

- `PF_CAMPAIGN_ENABLED` nasce desabilitada;
- `REAL_SEND_ENABLED=false` permanece obrigatório durante a construção;
- nenhuma planilha institucional é persistida no banco Preview;
- nenhum lote de campanha é criado;
- nenhum worker de campanha é executado;
- nenhuma chamada ao Gmail é feita;
- `canPersistImport=false`, `canCreateBatch=false` e `canExecute=false`.

## Importação e comunicação

O importador trabalha sobre a leitura XLSX segura existente. Ele preserva o
e-mail original, produz `email_normalizado`, exige identificador institucional,
bloqueia e-mails/identificadores duplicados e nunca usa nome/e-mail como chave
definitiva.

O template `pf-atualizacao-cadastral-2026-v1` mantém o assunto
`Confirmação dos dados para envio da Carteira Profissional` codificado em
RFC 2047 UTF-8. Nenhuma dessas estruturas está autorizada a persistir campanha
nesta fase.

## Identidade operacional individual

A identidade homologada permanece fail-closed:

- `operator_id` persistente, nome, código e status `ATIVO | SUSPENSO`;
- papéis `PREPARADOR`, `REVISOR`, `APROVADOR`, `EXECUTOR`,
  `SUPERVISOR` e `ADMIN_TECNICO`;
- token individual e sessão persistidos somente como SHA-256;
- vínculo obrigatório PostgreSQL `sessão → token → mesmo operador`;
- cookie `__Host-ic_campaign_operator_session` com `HttpOnly`, `Secure`,
  `SameSite=Strict` e `Path=/`;
- `GET /api/operator/me` expõe somente identidade, papéis e expiração;
- logout só limpa o cookie após revogação confirmada;
- as rotas da campanha não aceitam `OPERATOR_TOKEN` nem a sessão compartilhada
  do piloto como fallback.

### Histórico da migration 0006

Dentro da PR #12, a migration `0006_operator_identity.sql` foi executada apenas
no PostgreSQL 16 efêmero do quality-gate. Não houve execução identificada em
banco Preview ou outro ambiente persistente; por isso os corretivos desta fase
foram incorporados diretamente à `0006`.

Se surgir evidência externa de aplicação persistente de uma versão anterior,
essa premissa deve ser reavaliada antes do merge e a evolução deverá ocorrer
por migration aditiva.

## Ciclo administrativo individual

As ações administrativas normais exigem sessão individual com papel
`ADMIN_TECNICO`. O `OPERATOR_TOKEN` compartilhado não autoriza
provisionamento, suspensão, rotação ou recuperação de credencial.

A autorização é verificada duas vezes: na borda HTTP e novamente **dentro da
mesma transação PostgreSQL da mutação**, com lock do operador executor e do
papel `ADMIN_TECNICO`. Se o executor estiver suspenso, não tiver o papel ou
o papel tiver sido revogado, a transação falha sem alterar o alvo.

Cada ação grava na auditoria append-only:

- `operator_id`: operador alvo;
- `ator_operator_id`: administrador individual autenticado;
- `ator_id`: o mesmo UUID do administrador, para compatibilidade com o
  contrato histórico de auditoria.

Cada token também registra `emitido_por_operator_id`.

### Provisionamento

O endpoint administrativo recebe somente o SHA-256 de uma credencial forte.
O `operator_id` do novo operador é criado no servidor e a autoria é o
`ADMIN_TECNICO` autenticado.

A API não aceita segredo bruto em provisionamento.

### Geração forte de credencial

O repositório inclui um gerador local CSPRNG de 256 bits:

```bash
npm run operator:credential -- --out operador-001.operator-credential.json
```

Em sistemas POSIX, o artefato é criado com permissão `0600`, a permissão é
verificada após a gravação, o arquivo existente nunca é sobrescrito e o padrão
é ignorado pelo Git. O terminal recebe apenas o SHA-256 e o caminho do arquivo;
a credencial bruta não é impressa em stdout/stderr.

No Windows, `mode/chmod` do Node não garante ACL equivalente. Enquanto uma
política ACL explícita não for implementada, o gerador e o bootstrap **falham
fechado antes de criar o arquivo secreto**, retornando
`WINDOWS_ACL_UNSUPPORTED`. Portanto, a geração atual deve ser executada apenas
em ambiente POSIX controlado.

O arquivo contém material secreto e deve ser entregue ao operador somente por
canal institucional aprovado. Apenas o SHA-256 é enviado à API administrativa.

### Rotação

`POST /api/operator/admin/credentials/rotate` exige `ADMIN_TECNICO`
individual. A operação:

1. revoga credenciais ativas do operador;
2. revoga sessões ativas;
3. persiste somente o novo hash;
4. registra o administrador individual como emissor e ator;
5. nunca devolve o segredo bruto.

### Recuperação

`POST /api/operator/admin/credentials/recover` não recupera a credencial antiga.
Credenciais são hash-only e, portanto, não são reversíveis. Recuperação significa
substituição controlada: gerar nova credencial, revogar o estado anterior e
persistir apenas o novo hash, com autoria individual.

### Suspensão

A suspensão também exige `ADMIN_TECNICO` individual, revoga tokens e sessões
e registra a identidade do administrador executor.

### Bootstrap inicial

Não há fallback HTTP para `TECH_ADMIN_LEGACY`. O bootstrap é um comando de
implantação não HTTP:

```bash
DATABASE_URL=... npm run operator:bootstrap-admin -- \
  --code ADMIN-INICIAL \
  --name "Administrador Inicial" \
  --out admin-inicial.operator-credential.json
```

O comando:

1. exige PostgreSQL configurado e plataforma com artefato secreto suportado;
2. gera uma credencial CSPRNG de 256 bits;
3. cria o artefato local protegido;
4. abre uma transação e bloqueia a tabela de operadores;
5. exige **exatamente zero operadores**;
6. cria operador, papel `ADMIN_TECNICO`, somente o hash da credencial e o
   evento append-only `ADMIN_BOOTSTRAP_INICIAL`;
7. recusa qualquer segunda execução; em falha, remove o artefato recém-criado.

O bootstrap não usa Bearer compartilhado e não autoriza campanha, lote, outbox,
worker ou Gmail.

## Corretivos da revisão manual

A revisão manual do CodeRabbit sobre o HEAD `677614c64ea375a0f3afca5a5e375fdbae0eeb12`
originou cinco corretivos obrigatórios, sem abrir capacidades da campanha:

- o compositor MIME compartilhado divide assuntos UTF-8 em múltiplos
  `encoded-word` RFC 2047, cada um com no máximo 75 caracteres e sem cortar
  caracteres UTF-8;
- logout individual é idempotente: sessão já inativa remove o cookie e retorna
  sucesso; erro de persistência continua retornando `503`;
- rotas administrativas validam UUID, limites de tamanho e expiração antes do
  repositório e retornam `422` para entrada inválida;
- o pré-voo rejeita local-part de e-mail iniciado/terminado por ponto ou com
  pontos consecutivos;
- suspensão administrativa é transacionalmente protegida contra auto-suspensão
  e preserva administração técnica ativa, bloqueando o conjunto de
  `ADMIN_TECNICO` ativos durante a decisão.

## Corretivos da segunda revisão integral

A revisão formal do CodeRabbit sobre o HEAD
`1a8dadc33019b3823adf05029213115ce2e91379` originou três novos corretivos,
sem abrir capacidades da campanha:

- a normalização de e-mail remove somente whitespace nas extremidades; qualquer
  whitespace interno permanece no valor normalizado e torna o registro
  `EMAIL_INVALIDO`, evitando reescrita silenciosa para outra caixa postal;
- logout da interface trata `401` como sessão já encerrada e remove a
  identidade visual; `503` e falha de rede continuam preservando a identidade
  exibida porque a revogação é incerta;
- assuntos UTF-8 usam encoded-words RFC 2047 com payload reduzido e header
  folding `\r\n `; cada linha física do `Subject:` permanece com no máximo
  76 caracteres e os testes desdobram as continuações antes de reconstruir o
  assunto.

## Gate restante

Este incremento fecha o ciclo administrativo básico em código, mas a PR #12
deve permanecer Draft até homologação independente desse ciclo. Persistência da
campanha continua proibida.

Os gates executáveis permanecem:

```
canPersistImport = false
canCreateBatch   = false
canExecute       = false
```
