/**
 * Cockpit V2.0 — leitura agregada da BASE_NORMALIZADA.
 * Não retorna nomes, documentos, endereços ou linhas cadastrais ao navegador.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Integra Correios')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function obterResumoCockpit() {
  const resumo = {
    geradoEm: new Date().toISOString(),
    PF: resumoVazio_('PF'),
    PJ: resumoVazio_('PJ'),
  };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BASE_NORMALIZADA');
  if (!sheet || sheet.getLastRow() < 2) return resumo;

  const values = sheet.getDataRange().getDisplayValues();
  const headers = values.shift().map(normalizarCabecalhoCockpit_);
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  ['ORIGEM', 'DOCUMENTO_STATUS', 'STATUS_CEP_CORREIOS', 'APROVACAO_EXCECAO', 'MOTIVO_BLOQUEIO']
    .forEach((header) => {
      if (index[header] === undefined) throw new Error(`Cabeçalho obrigatório ausente: ${header}`);
    });

  values.forEach((row) => {
    const origem = String(row[index.ORIGEM] || '').trim().toUpperCase();
    if (origem !== 'PF' && origem !== 'PJ') return;

    const item = resumo[origem];
    const documentoValido = String(row[index.DOCUMENTO_STATUS] || '').trim().toUpperCase() === 'OK';
    const statusCep = String(row[index.STATUS_CEP_CORREIOS] || '').trim().toUpperCase();
    const excecaoAprovada = String(row[index.APROVACAO_EXCECAO] || '').trim().toUpperCase() === 'APROVADO';
    const cepValido = statusCep === 'OK' || excecaoAprovada;
    const bloqueio = String(row[index.MOTIVO_BLOQUEIO] || '').trim();

    item.recebidos += 1;
    if (documentoValido) item.documentosValidos += 1;
    if (cepValido) item.cepsValidos += 1;
    if (documentoValido && cepValido && !bloqueio) item.prontos += 1;
    else item.pendencias += 1;
  });

  return resumo;
}

function resumoVazio_(origem) {
  return { origem, recebidos: 0, documentosValidos: 0, cepsValidos: 0, pendencias: 0, prontos: 0 };
}

function normalizarCabecalhoCockpit_(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase();
}
