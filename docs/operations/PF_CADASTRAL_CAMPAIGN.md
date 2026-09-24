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
- a próxima fase exige `operator_id` individual, revogável e auditável.

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

## Próximo gate

Identidade individual + papéis, tabelas de campanha/aprovação, auditoria
append-only, resolução humana das duplicidades, materialização imutável em
PREPARACAO/APROVADO e só então integração com a outbox homologada.


## Identidade operacional individual

O primeiro gate após a integração do piloto introduz identidade persistente sem
abrir qualquer capacidade de campanha:

- `operator_id` persistente, nome, código e status ATIVO/SUSPENSO;
- papéis PREPARADOR, REVISOR, APROVADOR, EXECUTOR, SUPERVISOR e ADMIN_TECNICO;
- token individual base64url com mínimo equivalente a 256 bits; somente SHA-256
  é persistido;
- sessão opaca aleatória de 256 bits; somente SHA-256 é persistido;
- cookie `__Host-ic_campaign_operator_session` com HttpOnly, Secure,
  SameSite=Strict e Path=/;
- `GET /api/operator/me` expõe identidade/papéis/expiração e nenhum segredo;
- suspensão revoga tokens e sessões na mesma transação;
- as rotas da campanha não aceitam `OPERATOR_TOKEN` nem sessão compartilhada
  do piloto como fallback;
- provisionamento/suspensão permanecem ações técnicas separadas;
- auditoria append-only recebe vínculo `operator_id`.

Os gates continuam fechados:

```
canPersistImport = false
canCreateBatch   = false
canExecute       = false
```
