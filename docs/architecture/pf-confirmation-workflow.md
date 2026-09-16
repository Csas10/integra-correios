# Fluxo de confirmação cadastral PF

Esta feature prepara a carteira PF antes de qualquer pré-postagem. O workflow
não consulta diretamente banco, planilhas, Google Drive, Correios ou provedor
de e-mail; todas as integrações permanecem atrás de portas.

```text
CARTEIRA_IDENTIFICADA
  -> APTO_CONTATO
  -> EMAIL_PENDENTE
  -> EMAIL_ENVIADO
  -> AGUARDANDO_CONFIRMACAO
  -> CONFIRMADO_SEM_ALTERACAO | CONFIRMADO_COM_ALTERACAO
  -> EM_VALIDACAO
  -> APTO_PREPOSTAGEM | PENDENCIA_CADASTRAL
```

O cadastro original é imutável dentro do estado do workflow. Uma confirmação
com alteração cria um snapshot confirmado separado; a origem da alteração e a
data ficam registradas pelos eventos de auditoria e pela confirmação.

## Gate de envio

Um adaptador de lote deve chamar `assertAptoParaPrePostagem` antes de incluir um
profissional. O gate rejeita todo estado diferente de `APTO_PREPOSTAGEM`.
Assim, a presença na carteira ou a confirmação de recebimento do e-mail nunca
é suficiente para gerar um lote PPN.

## Token e comunicação

O link usa token aleatório de 256 bits e o estado guarda somente seu hash,
prazo de expiração, uso e versão do template. `confirmationBaseUrl` é injetada
e deve ser HTTPS; o e-mail recebe uma URL absoluta construída com `new URL`.
O token puro existe somente durante a composição da mensagem e não integra
estado, auditoria ou retorno do workflow.

`ConfirmationOwnership.consumePending` representa o compare-and-set que exige
simultaneamente id, hash, estado `PENDING` e validade temporal. O adapter em
memória comprova a semântica concorrente dentro de um único processo. Ele não
oferece garantia distribuída; o adapter PostgreSQL deverá implementar a mesma
operação de forma transacional antes do uso operacional.

`MailGateway` e `ConversationGateway` são contratos independentes de Gmail,
Microsoft Graph ou Resend. O adapter Resend somente é habilitado no modo
`homologation`, com whitelist curta e comando deliberado. A integração
operacional permanece posterior à persistência e à outbox.

O cockpit oferece a rota `/confirma/:token` para o formulário, mas nesta fase o
envio é apenas uma validação local de interface. A mensagem apresentada deixa
explícito que não houve registro. Não há endpoint nem persistência operacional.
O spike de e-mail pode abrir essa página por link real, mas o formulário não
promove o cadastro nem altera o gate `APTO_PREPOSTAGEM`.
