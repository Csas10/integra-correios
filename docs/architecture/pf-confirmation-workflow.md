# Fluxo de confirmação cadastral PF

Esta feature prepara a carteira PF antes de qualquer pré-postagem. Ela não
consulta banco, planilhas, Google Drive, Correios ou provedor de e-mail.

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

O link usa token aleatório e o estado guarda somente seu hash, prazo de
expiração, uso e versão do template. O token não é persistido no cadastro e
não é exibido pelo cockpit. `MailGateway` e `ConversationGateway` são contratos
independentes de Gmail, Microsoft Graph ou Resend. Os adapters reais ficam para
uma etapa autorizada posterior; o adapter atual falha explicitamente sem rede.

O cockpit oferece a rota `/confirma/:token` para o formulário, mas nesta fase o
envio é apenas uma confirmação local de interface. Não há endpoint nem
persistência operacional.
