# Homologação técnica do canal PF

Esta etapa valida o canal de e-mail com dados sintéticos e no máximo cinco
destinatários previamente autorizados. Ela não registra confirmação oficial,
não altera status cadastral e não libera pré-postagem.

## Controles obrigatórios

As variáveis devem existir somente no ambiente Preview da branch de
homologação. Produção deve conservar `MAIL_MODE=disabled`.

| Variável | Regra |
|---|---|
| `MAIL_MODE` | exatamente `homologation` para permitir envio |
| `MAIL_FROM_NAME` | nome exibido, sem quebras de linha |
| `MAIL_FROM_ADDRESS` | remetente do sandbox ou domínio verificado |
| `MAIL_REPLY_TO` | caixa institucional controlada |
| `MAIL_HOMOLOGATION_WHITELIST` | 1 a 5 e-mails separados por vírgula |
| `CONFIRMATION_BASE_URL` | origem HTTPS fixa, sem caminho ou query |
| `RESEND_API_KEY` | segredo server-side do ambiente |
| `RESEND_WEBHOOK_SECRET` | segredo de assinatura do endpoint |

Nenhuma variável sensível usa prefixo `VITE_` e nenhum valor deve ser gravado
em arquivo rastreado pelo Git.

## Pré-condições

- confirmar sandbox autorizado ou subdomínio de envio verificado;
- conferir SPF e DKIM; registrar e acompanhar política DMARC antes de pessoas reais;
- confirmar que a whitelist contém somente caixas controladas;
- configurar o webhook HTTPS `/api/webhooks/resend` para eventos de envio,
  entrega, atraso, bounce, falha, supressão e reclamação;
- manter a PR e o deployment como Preview.

## Execução deliberada

O comando compila a árvore antes do envio e exige a flag literal de confirmação:

```bash
npm run mail:homologation -- \
  --recipient=DESTINATARIO_DA_WHITELIST \
  --confirm-send=HOMOLOGATION
```

Para o caso controlado de idempotência, acrescente `--verify-idempotency`. O
mesmo processo repetirá exatamente a mesma mensagem e exigirá o mesmo ID do
provedor; a flag não é usada no envio comum.

O conteúdo usa apenas `Pessoa de Teste` e `PF|HOMOLOGACAO-MAIL`. A saída contém
somente provedor, IDs, versão do template e timestamps; o token e o destinatário
não são impressos.

## Casos do piloto

1. Gmail controlado: HTML, texto e link HTTPS abrem corretamente.
2. Outlook controlado: conteúdo e link equivalentes.
3. Repetição com o mesmo `confirmationId`: mesmo `Idempotency-Key`, sem novo envio
   dentro da janela de 24 horas do provedor.
4. Destinatário fora da whitelist: bloqueio anterior à chamada HTTP.
5. Bounce sintético: webhook assinado produz apenas status `BOUNCED`.
6. Resposta manual: mensagem chega ao `MAIL_REPLY_TO` institucional.
7. Repetição do `svix-id`: ignorada dentro da mesma instância.
8. Link usado novamente: primeira submissão aceita e segunda rejeitada pelo owner
   compartilhado do workflow.

## Limites do resultado

- webhooks têm entrega pelo menos uma vez e podem chegar fora de ordem;
- a deduplicação atual do webhook é somente intra-instância;
- a idempotência do provedor não substitui uma outbox;
- o formulário continua sem persistência;
- nenhuma confirmação do spike vale como confirmação cadastral institucional;
- nenhum participante pode atingir `APTO_PREPOSTAGEM` por este roteiro.

O canal só pode se tornar operacional depois de PostgreSQL, outbox transacional,
worker idempotente, auditoria persistente e política de reenvio aprovada.
