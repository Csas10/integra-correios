# ADR-006 — Homologação controlada do canal de e-mail

## Status

Aceita como spike técnico `0.5`, anterior à ingestão e sem uso operacional.

## Contexto

O template e o workflow PF estão protegidos, mas entrega, autenticação do
domínio, `Reply-To`, idempotência e webhooks precisam ser comprovados cedo. O
sistema ainda não possui PostgreSQL, outbox ou concorrência distribuída.

## Decisão

- implementar `ResendMailGateway` atrás do contrato `MailGateway`;
- manter `MAIL_MODE=disabled` como padrão e exigir `homologation` para envio;
- limitar a whitelist a cinco destinatários controlados;
- exigir origem HTTPS fixa, remetente e `Reply-To` por configuração server-side;
- manter `RESEND_API_KEY` e `RESEND_WEBHOOK_SECRET` somente no ambiente;
- usar a chave `pf-confirmation:<confirmationId>:pf-confirmation-v1` para a
  idempotência de 24 horas oferecida pelo provedor;
- validar a assinatura sobre o corpo bruto e os três cabeçalhos Svix;
- deduplicar `svix-id` apenas dentro da instância durante o spike;
- registrar somente `eventId`, `messageId`, status e timestamp;
- usar exclusivamente cadastro sintético e comando com confirmação explícita;
- não promover nenhum registro a `APTO_PREPOSTAGEM`.

## Consequências

É possível homologar entrega, HTML/texto, link, `Reply-To`, bounce e assinatura
do webhook sem acoplar o workflow ao SDK. A idempotência do Resend expira após
24 horas e o deduplicador em memória não atravessa instâncias serverless. Essas
proteções não substituem PostgreSQL, outbox transacional nem um consumidor de
webhook persistente.

O envio para profissionais reais continua bloqueado até a etapa de persistência
operacional.
