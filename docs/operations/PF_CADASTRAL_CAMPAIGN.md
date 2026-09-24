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

O artefato é criado com permissão `0600`, não sobrescreve arquivo existente e
é ignorado pelo Git. O terminal recebe apenas o SHA-256 e o caminho do arquivo;
a credencial bruta não é impressa em stdout/stderr.

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

Não há fallback HTTP para `TECH_ADMIN_LEGACY`. O primeiro `ADMIN_TECNICO` de
um ambiente novo deve ser criado em um gate de implantação controlado, usando
credencial gerada pelo mecanismo acima e autoria autoidentificada no registro
inicial. Esse bootstrap não autoriza campanha, lote, outbox, worker ou Gmail.

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
