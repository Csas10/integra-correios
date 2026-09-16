# ADR-005 — Confirmação PF e e-mail desacoplado

## Status

Aceita para a primeira feature funcional da v2.0.

## Contexto

Profissionais PF precisam confirmar ou atualizar seus dados antes de entrarem
na fila de pré-postagem. Respostas livres por e-mail podem continuar como canal
humano, mas o caminho principal deve produzir um snapshot estruturado e
validável. A aplicação não deve ficar presa a um provedor de e-mail.

## Decisão

- modelar o workflow PF com estados explícitos de triagem, comunicação,
  confirmação, validação e pré-postagem;
- manter `original` e `confirmed` separados, sem sobrescrita silenciosa;
- emitir tokens aleatórios de 256 bits, guardar apenas hash, expiração e uso;
- construir URL absoluta HTTPS a partir de `confirmationBaseUrl` injetada;
- consumir o token pelo contrato atômico `ConfirmationOwnership`;
- versionar o template `pf-confirmation-v1`;
- depender de `MailGateway` e `ConversationGateway`, não de SDKs de provedor;
- reservar adapters Gmail, Microsoft Graph e Resend para fases posteriores;
- bloquear a criação de lote salvo estado `APTO_PREPOSTAGEM`;
- registrar cada mudança e emissão/aceite da comunicação em eventos append-only.

## Consequências

A fundação pode ser testada integralmente com gateways falsos e dados
sintéticos, sem credenciais ou tráfego externo. A integração autorizada deverá
adicionar persistência, autenticação do formulário, idempotência de worker,
webhooks de entrega e tratamento de respostas sem alterar os contratos do
domínio.

O adapter em memória garante compare-and-set somente no mesmo processo. A
garantia entre réplicas ou workers depende do futuro adapter PostgreSQL e não é
alegada por esta decisão.
