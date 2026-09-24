# Campanha de Atualização Cadastral PF — fundação

Esta branch cria uma superfície operacional nova e independente, preservando
integralmente o piloto Gmail controlado e o lote `CONTROLLED_GMAIL_TEST`.

## Hard gates

- `PF_CAMPAIGN_ENABLED` nasce desabilitada;
- `REAL_SEND_ENABLED=false` permanece obrigatório durante a construção;
- nenhuma planilha institucional é persistida no banco Preview;
- nenhum lote de campanha é criado;
- nenhum worker de campanha é executado;
- nenhuma chamada ao Gmail é feita;
- `OPERATOR_TOKEN` não representa identidade humana da campanha;
- `canPersistImport=false`, `canCreateBatch=false` e `canExecute=false`.

## Importação

O importador trabalha sobre a leitura XLSX segura existente. Ele preserva o
e-mail original, produz `email_normalizado`, exige identificador institucional,
bloqueia e-mails/identificadores duplicados e nunca usa nome/e-mail como chave
definitiva.

Estados de pré-voo: `APTO`, `BLOQUEADO` e `EXCLUIDO_DO_LOTE` (este último
reservado à decisão humana).

## Comunicação

Template: `pf-atualizacao-cadastral-2026-v1`.

Assunto semântico: `Confirmação dos dados para envio da Carteira Profissional`.

O MIME codifica assunto não-ASCII em RFC 2047 Base64 UTF-8 e mantém
`text/plain; charset=UTF-8` e `text/html; charset=UTF-8`.

A mensagem pede resposta com telefone/WhatsApp, CEP, logradouro, número,
complemento, bairro, cidade, UF e protocolo não sensível. A rota de confirmação
existente permanece, mas o template desta campanha não depende dela.

## Identidade operacional individual

A identidade foi implementada sem abrir capacidade de campanha:

- `operator_id` persistente, nome, código e status `ATIVO | SUSPENSO`;
- papéis `PREPARADOR`, `REVISOR`, `APROVADOR`, `EXECUTOR`,
  `SUPERVISOR` e `ADMIN_TECNICO`;
- token individual armazenado somente como SHA-256;
- sessão opaca armazenada somente como SHA-256;
- vínculo obrigatório no PostgreSQL entre sessão, token e o mesmo operador;
- cookie `__Host-ic_campaign_operator_session` com `HttpOnly`, `Secure`,
  `SameSite=Strict` e `Path=/`;
- `GET /api/operator/me` expõe apenas identidade, papéis e expiração;
- suspensão revoga tokens e sessões na mesma transação;
- logout responde sucesso somente quando a revogação da sessão é confirmada;
- falha ou ausência de confirmação da revogação não limpa o cookie e retorna
  resposta fail-closed;
- as rotas da campanha não aceitam `OPERATOR_TOKEN` nem a sessão compartilhada
  do piloto como fallback;
- auditoria append-only recebe vínculo `operator_id`.

### Histórico da migration 0006

Dentro desta PR, a migration `0006_operator_identity.sql` foi executada apenas
no PostgreSQL 16 efêmero do quality-gate. Não houve execução identificada em
banco Preview ou outro ambiente persistente. Por isso o vínculo
`sessão → token → mesmo operador` foi corrigido diretamente na `0006`, antes
de qualquer promoção da PR.

Se houver evidência externa posterior de que uma versão anterior da `0006`
foi aplicada em ambiente persistente, essa premissa deve ser reavaliada antes
do merge e a correção deverá ser promovida por migration aditiva.

## Gates ainda obrigatórios antes da persistência da campanha

A identidade operacional não libera a próxima fase. Permanecem pendentes:

- eliminar `TECH_ADMIN_LEGACY` como autoria administrativa genérica;
- gerar credenciais individuais fortes por mecanismo controlado, em vez de
  recebê-las como segredo escolhido no provisionamento;
- atribuir toda ação administrativa a uma identidade individual autenticada;
- homologar provisionamento, rotação, suspensão e recuperação administrativa;
- somente depois disso considerar tabelas/persistência/aprovação da campanha.

Os gates executáveis continuam fechados:

```
canPersistImport = false
canCreateBatch   = false
canExecute       = false
```

O próximo incremento não deve materializar campanha, lote ou outbox enquanto
os gates administrativos acima não estiverem homologados.
