# Cockpit Apps Script

Primeira interface da V2.0 sobre a planilha já validada. O cockpit é somente
leitura nesta fase e publica apenas contagens agregadas. Nenhuma linha cadastral
é devolvida ao navegador.

## Instalação controlada

1. Crie um projeto Apps Script vinculado a uma cópia controlada da planilha.
2. Adicione `Cockpit.gs`, `Index.html` e `appsscript.json`.
3. Publique como aplicativo web restrito aos usuários autorizados do domínio.
4. Valide os totais contra a planilha antes de habilitar qualquer ação operacional.

Este código não substitui nem modifica a baseline em `legacy/apps-script/`.
Geração de lotes, escrita em abas e chamadas ao PPN permanecem desabilitadas.
