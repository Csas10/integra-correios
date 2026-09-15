/**
 * Automação PPN Correios — AR Digital
 * Versão 1.8.5 — 11/09/2026
 *
 * Fluxo recorrente:
 *   arquivos XLSX na pasta de entrada -> entrada bruta -> base normalizada
 *   -> cache/API oficial de CEP -> fila de exceções -> cópia de template oficial
 *   -> XLSX de destinatários/objetos simples ou JSON de objetos registrados
 *   -> arquivos independentes em 03_SAIDAS_GERADAS.
 *
 * Segurança:
 *   - usuário/código de acesso ficam em ScriptProperties, nunca em células;
 *   - o CEP original é preservado e divergências nunca são substituídas automaticamente;
 *   - ViaCEP, quando ativado, é apenas auxiliar e nunca libera exportação.
 *
 * Instalação única:
 *   1. Vincule este código à planilha Google.
 *   2. Ative o serviço avançado Drive API no Apps Script.
 *   3. Execute instalarEstrutura() e autorize os escopos.
 */

const PPN_FILES = Object.freeze({
  ORCHESTRATOR: 'PLANILHA_PPN_CORREIOS_AUTOMATIZADA_AR_DIGITAL',
  INPUT_PF: 'AR DIGITAL PROFISSIONAIS.xlsx',
  INPUT_PJ: 'AR DIGITAL - EMPRESA.xlsx',
  TEMPLATE_DEST: 'Template_Destinatarios.xlsx',
  TEMPLATE_REM: 'Template_Remetentes.xlsx',
  TEMPLATE_SIMPLE: 'arquivo_obj_simples_exemplo.xlsx',
  TEMPLATE_REGISTERED: 'arquivo_obj_registrado_sem_codigo_registro_exemplo.xlsx',
});

const PPN_DRIVE = Object.freeze({
  PROJECT: {key:'PASTA_PROJETO_ID',id:'1FOC3--cdKi5TeCDgGGLyq24t9Wy4X12k',name:'Projeto Correios'},
  INPUT: {key:'PASTA_ENTRADA_ID',id:'1DxTN-_f0c8ZOjeg_eyR-lP0t4m50mjqL',name:'01_ENTRADA_AR_DIGITAL'},
  TEMPLATES: {key:'PASTA_TEMPLATES_ID',id:'1dnOb4jBdknP4HRZzi9FQWT-K35IliKhr',name:'02_TEMPLATES_OFICIAIS'},
  OUTPUT: {key:'PASTA_SAIDA_ID',id:'1ASqQbaRFwT9f8Ch9WdDanyClxn4QNWPQ',name:'03_SAIDAS_GERADAS'},
  CHECKPOINTS: {key:'PASTA_CHECKPOINTS_ID',id:'1ax9uCJxFHLuGi4Yoky11W8saKRvHboEc',name:'04_CHECKPOINTS'},
});

const PPN_SCHEMA_RETEST = Object.freeze({
  V171_FILE: 'HOMOLOG_PPN_OBJ_REGISTRADO_EMPRESAS_LOTE20_20260909_191223.json',
  PREVIOUS_MARKER: '_LOTE20_PPN050_CORRIGIDO_',
  OUTPUT_MARKER: '_ENVELOPE_SEM_DIMENSOES_',
});

const PPN = Object.freeze({
  SHEETS: {
    CONFIG: 'CONFIG_AUTOMACAO',
    PF: 'ENTRADA_PROFISSIONAIS',
    PJ: 'ENTRADA_EMPRESAS',
    BASE: 'BASE_NORMALIZADA',
    CACHE: 'CACHE_CEP_CORREIOS',
    EXC: 'FILA_EXCECOES',
    PREVIEW: 'PREVIA_DESTINATARIOS',
    EXPORT_DEST: 'EXPORT_DESTINATARIOS',
    EXPORT_DEST_PF: 'EXPORT_DEST_PROFISSIONAIS',
    EXPORT_DEST_PJ: 'EXPORT_DEST_EMPRESAS',
    EXPORT_SIMPLE: 'EXPORT_OBJ_SIMPLES',
    EXPORT_SIMPLE_PF: 'EXPORT_OBJ_SIMPLES_PF',
    EXPORT_SIMPLE_PJ: 'EXPORT_OBJ_SIMPLES_PJ',
    EXPORT_REGISTERED_PF: 'EXPORT_OBJ_REG_PROFISSIONAIS',
    EXPORT_REGISTERED_PJ: 'EXPORT_OBJ_REG_EMPRESAS',
    IMPORT_CHECKLIST: 'CHECKLIST_IMPORTACAO',
    RETURNS: 'RETORNO_CORREIOS',
    VERIFIED: 'BASE_ENVIO_VERIFICADA',
    HOMOLOG_QUEUE: 'FILA_HOMOLOGACAO',
    HOMOLOG_GATES: 'GATES_HOMOLOGACAO',
    LOG: 'LOG_AUTOMACAO',
  },
  RAW_PF_HEADERS: ['CODIGO','REGISTRO NACIONAL','CPF','NOME','EMAIL','CELULAR','TELEFONE','ENDERECO','DATA EVENTO','ULTIMOEXERCICIOQUITADO','ULTIMOEXERCICIOPAGO','ULTIMOEXERCICIOPAGO PARCELAS','EXERCICIOS PENDENTES'],
  RAW_PJ_HEADERS: ['CODIGO','REGISTRO NACIONAL','CNPJ','RAZAO SOCIAL','EMAIL','TELEFONE','ENDERECO','DATA EVENTO','ULTIMOEXERCICIOQUITADO','ULTIMOEXERCICIOPAGO','ULTIMOEXERCICIOPAGO PARCELAS','EXERCICIOS PENDENTES'],
  DEST_HEADERS: ['Cartao_postagem','Malote (S ou N)','Codigo','Nome','Email','CPF/CNPJ','Telefone','Celular','CEP','Logradouro','Número','Complemento','Bairro','Cidade','UF'],
  SIMPLE_HEADERS: ['sequencial','codigoServico','codigoServicoAdicional1','codigoServicoAdicional2','codigoServicoAdicional3','codigoServicoAdicional4','codigoServicoAdicional5','valorDeclarado','peso','nomeRemetente','cepRemetente','logradouroRemetente','numeroLogradouroRemetente','complementoRemetente','bairroRemetente','cidadeRemetente','ufRemetente','cnpjRemetente','dddRemetente','telefoneRemetente','emailRemetente','nomeDestinatario','cepDestinatario','logradouroDestinatario','numeroLogradouroDestinatario','complementoDestinatario','bairroDestinatario','cidadeDestinatario','ufDestinatario','cnpjCpfDestinatario','dddDestinatario','telefoneDestinatario','emailDestinatario','dataPrevistaPostagem'],
  REGISTERED_HEADERS: [
    'sequencial','cpfCnpjRemetente','documentoEstrangeiroRemetente','nomeRemetente','dddTelefoneRemetente','telefoneRemetente','dddCelularRemetente','celularRemetente','emailRemetente','observacaoRemetente','cepRemetente','logradouroRemetente','numeroRemetente','complementoRemetente','bairroRemetente','cidadeRemetente','ufRemetente','cpfCnpjDestinatario','documentoEstrangeiroDestinatario','nomeDestinatario','dddTelefoneDestinatario','telefoneDestinatario','dddCelularDestinatario','celularDestinatario','emailDestinatario','observacaoDestinatario','cepDestinatario','logradouroDestinatario','numeroDestinatario','complementoDestinatario','bairroDestinatario','cidadeDestinatario','ufDestinatario','codigoServico','dataPrevistaPostagem','prazoPostagem','logisticaReversa','dataValidadeLogReversa','codigoServicoAdicionalValorDeclarado','valorDeclarado','codigoServicoAdicionalEntregaVizinho','orientacaoEntregaVizinho','codigoServicoAdicional1','codigoServicoAdicional2','codigoServicoAdicional3','pesoInformado','codigoFormatoObjetoInformado','alturaInformada','larguraInformada','comprimentoInformado','diametroInformado','cienteObjetoNaoProibido','observacao','numeroNotaFiscal','chaveNFe','rfidObjeto','DeclaracaoConteudoConteudo1','DeclaracaoConteudoQuantidade1','DeclaracaoConteudoValor1','DeclaracaoConteudoConteudo2','DeclaracaoConteudoQuantidade2','DeclaracaoConteudoValor2','DeclaracaoConteudoConteudo3','DeclaracaoConteudoQuantidade3','DeclaracaoConteudoValor3','DeclaracaoConteudoConteudo4','DeclaracaoConteudoQuantidade4','DeclaracaoConteudoValor4','DeclaracaoConteudoConteudo5','DeclaracaoConteudoQuantidade5','DeclaracaoConteudoValor5','DeclaracaoConteudoConteudo6','DeclaracaoConteudoQuantidade6','DeclaracaoConteudoValor6','DeclaracaoConteudoConteudo7','DeclaracaoConteudoQuantidade7','DeclaracaoConteudoValor7','DeclaracaoConteudoConteudo8','DeclaracaoConteudoQuantidade8','DeclaracaoConteudoValor8','DeclaracaoConteudoConteudo9','DeclaracaoConteudoQuantidade9','DeclaracaoConteudoValor9','DeclaracaoConteudoConteudo10','DeclaracaoConteudoQuantidade10','DeclaracaoConteudoValor10','codigoObjetoIda'
  ],
  BASE_HEADERS: [
    'CHAVE','LOTE','ORIGEM','LINHA_ORIGEM','CODIGO','REGISTRO_NACIONAL','CPF_CNPJ','DOCUMENTO_STATUS','NOME','EMAIL','EMAIL_STATUS','TELEFONE','CELULAR','ENDERECO_BRUTO','CEP_ORIGINAL','CEP_FORMATO','LOGRADOURO_PARSER','NUMERO_PARSER','COMPLEMENTO_PARSER','BAIRRO_PARSER','CIDADE_PARSER','UF_PARSER','PARSER_CONFIANCA','PARSER_ALERTAS','LOGRADOURO_CORREIOS','BAIRRO_CORREIOS','CIDADE_CORREIOS','UF_CORREIOS','CEP_RETORNADO_CORREIOS','TIPO_CEP_CORREIOS','STATUS_CEP_CORREIOS','LOGRADOURO_APROVADO','NUMERO_APROVADO','COMPLEMENTO_APROVADO','BAIRRO_APROVADO','CIDADE_APROVADA','UF_APROVADA','APROVACAO_EXCECAO','STATUS_EXPORTACAO','MOTIVO_BLOQUEIO','ATUALIZADO_EM'
  ],
  CACHE_HEADERS: ['CEP','STATUS','HTTP','LOGRADOURO','BAIRRO','CIDADE','UF','CEP_RETORNADO','TIPO_CEP','MENSAGEM','CONSULTADO_EM','EXPIRA_EM','TENTATIVAS'],
  EXC_HEADERS: ['CHAVE','ORIGEM','LINHA_ORIGEM','CODIGO','CPF_CNPJ','NOME','CEP','ENDERECO_BRUTO','TIPO_EXCECAO','DETALHE','LOGRADOURO_CORRECAO','NUMERO_CORRECAO','COMPLEMENTO_CORRECAO','BAIRRO_CORRECAO','CIDADE_CORRECAO','UF_CORRECAO','DECISAO','RESPONSAVEL','DATA_DECISAO','OBSERVACAO'],
  PREVIEW_HEADERS: ['Cartao_postagem','Malote (S ou N)','Codigo','Nome','Email','CPF/CNPJ','Telefone','Celular','CEP','Logradouro','Número','Complemento','Bairro','Cidade','UF','STATUS_PREVIA','MOTIVO'],
  IMPORT_CHECKLIST_HEADERS: ['LOTE','ORIGEM','ARQUIVO','SHA256_FONTE','REGISTROS_FONTE','REGISTROS_IMPORTADOS','REGISTROS_NORMALIZADOS','DUPLICIDADES_CODIGO','DUPLICIDADES_DOCUMENTO','APTOS_HOMOLOG','EXCECOES','FECHAMENTO','STATUS','DETALHE','EXECUTADO_EM'],
  RETURN_HEADERS: ['ID_RETORNO','ARQUIVO_EXPORTADO','ORIGEM','LINHA_ARQUIVO','CODIGO','NOME','CPF_CNPJ','CEP','TIPO_ERRO','CODIGO_ERRO','MENSAGEM','CPF_CNPJ_CORRIGIDO','CEP_CORRIGIDO','DECISAO','RESPONSAVEL','DATA_DECISAO','OBSERVACAO','RECIBO_ID','IMPORTADO_EM','TIPO_EXPORTACAO','SEQUENCIAL'],
  VERIFIED_HEADERS: ['ID_EXPORTACAO','ARQUIVO_EXPORTADO','ORIGEM','LINHA_ARQUIVO','CODIGO','NOME','CPF_CNPJ','CEP','STATUS_LOCAL','STATUS_CORREIOS','MOTIVO_CORREIOS','RECIBO_ID','EXPORTADO_EM','RETORNO_EM','TIPO_EXPORTACAO','SEQUENCIAL','CHAVE','ARQUIVO_AUDITORIA'],
  HOMOLOG_QUEUE_HEADERS: ['CHAVE','ORIGEM','CODIGO','NOME','STATUS_ELEGIBILIDADE','STATUS_HOMOLOGACAO','LOTE_HOMOLOGACAO','ORDEM_LOTE','ARQUIVO_JSON','ENVIADO_EM','STATUS_CORREIOS','CODIGO_OBJETO','RETORNO_EM','TIPO_RETESTE','MOTIVO','ATUALIZADO_EM'],
  HOMOLOG_GATES_HEADERS: ['ID_GATE','DATA_GATE','ORIGEM','CANAL','SERVICO','FORMATO','PESO','DIMENSOES','AR','RR','DECLARACAO','LOTE','ENVIADOS','PRE_POSTAGENS_CRIADAS','REJEITADOS_CEP','RECONCILIACAO','MATERIALIZACAO','ATRIBUICAO_CODIGO','RESULTADO','OBSERVACAO'],
  LOG_HEADERS: ['TIMESTAMP','ID_CORRELACAO','OPERACAO','ITEM','HTTP','RESULTADO','MENSAGEM','DURACAO_MS','TENTATIVA','EXECUTOR'],
});

function onOpen() {
  const ui=SpreadsheetApp.getUi();
  const menuPf=ui.createMenu('PF — Profissionais')
    .addItem('Destinatários — homologação', 'gerarXlsxDestinatariosHomologacaoPf')
    .addItem('Destinatários — produção', 'gerarXlsxDestinatariosPf')
    .addSeparator()
    .addItem('Objeto simples — ambiente atual', 'gerarXlsxObjetoSimplesPf')
    .addItem('Objeto registrado — JSON + auditoria XLSX', 'gerarXlsxObjetosRegistradosPf');
  const menuPj=ui.createMenu('PJ — Empresas')
    .addItem('Destinatários — homologação', 'gerarXlsxDestinatariosHomologacaoPj')
    .addItem('Destinatários — produção', 'gerarXlsxDestinatariosPj')
    .addSeparator()
    .addItem('Objeto simples — ambiente atual', 'gerarXlsxObjetoSimplesPj')
    .addSeparator()
    .addItem('1. Preparar perfil ouro — envelope sem dimensões', 'prepararReensaioEnvelopePj20')
    .addItem('2. Gerar próximo lote controlado — 20', 'gerarProximoLoteHomologacaoPj20')
    .addItem('3. Consultar fila de homologação', 'consultarFilaHomologacaoPj')
    .addItem('4. Gerar lote de reteste de exceções', 'gerarLoteRetesteHomologacaoPj')
    .addItem('5. Registrar gate do lote atual', 'registrarGateHomologacaoPj20')
    .addItem('6. Gerar lote completo — BLOQUEADO', 'bloquearLoteCompletoHomologacaoPj');
  const menuTodos=ui.createMenu('Todos — PF + PJ')
    .addItem('Destinatários — homologação', 'gerarXlsxDestinatariosHomologacao')
    .addItem('Destinatários — produção', 'gerarXlsxDestinatarios')
    .addSeparator()
    .addItem('Objeto simples — ambiente atual', 'gerarXlsxObjetoSimples')
    .addItem('Objeto registrado — JSON + auditoria XLSX', 'gerarXlsxObjetosRegistrados');
  const menuRetorno=ui.createMenu('Retorno dos Correios')
    .addItem('Importar retorno PDF ou JSON/TXT', 'importarRetornoCorreios')
    .addItem('Aplicar correções aprovadas do retorno', 'aplicarTratamentosRetornoCorreios')
    .addItem('Atualizar base verificada de envio', 'atualizarBaseEnvioVerificada');
  ui.createMenu('Correios PPN')
    .addItem('1. Instalar/validar estrutura', 'instalarEstrutura')
    .addItem('Validar arquitetura de pastas e arquivos', 'validarArquiteturaDrive')
    .addItem('Reparar cabeçalhos e reimportar', 'repararCabecalhosEReimportar')
    .addItem('2. Importar arquivos AR Digital', 'importarArquivosARDigital')
    .addItem('3. Configurar credenciais Correios', 'configurarCredenciaisCorreios')
    .addItem('4. Verificar habilitação da API PPN', 'verificarHabilitacaoApiPpn')
    .addSeparator()
    .addItem('5. Iniciar validação oficial de CEP', 'iniciarValidacaoCepCorreios')
    .addItem('6. Atualizar fila de exceções', 'atualizarFilaExcecoes')
    .addItem('7. Aplicar correções aprovadas', 'aplicarCorrecoesExcecoes')
    .addSeparator()
    .addSubMenu(menuPf)
    .addSubMenu(menuPj)
    .addSubMenu(menuTodos)
    .addSeparator()
    .addSubMenu(menuRetorno)
    .addToUi();
}

function instalarEstrutura() {
  const ss = SpreadsheetApp.getActive();
  garantirAba_(ss, PPN.SHEETS.CONFIG, ['PARAMETRO','VALOR','OBRIGATORIO','DESCRICAO']);
  garantirAba_(ss, PPN.SHEETS.PF, PPN.RAW_PF_HEADERS);
  garantirAba_(ss, PPN.SHEETS.PJ, PPN.RAW_PJ_HEADERS);
  garantirAba_(ss, PPN.SHEETS.BASE, PPN.BASE_HEADERS);
  garantirAba_(ss, PPN.SHEETS.CACHE, PPN.CACHE_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXC, PPN.EXC_HEADERS);
  garantirAba_(ss, PPN.SHEETS.PREVIEW, PPN.PREVIEW_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_DEST, PPN.DEST_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_DEST_PF, PPN.DEST_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_DEST_PJ, PPN.DEST_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_SIMPLE, PPN.SIMPLE_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_SIMPLE_PF, PPN.SIMPLE_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_SIMPLE_PJ, PPN.SIMPLE_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_REGISTERED_PF, PPN.REGISTERED_HEADERS);
  garantirAba_(ss, PPN.SHEETS.EXPORT_REGISTERED_PJ, PPN.REGISTERED_HEADERS);
  garantirAba_(ss, PPN.SHEETS.IMPORT_CHECKLIST, PPN.IMPORT_CHECKLIST_HEADERS);
  garantirAba_(ss, PPN.SHEETS.RETURNS, PPN.RETURN_HEADERS);
  garantirAba_(ss, PPN.SHEETS.VERIFIED, PPN.VERIFIED_HEADERS);
  garantirAba_(ss, PPN.SHEETS.HOMOLOG_QUEUE, PPN.HOMOLOG_QUEUE_HEADERS);
  garantirAba_(ss, PPN.SHEETS.HOMOLOG_GATES, PPN.HOMOLOG_GATES_HEADERS);
  garantirAba_(ss, PPN.SHEETS.LOG, PPN.LOG_HEADERS);
  atualizarCabecalhosGerenciados_(ss.getSheetByName(PPN.SHEETS.RETURNS), PPN.RETURN_HEADERS);
  atualizarCabecalhosGerenciados_(ss.getSheetByName(PPN.SHEETS.VERIFIED), PPN.VERIFIED_HEADERS);
  atualizarCabecalhosGerenciados_(ss.getSheetByName(PPN.SHEETS.HOMOLOG_QUEUE), PPN.HOMOLOG_QUEUE_HEADERS);
  atualizarCabecalhosGerenciados_(ss.getSheetByName(PPN.SHEETS.HOMOLOG_GATES), PPN.HOMOLOG_GATES_HEADERS);
  higienizarGatesHomologacao_();
  migrarConfigPastasV150_();
  preencherConfigPadrao_();
  migrarConfigObjetoRegistradoV170_();
  estilizarEstrutura_();
  const arquitetura=validarArquiteturaDrive_(false);
  configurarValidacoesOperacionais_();
  sincronizarFilaHomologacao_();
  log_('INSTALAR', '', '', 'SUCESSO', `Estrutura v1.8.5 e arquitetura do Drive validadas; ${arquitetura}`, '', 1);
  SpreadsheetApp.getUi().alert(`Estrutura v1.8.5 validada.\n\n${arquitetura}\n\nPerfil ouro congelado: envelope sem dimensões, peso 10, AR 001, RR 025 e declaração DOCUMENTO/1/20.\n\nUse PJ — Empresas para administrar a fila determinística de homologação.`);
}

function configurarCredenciaisCorreios() {
  const ui = SpreadsheetApp.getUi();
  const user = ui.prompt('Usuário Meu Correios', 'Informe o usuário de API. O valor será salvo fora das células.', ui.ButtonSet.OK_CANCEL);
  if (user.getSelectedButton() !== ui.Button.OK) return;
  const code = ui.prompt('Código de acesso à API', 'Informe o código de acesso criado no CWS. O valor será salvo em ScriptProperties.', ui.ButtonSet.OK_CANCEL);
  if (code.getSelectedButton() !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperties({
    CORREIOS_USUARIO: user.getResponseText().trim(),
    CORREIOS_CODIGO_ACESSO: code.getResponseText().trim(),
    CORREIOS_TOKEN: '',
    CORREIOS_TOKEN_EXPIRA: '0',
  });
  log_('CREDENCIAIS', '', '', 'SUCESSO', 'Credenciais armazenadas fora da planilha', '', 1);
  ui.alert('Credenciais configuradas. Nenhuma senha ou token foi gravado na planilha.');
}

function verificarHabilitacaoApiPpn(){
  validarConfig_(['REMETENTE_CPF_CNPJ','NUMERO_CONTRATO','CARTAO_POSTAGEM','DR']);
  const props=PropertiesService.getScriptProperties();
  if(!props.getProperty('CORREIOS_USUARIO')||!props.getProperty('CORREIOS_CODIGO_ACESSO'))throw new Error('Configure as credenciais Correios primeiro.');
  const cnpj=digitos_(config_('REMETENTE_CPF_CNPJ')); if(cnpj.length!==14)throw new Error('REMETENTE_CPF_CNPJ deve conter o CNPJ de 14 dígitos do contrato.');
  const contrato=digitos_(config_('NUMERO_CONTRATO')); const cartao=digitos_(config_('CARTAO_POSTAGEM')); const token=obterTokenCorreios_();
  const host=ambiente_()==='PRODUCAO'?'https://api.correios.com.br':'https://apihom.correios.com.br';
  const url=`${host}/meucontrato/v1/empresas/${cnpj}/contratos/${contrato}/cartoes/${cartao}/servicos/86720`;
  const response=UrlFetchApp.fetch(url,{method:'get',headers:{Authorization:'Bearer '+token,Accept:'application/json'},muteHttpExceptions:true,followRedirects:true});
  const r=lerRespostaJsonSegura_(response);
  if(r.http>=200&&r.http<300&&r.jsonValido){
    const json=r.json||{};
    log_('VERIFICAR_API_PPN','86720',r.http,'HABILITADO',texto_(json.descricao||json.nome||'API PRE POSTAGEM'),'',1);
    SpreadsheetApp.getUi().alert(`API de Pré-Postagem confirmada no cartão.\n\nServiço: 86720\nHTTP: ${r.http}\n\nO próximo gate é homologar o schema autenticado no CWS.`);
    return true;
  }
  if(r.http>=200&&r.http<300&&!r.jsonValido){
    log_('VERIFICAR_API_PPN','86720',r.http,'RESPOSTA_NAO_JSON',`${r.erro}; Content-Type=${r.contentType||'[não informado]'}`,'',1);
    throw new Error(`A consulta do serviço 86720 respondeu HTTP ${r.http}, mas o conteúdo não é JSON válido.\n\nTipo: ${r.erro}\nContent-Type: ${r.contentType||'[não informado]'}`);
  }
  const msg=r.jsonValido?resumirErro_(r.json,r.body):`${r.erro}; Content-Type=${r.contentType||'[não informado]'}`;
  log_('VERIFICAR_API_PPN','86720',r.http,'NAO_HABILITADO',msg,'',1);
  throw new Error(`Serviço 86720 não confirmado no cartão: HTTP ${r.http} — ${msg}`);
}

function importarArquivosARDigital() {
  const started = Date.now();
  validarConfig_(['PASTA_ENTRADA_ID']);
  validarArquiteturaDrive_(false);
  checkpoint_('ANTES_IMPORTACAO');
  const pf=localizarArquivoUnico_(config_('PASTA_ENTRADA_ID'),PPN_FILES.INPUT_PF);
  const pj=localizarArquivoUnico_(config_('PASTA_ENTRADA_ID'),PPN_FILES.INPUT_PJ);
  const importacoes={
    PROFISSIONAL:lerXlsxParaImportacao_(pf,PPN.RAW_PF_HEADERS),
    EMPRESA:lerXlsxParaImportacao_(pj,PPN.RAW_PJ_HEADERS),
  };
  gravarImportacaoBruta_(PPN.SHEETS.PF,importacoes.PROFISSIONAL);
  gravarImportacaoBruta_(PPN.SHEETS.PJ,importacoes.EMPRESA);
  const resumo=processarAbasEntrada_(importacoes);
  log_('IMPORTAR_AR', '', '', 'SUCESSO', `PF=${resumo.porOrigem.PROFISSIONAL.normalizados}; PJ=${resumo.porOrigem.EMPRESA.normalizados}; cacheMantido=${resumo.cache.mantidos}; cacheDuplicadoRemovido=${resumo.cache.duplicadosRemovidos}; cacheForaDaBaseRemovido=${resumo.cache.foraDaBaseRemovidos}`, Date.now() - started, 1);
  SpreadsheetApp.getUi().alert(
    `Importação concluída com fechamento integral.\n\n`+
    `PF: ${resumo.porOrigem.PROFISSIONAL.fonte} fonte = ${resumo.porOrigem.PROFISSIONAL.normalizados} normalizados; ${resumo.porOrigem.PROFISSIONAL.aptos} aptos; ${resumo.porOrigem.PROFISSIONAL.excecoes} exceções.\n`+
    `PJ: ${resumo.porOrigem.EMPRESA.fonte} fonte = ${resumo.porOrigem.EMPRESA.normalizados} normalizados; ${resumo.porOrigem.EMPRESA.aptos} aptos; ${resumo.porOrigem.EMPRESA.excecoes} exceções.\n\n`+
    `Total: ${resumo.total} registros; ${resumo.aptosPrevia} aptos; ${resumo.excecoes} exceções.\n`+
    `Cache: ${resumo.cache.mantidos} CEPs ativos mantidos; ${resumo.cache.duplicadosRemovidos} duplicidades e ${resumo.cache.foraDaBaseRemovidos} CEPs fora da base removidos.\n\n`+
    `Consulte CHECKLIST_IMPORTACAO, PREVIA_DESTINATARIOS e FILA_EXCECOES.`
  );
}

function repararCabecalhosEReimportar(){
  importarArquivosARDigital();
}

function lerXlsxParaImportacao_(file,expectedHeaders) {
  let tempId = '';
  try {
    const converted = Drive.Files.create({name: `__TMP_PPN_${Date.now()}`, mimeType: MimeType.GOOGLE_SHEETS}, file.getBlob(), {fields: 'id'});
    tempId = converted.id;
    const source = SpreadsheetApp.openById(tempId).getSheets()[0];
    const values = source.getDataRange().getDisplayValues();
    if (!values.length) throw new Error(`Arquivo vazio: ${file.getName()}`);
    const expectedSet=new Set(expectedHeaders.map(normalizarCabecalho_));
    const headerIndex=values.slice(0,20).findIndex(row=>{
      const hs=new Set(row.map(normalizarCabecalho_)); let found=0; expectedSet.forEach(h=>{if(hs.has(h))found++;}); return found>=Math.min(5,expectedSet.size);
    });
    if(headerIndex<0)throw new Error(`Cabeçalho não localizado nas primeiras 20 linhas de ${file.getName()}.`);
    validarCabecalhos_(values[headerIndex], expectedHeaders, file.getName());
    const trimmed=values.slice(headerIndex);
    const registrosFonte=trimmed.slice(1).filter(row=>row.some(v=>texto_(v)!=='')).length;
    return{
      arquivo:file.getName(),
      arquivoId:file.getId(),
      sha256:sha256_(file.getBlob().getBytes()),
      registrosFonte,
      registrosImportados:registrosFonte,
      values:trimmed,
    };
  } finally {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
  }
}

function gravarImportacaoBruta_(targetName,info){
  const target=SpreadsheetApp.getActive().getSheetByName(targetName); const values=info.values;
  desmesclarAreaDados_(target,values[0].length); target.clearContents(); formatarMatrizComoTextoAntes_(target,1,values.length,values[0].length); target.getRange(1,1,values.length,values[0].length).setValues(values); target.setFrozenRows(1);
  info.registrosImportados=contarRegistrosAbaBruta_(target,targetName===PPN.SHEETS.PF); delete info.values; return info;
}

function importarXlsxParaAba_(file,targetName,expectedHeaders){const info=lerXlsxParaImportacao_(file,expectedHeaders);return gravarImportacaoBruta_(targetName,info);}

function processarAbasEntrada_(importacoes) {
  const ss = SpreadsheetApp.getActive();
  const lote = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const porOrigem={
    PROFISSIONAL:normalizarAba_(ss.getSheetByName(PPN.SHEETS.PF), 'PROFISSIONAL', lote),
    EMPRESA:normalizarAba_(ss.getSheetByName(PPN.SHEETS.PJ), 'EMPRESA', lote),
  };
  aplicarCorrecoesPersistentesFilaNaMatriz_(porOrigem.PROFISSIONAL);
  aplicarCorrecoesPersistentesFilaNaMatriz_(porOrigem.EMPRESA);
  aplicarCorrecoesPersistentesRetorno_(porOrigem.PROFISSIONAL);
  aplicarCorrecoesPersistentesRetorno_(porOrigem.EMPRESA);
  const preAuditoria=auditarIntegridadeImportacao_(lote,porOrigem,importacoes||{});
  registrarChecklistImportacao_(preAuditoria);
  const bloqueios=preAuditoria.filter(item=>item.status!=='OK');
  if(bloqueios.length){
    const detalhe=bloqueios.map(item=>`${item.origem}: ${item.detalhe}`).join('; ');
    log_('CHECKLIST_IMPORTACAO',lote,'','BLOQUEADO',detalhe,'',1);
    throw new Error(`Importação bloqueada pelo checklist de integridade. BASE_NORMALIZADA foi preservada.\n\n${detalhe}\n\nCorrija os arquivos de origem e execute novamente.`);
  }
  const rows = [...porOrigem.PROFISSIONAL,...porOrigem.EMPRESA];
  const resumo=validarSanidadeImportacao_(rows);
  const base = ss.getSheetByName(PPN.SHEETS.BASE);
  prepararAbaDados_(base,PPN.BASE_HEADERS);
  formatarColunasTextoAntes_(base,2,rows.length,[1,2,3,5,6,7,12,13,15,29]);
  escreverEmBlocos_(base, 2, rows, 500);
  base.getRange(2, 1, Math.max(rows.length,1), PPN.BASE_HEADERS.length).setNumberFormat('@');
  base.setFrozenRows(1);
  validarCabecalhosLeitura_(dados_(PPN.SHEETS.BASE).headers,PPN.BASE_HEADERS,PPN.SHEETS.BASE);
  resumo.cache=higienizarCacheAposImportacao_(rows);
  atualizarFilaExcecoes();
  resumo.aptosPrevia=atualizarPreviaDestinatarios_();
  resumo.excecoes=rows.length-resumo.aptosPrevia;
  resumo.porOrigem={};
  preAuditoria.forEach(item=>{
    const origemRows=porOrigem[item.origem];
    const aptos=origemRows.filter(row=>avaliarEstruturaHomologacao_(row,indice_(PPN.BASE_HEADERS)).status==='APTO_HOMOLOG').length;
    resumo.porOrigem[item.origem]={fonte:item.fonte,importados:item.importados,normalizados:item.normalizados,aptos,excecoes:item.normalizados-aptos};
  });
  atualizarChecklistPosProcessamento_(lote,resumo.porOrigem);
  return resumo;
}

function normalizarAba_(sheet, kind, lote) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getDisplayValues();
  const isPf = kind === 'PROFISSIONAL';
  const headerIndex=encontrarCabecalhoBruto_(data,isPf);
  const headers=data[headerIndex].map(normalizarCabecalho_);
  const idx=Object.fromEntries(headers.map((h,i)=>[h,i]));
  const out = [];
  data.slice(headerIndex+1).forEach((row, i) => {
    if (!row.some(Boolean)) return;
    const codigo = texto_(valorPorAliases_(row,idx,['CODIGO','CÓDIGO','ID']));
    const registro=valorPorAliases_(row,idx,['REGISTRO NACIONAL','REGISTRO_NACIONAL']);
    const docValue=valorPorAliases_(row,idx,isPf?['CPF','CPF/CNPJ','CPF_CNPJ','REGISTRO NACIONAL']:['CNPJ','CPF/CNPJ','CPF_CNPJ','REGISTRO NACIONAL']);
    const doc = identificadorSeguro_(docValue, isPf ? 11 : 14);
    const endereco=texto_(valorPorAliases_(row,idx,['ENDERECO','ENDEREÇO','ENDERECO COMPLETO','ENDEREÇO COMPLETO']));
    const parsed = separarEndereco_(endereco);
    const email = texto_(valorPorAliases_(row,idx,['EMAIL','E-MAIL'])).toLowerCase();
    const telefone = telefone_(valorPorAliases_(row,idx,['TELEFONE','FONE']));
    const celular = isPf ? telefone_(valorPorAliases_(row,idx,['CELULAR','TELEFONE CELULAR'])) : '';
    const docOk = isPf ? cpfValido_(doc) : cnpjValido_(doc);
    const emailOk = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const key = codigo ? `${kind}|${codigo}` : `${kind}|LINHA:${headerIndex+i+2}`;
    const now = new Date();
    out.push([
      key,lote,kind,headerIndex+i+2,codigo,identificadorSeguro_(registro,isPf ? 11 : 14),doc,docOk?'OK':'BLOQUEADO',
      texto_(valorPorAliases_(row,idx,isPf?['NOME','NOME COMPLETO']:['RAZAO SOCIAL','RAZÃO SOCIAL','NOME'])),email,emailOk?'OK':'INVALIDO',telefone,celular,endereco,
      parsed.cep,parsed.cep.length===8?'OK':'BLOQUEADO',parsed.logradouro,parsed.numero,parsed.complemento,parsed.bairro,parsed.cidade,parsed.uf,
      parsed.confianca,parsed.alertas.join(' | '),'','','','','','','PENDENTE','','','','','','','','PENDENTE_CEP','Validação oficial Correios pendente',now
    ]);
  });
  return out;
}

function contarRegistrosAbaBruta_(sheet,isPf){
  if(!sheet||sheet.getLastRow()<2)return 0;
  const data=sheet.getDataRange().getDisplayValues();
  const headerIndex=encontrarCabecalhoBruto_(data,isPf);
  return data.slice(headerIndex+1).filter(row=>row.some(v=>texto_(v)!=='')).length;
}

function codigosDuplicados_(rows){
  const b=indice_(PPN.BASE_HEADERS); const contagem=new Map();
  rows.forEach(row=>{const codigo=texto_(row[b.CODIGO]);if(codigo)contagem.set(codigo,(contagem.get(codigo)||0)+1);});
  return [...contagem.entries()].filter(([,total])=>total>1).map(([codigo,total])=>`${codigo} (${total}x)`);
}

function documentosDuplicados_(rows){
  const b=indice_(PPN.BASE_HEADERS); const contagem=new Map();
  rows.forEach(row=>{const doc=digitos_(row[b.CPF_CNPJ]);if(doc)contagem.set(doc,(contagem.get(doc)||0)+1);});
  return [...contagem.entries()].filter(([,total])=>total>1).map(([doc,total])=>`${doc.slice(0,3)}***${doc.slice(-3)} (${total}x)`);
}

function auditarIntegridadeImportacao_(lote,porOrigem,importacoes){
  return ['PROFISSIONAL','EMPRESA'].map(origem=>{
    const info=importacoes[origem]||{}; const rows=porOrigem[origem]||[];
    const fonte=Number(info.registrosFonte??rows.length); const importados=Number(info.registrosImportados??rows.length);
    const normalizados=rows.length; const duplicados=codigosDuplicados_(rows); const documentosDuplicados=documentosDuplicados_(rows); const problemas=[];
    if(fonte!==importados)problemas.push(`fonte=${fonte} e aba importada=${importados}`);
    if(importados!==normalizados)problemas.push(`aba importada=${importados} e base normalizada=${normalizados}`);
    if(duplicados.length)problemas.push(`códigos duplicados: ${duplicados.slice(0,20).join(', ')}`);
    if(documentosDuplicados.length)problemas.push(`documentos duplicados: ${documentosDuplicados.slice(0,20).join(', ')}`);
    return{
      lote,origem,arquivo:info.arquivo||'',sha256:info.sha256||'',fonte,importados,normalizados,
      duplicados:duplicados.length,documentosDuplicados:documentosDuplicados.length,aptos:0,excecoes:normalizados,
      fechamento:`${fonte} = ${importados} = ${normalizados}`,
      status:problemas.length?'BLOQUEADO':'OK',
      detalhe:problemas.length?problemas.join('; '):'Contagem integral e códigos únicos',
    };
  });
}

function registrarChecklistImportacao_(itens){
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.IMPORT_CHECKLIST); if(!sh)return;
  const agora=new Date(); const rows=itens.map(item=>[
    item.lote,item.origem,item.arquivo,item.sha256,item.fonte,item.importados,item.normalizados,item.duplicados,item.documentosDuplicados,item.aptos,item.excecoes,item.fechamento,item.status,item.detalhe,agora
  ]);
  escreverEmBlocos_(sh,sh.getLastRow()+1,rows,100); sh.setFrozenRows(1);
}

function atualizarChecklistPosProcessamento_(lote,porOrigem){
  const data=dados_(PPN.SHEETS.IMPORT_CHECKLIST); const i=indice_(data.headers);
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.IMPORT_CHECKLIST); let alterou=false;
  data.rows.forEach((row,pos)=>{
    const origem=texto_(row[i.ORIGEM]).toUpperCase(); if(texto_(row[i.LOTE])!==lote||!porOrigem[origem])return;
    const resumo=porOrigem[origem]; row[i.APTOS_HOMOLOG]=resumo.aptos; row[i.EXCECOES]=resumo.excecoes;
    row[i.FECHAMENTO]=`${resumo.normalizados} = ${resumo.aptos} + ${resumo.excecoes}`;
    row[i.STATUS]=resumo.normalizados===resumo.aptos+resumo.excecoes?'OK':'BLOQUEADO';
    row[i.DETALHE]=row[i.STATUS]==='OK'?'Origem, normalização e classificação fechadas sem perda':'Aptos + exceções não fecham com a base normalizada';
    sh.getRange(pos+data.headerRow+1,1,1,PPN.IMPORT_CHECKLIST_HEADERS.length).setValues([row.slice(0,PPN.IMPORT_CHECKLIST_HEADERS.length)]); alterou=true;
  });
  if(alterou)log_('CHECKLIST_IMPORTACAO',lote,'','OK','Contagens de PF e PJ reconciliadas até a classificação final','',1);
}

function higienizarCacheAposImportacao_(baseRows){
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.CACHE); const data=dados_(PPN.SHEETS.CACHE); const c=indice_(data.headers); const b=indice_(PPN.BASE_HEADERS);
  const ativos=new Set(baseRows.map(row=>digitos_(row[b.CEP_ORIGINAL])).filter(cep=>cep.length===8));
  const melhores=new Map(); let foraDaBaseRemovidos=0; let duplicadosRemovidos=0;
  data.rows.forEach(row=>{
    const cep=digitos_(row[c.CEP]); if(!ativos.has(cep)){foraDaBaseRemovidos++;return;}
    const anterior=melhores.get(cep); if(!anterior){melhores.set(cep,row);return;}
    duplicadosRemovidos++; if(pontuarCache_(row,c)>pontuarCache_(anterior,c))melhores.set(cep,row);
  });
  const rows=[...melhores.values()]; prepararAbaDados_(sh,PPN.CACHE_HEADERS); formatarColunasTextoAntes_(sh,2,rows.length,[1]); escreverEmBlocos_(sh,2,rows,500); sh.setFrozenRows(1);
  return{antes:data.rows.length,mantidos:rows.length,duplicadosRemovidos,foraDaBaseRemovidos};
}

function pontuarCache_(row,c){
  const status=texto_(row[c.STATUS]).toUpperCase(); const consulta=row[c.CONSULTADO_EM] instanceof Date?row[c.CONSULTADO_EM].getTime():new Date(row[c.CONSULTADO_EM]||0).getTime();
  return(status==='OK'?1e15:0)+(Number.isFinite(consulta)?consulta:0);
}

function aplicarCorrecoesPersistentesRetorno_(rows){
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.RETURNS); if(!sh||sh.getLastRow()<2)return 0;
  const retorno=dados_(PPN.SHEETS.RETURNS); const t=indice_(retorno.headers); const b=indice_(PPN.BASE_HEADERS); const porChave=new Map();
  retorno.rows.forEach(r=>{
    if(texto_(r[t.DECISAO]).toUpperCase()!=='APLICADO')return;
    const chave=`${texto_(r[t.ORIGEM]).toUpperCase()}|${texto_(r[t.CODIGO])}`;
    const atual=porChave.get(chave)||{}; const doc=digitos_(r[t.CPF_CNPJ_CORRIGIDO]); const cep=digitos_(r[t.CEP_CORRIGIDO]);
    if(doc)atual.doc=doc; if(cep)atual.cep=cep; porChave.set(chave,atual);
  });
  let aplicadas=0;
  rows.forEach(row=>{
    const correcao=porChave.get(`${texto_(row[b.ORIGEM]).toUpperCase()}|${texto_(row[b.CODIGO])}`); if(!correcao)return;
    if(correcao.doc){row[b.CPF_CNPJ]=correcao.doc;row[b.DOCUMENTO_STATUS]=(correcao.doc.length===11?cpfValido_(correcao.doc):cnpjValido_(correcao.doc))?'OK':'BLOQUEADO';}
    if(correcao.cep){row[b.CEP_ORIGINAL]=correcao.cep;row[b.CEP_FORMATO]=correcao.cep.length===8?'OK':'BLOQUEADO';limparValidacaoCepLinha_(row,b);}
    aplicadas++;
  });
  return aplicadas;
}

function aplicarCorrecoesPersistentesFilaNaMatriz_(rows){
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.EXC); if(!sh||sh.getLastRow()<2)return 0;
  const fila=dados_(PPN.SHEETS.EXC); const e=indice_(fila.headers); const b=indice_(PPN.BASE_HEADERS); const aprovadas=new Map();
  fila.rows.forEach(r=>{
    if(texto_(r[e.DECISAO]).toUpperCase()!=='APROVADO')return;
    if(texto_(r[e.TIPO_EXCECAO]).includes('NUMERO_NAO_IDENTIFICADO')&&!texto_(r[e.NUMERO_CORRECAO]))return;
    aprovadas.set(texto_(r[e.CHAVE]),r);
  });
  let aplicadas=0;
  rows.forEach(row=>{
    const r=aprovadas.get(texto_(row[b.CHAVE])); if(!r)return;
    row[b.LOGRADOURO_APROVADO]=r[e.LOGRADOURO_CORRECAO]; row[b.NUMERO_APROVADO]=r[e.NUMERO_CORRECAO]; row[b.COMPLEMENTO_APROVADO]=r[e.COMPLEMENTO_CORRECAO]; row[b.BAIRRO_APROVADO]=r[e.BAIRRO_CORRECAO]; row[b.CIDADE_APROVADA]=r[e.CIDADE_CORRECAO]; row[b.UF_APROVADA]=texto_(r[e.UF_CORRECAO]).toUpperCase(); row[b.APROVACAO_EXCECAO]='APROVADO'; aplicadas++;
  });
  return aplicadas;
}

function limparValidacaoCepLinha_(row,b){
  ['LOGRADOURO_CORREIOS','BAIRRO_CORREIOS','CIDADE_CORREIOS','UF_CORREIOS','CEP_RETORNADO_CORREIOS','TIPO_CEP_CORREIOS'].forEach(campo=>row[b[campo]]='');
  row[b.STATUS_CEP_CORREIOS]='PENDENTE'; row[b.STATUS_EXPORTACAO]='PENDENTE_CEP'; row[b.MOTIVO_BLOQUEIO]='Validação oficial Correios pendente após correção de CEP';
}

function encontrarCabecalhoBruto_(data,isPf){
  const docNames=isPf?['CPF','CPF/CNPJ','CPF_CNPJ']:['CNPJ','CPF/CNPJ','CPF_CNPJ'];
  const limit=Math.min(data.length,20);
  for(let i=0;i<limit;i++){
    const hs=data[i].map(normalizarCabecalho_);
    const hasCode=hs.includes('CODIGO')||hs.includes('ID');
    const hasAddress=hs.includes('ENDERECO')||hs.includes('ENDERECO COMPLETO');
    const hasDoc=docNames.some(h=>hs.includes(normalizarCabecalho_(h)))||hs.includes('REGISTRO NACIONAL');
    if(hasCode&&hasAddress&&hasDoc)return i;
  }
  throw new Error(`Cabeçalho bruto não localizado para ${isPf?'PROFISSIONAIS':'EMPRESAS'}. A importação foi interrompida sem substituir BASE_NORMALIZADA.`);
}

function valorPorAliases_(row,idx,aliases){
  for(const alias of aliases){const i=idx[normalizarCabecalho_(alias)];if(i!==undefined&&texto_(row[i])!=='')return row[i];}
  return '';
}

function identificadorSeguro_(value,len){
  let raw=texto_(value); let digits=digitos_(raw);
  if(/[eE]/.test(raw)){const n=Number(raw.replace(',','.'));if(Number.isSafeInteger(n))digits=String(n);}
  return digits?digits.padStart(len,'0'):'';
}

function validarSanidadeImportacao_(rows){
  if(!rows.length)throw new Error('Nenhum registro útil foi encontrado. BASE_NORMALIZADA foi preservada.');
  const b=indice_(PPN.BASE_HEADERS); const total=rows.length;
  const documentosOk=rows.filter(r=>r[b.DOCUMENTO_STATUS]==='OK').length;
  const cepsOk=rows.filter(r=>r[b.CEP_FORMATO]==='OK').length;
  const enderecos=rows.filter(r=>texto_(r[b.ENDERECO_BRUTO])!=='').length;
  if(total>=100&&(documentosOk/total<0.70||cepsOk/total<0.70||enderecos/total<0.90)){
    const msg=`Mapeamento anormal: total=${total}; documentosOK=${documentosOk}; cepsOK=${cepsOk}; enderecos=${enderecos}. BASE_NORMALIZADA foi preservada.`;
    log_('SANIDADE_IMPORTACAO','','','ABORTADO',msg,'',1); throw new Error(msg);
  }
  return{total,documentosOk,cepsOk,aptosPrevia:0,excecoes:0};
}

function separarEndereco_(value) {
  const raw = texto_(value).replace(/\s+/g,' ');
  const result = {cep:'',logradouro:'',numero:'',complemento:'',bairro:'',cidade:'',uf:'',confianca:'BLOQUEADO',alertas:[]};
  if (!raw) { result.alertas.push('ENDERECO_VAZIO'); return result; }
  const cepMatches=[...raw.matchAll(/(?:^|\D)(\d{5})-?(\d{3})(?!\d)/g)];
  if(cepMatches.length)result.cep=cepMatches[cepMatches.length-1][1]+cepMatches[cepMatches.length-1][2];
  if (result.cep.length !== 8) result.alertas.push('CEP_INVALIDO');
  const body=raw.replace(/\s*-\s*\d{5}-?\d{3}\s*$/,'').trim();
  const parts = body.split(/\s+-\s+/).map(texto_).filter(Boolean);
  const cityUf = parts.pop() || '';
  const m = cityUf.match(/^(.*)\/([A-Za-z]{2})$/);
  if (m) { result.cidade = texto_(m[1]); result.uf = m[2].toUpperCase(); }
  else result.alertas.push('CIDADE_UF_NAO_IDENTIFICADA');
  result.bairro = texto_(parts.pop());
  if (!result.bairro) result.alertas.push('BAIRRO_NAO_IDENTIFICADO');
  const front = texto_(parts.join(' - ')).replace(/\bN[º°O]?\.?\s*(?=\d)/gi,'');
  const tokens = front.replace(/,/g,' , ').split(/\s+/).filter(Boolean);
  const numberRx = /^(?:S\/?N|SN|S\.N\.|\d+[A-Za-z]?|\d+-[A-Za-z0-9]+)$/i;
  let pos = -1;
  for (let i=tokens.length-1;i>=1;i--) if (numberRx.test(tokens[i])) { pos=i; break; }
  if (pos < 1) {
    result.logradouro = front;
    result.alertas.push('NUMERO_NAO_IDENTIFICADO');
  } else {
    result.numero = tokens[pos].toUpperCase().replace(/^SN$/,'S/N');
    result.logradouro = texto_(tokens.slice(0,pos).join(' ').replace(/\s+,\s*/g,', '));
    result.complemento = texto_(tokens.slice(pos+1).join(' ').replace(/\s+,\s*/g,', '));
    const markers = tokens.filter((t,i) => i >= Math.max(1,pos-5) && numberRx.test(t));
    if (markers.length > 1) result.alertas.push('NUMERO_AMBIGUO');
  }
  const essential = result.cep && result.logradouro && result.numero && result.bairro && result.cidade && result.uf;
  if (essential && result.alertas.length === 0) result.confianca='ALTA';
  else if (essential && result.alertas.every(a => a==='NUMERO_AMBIGUO')) result.confianca='REVISAR';
  return result;
}

function iniciarValidacaoCepCorreios() {
  validarConfig_(['AMBIENTE','NUMERO_CONTRATO','DR','BATCH_CEP']);
  const secrets = PropertiesService.getScriptProperties();
  if (!secrets.getProperty('CORREIOS_USUARIO') || !secrets.getProperty('CORREIOS_CODIGO_ACESSO')) throw new Error('Execute “Configurar credenciais Correios” primeiro.');
  removerTriggers_('validarProximoLoteCep');
  checkpoint_('ANTES_VALIDACAO_CEP');
  validarProximoLoteCep();
}

function validarProximoLoteCep() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  const started = Date.now();
  try {
    const baseData = dados_(PPN.SHEETS.BASE);
    if (baseData.rows.length === 0) throw new Error('BASE_NORMALIZADA está vazia. Importe os arquivos AR Digital.');
    const b = indice_(baseData.headers);
    const cacheData = dados_(PPN.SHEETS.CACHE);
    const c = indice_(cacheData.headers);
    const cache = new Map();
    cacheData.rows.forEach((r,i) => cache.set(digitos_(r[c.CEP]), {row:r, sheetRow:i+cacheData.headerRow+1}));
    const unique = [...new Set(baseData.rows.map(r => digitos_(r[b.CEP_ORIGINAL])).filter(cep => cep.length===8))];
    const now = Date.now();
    const pending = unique.filter(cep => {
      const item = cache.get(cep);
      if (!item) return true;
      const attempts = Number(item.row[c.TENTATIVAS] || 0);
      const expires = item.row[c.EXPIRA_EM] instanceof Date ? item.row[c.EXPIRA_EM].getTime() : new Date(item.row[c.EXPIRA_EM] || 0).getTime();
      if (item.row[c.STATUS] === 'OK' && expires > now) return false;
      if (item.row[c.STATUS] === 'ERRO_DEFINITIVO') return false;
      return attempts < 3;
    });
    if (pending.length === 0) {
      aplicarCacheNaBase_();
      atualizarFilaExcecoes();
      removerTriggers_('validarProximoLoteCep');
      log_('CEP_LOTE', '', '', 'CONCLUIDO', 'Todos os CEPs processados', Date.now()-started, 1);
      SpreadsheetApp.getActive().toast('Validação de CEP concluída.', 'Correios PPN', 10);
      return;
    }
    const batchSize = Math.max(1, Math.min(Number(config_('BATCH_CEP') || 50),100));
    const batch = pending.slice(0,batchSize);
    const token = obterTokenCorreios_();
    const baseUrl = ambiente_() === 'PRODUCAO' ? 'https://api.correios.com.br/cep/v2/enderecos/' : 'https://apihom.correios.com.br/cep/v2/enderecos/';
    const requests = batch.map(cep => ({url:baseUrl+cep,method:'get',headers:{Authorization:'Bearer '+token,Accept:'application/json'},muteHttpExceptions:true}));
    const responses = UrlFetchApp.fetchAll(requests);
    const cacheSheet = SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.CACHE);
    const output = responses.map((response,i) => interpretarCep_(batch[i],response,cache.get(batch[i]),started));
    output.forEach(record => upsertCache_(cacheSheet, cache, record));
    aplicarCacheNaBase_();
    log_('CEP_LOTE', '', `${batch.length} CEPs`, 'SUCESSO', `Restantes antes do lote: ${pending.length}`, Date.now()-started, 1);
    removerTriggers_('validarProximoLoteCep');
    ScriptApp.newTrigger('validarProximoLoteCep').timeBased().after(60*1000).create();
  } finally {
    lock.releaseLock();
  }
}

function interpretarCep_(cep,response,previous,started){
  const r=lerRespostaJsonSegura_(response); const cacheIndex=indice_(PPN.CACHE_HEADERS);
  const previousAttempts=previous&&previous.row[cacheIndex.STATUS]!=='OK'?Number(previous.row[cacheIndex.TENTATIVAS]||0):0;
  let item=null;
  if(r.jsonValido){const json=r.json;item=Array.isArray(json)?json[0]:(json&&Array.isArray(json.itens)?json.itens[0]:json);}
  const returned=item?digitos_(item.cep||item.nuCep||''):'';
  const uf=item?texto_(item.uf||item.siglaUf).toUpperCase():'';
  const cidade=item?texto_(item.localidade||item.cidade||item.nomeLocalidade):'';
  if(r.http>=200&&r.http<300&&r.jsonValido&&item&&returned.length===8&&uf.length===2&&cidade){
    return[cep,'OK',r.http,texto_(item.logradouro||item.nomeLogradouro||item.endereco),texto_(item.bairro||item.nomeBairro),cidade,uf,returned,texto_(item.tipoCep||item.tipoCEP||item.tipo),texto_(item.mensagem),new Date(),diasDepois_(Number(config_('VALIDADE_CACHE_DIAS')||30)),previousAttempts+1];
  }
  const respostaInesperada=r.http>=200&&r.http<300&&(!r.jsonValido||!item||returned.length!==8||uf.length!==2||!cidade);
  const temporary=r.http===429||r.http>=500||respostaInesperada;
  let mensagem=r.jsonValido?resumirErro_(r.json,r.body):`${r.erro}${r.contentType?'; Content-Type='+r.contentType:''}`;
  if(respostaInesperada&&r.jsonValido)mensagem='Resposta JSON incompleta/incompatível com o schema esperado';
  return[cep,temporary?'ERRO_TEMPORARIO':'ERRO_DEFINITIVO',r.http,'','','','','','',mensagem,new Date(),new Date(0),previousAttempts+1];
}

function lerRespostaJsonSegura_(response){
  const http=response.getResponseCode(); const body=String(response.getContentText()||'').trim(); let contentType='';
  try{const headers=response.getHeaders()||{};contentType=String(headers['Content-Type']||headers['content-type']||'').trim();}catch(e){}
  if(!body)return{http,body:'',contentType,json:null,jsonValido:false,erro:'RESPOSTA_VAZIA'};
  if(body.startsWith('<')||/<!doctype/i.test(body)||/<html/i.test(body))return{http,body,contentType,json:null,jsonValido:false,erro:'RESPOSTA_HTML'};
  try{return{http,body,contentType,json:JSON.parse(body),jsonValido:true,erro:''};}
  catch(e){return{http,body,contentType,json:null,jsonValido:false,erro:'JSON_INVALIDO'};}
}

function obterTokenCorreios_() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('CORREIOS_TOKEN');
  const expires = Number(props.getProperty('CORREIOS_TOKEN_EXPIRA') || 0);
  if (cached && expires > Date.now()+60000) return cached;
  const user = props.getProperty('CORREIOS_USUARIO');
  const code = props.getProperty('CORREIOS_CODIGO_ACESSO');
  if(!user||!code)throw new Error('Credenciais Correios não configuradas. Execute “3. Configurar credenciais Correios”.');
  const url = ambiente_()==='PRODUCAO' ? 'https://api.correios.com.br/token/v1/autentica/contrato' : 'https://apihom.correios.com.br/token/v1/autentica/contrato';
  const payload = {numero:String(config_('NUMERO_CONTRATO')),dr:Number(config_('DR'))};
  const response = UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',payload:JSON.stringify(payload),headers:{Authorization:'Basic '+Utilities.base64Encode(user+':'+code),Accept:'application/json'},muteHttpExceptions:true,followRedirects:true});
  const r=lerRespostaJsonSegura_(response);
  if(r.http<200||r.http>=300){
    const msg=r.jsonValido?resumirErro_(r.json,r.body):`${r.erro}${r.contentType?'; Content-Type='+r.contentType:''}`;
    log_('TOKEN_CORREIOS','',r.http,'ERRO_HTTP',msg,'',1);
    throw new Error(`Falha ao gerar token Correios: HTTP ${r.http} — ${msg}`);
  }
  if(!r.jsonValido){
    const inicio=r.body.replace(/\s+/g,' ').slice(0,180);
    log_('TOKEN_CORREIOS','',r.http,r.erro,`Content-Type=${r.contentType||'[não informado]'}`,'',1);
    throw new Error(`API Token dos Correios respondeu HTTP ${r.http}, porém não retornou JSON válido.\n\nTipo: ${r.erro}\nContent-Type: ${r.contentType||'[não informado]'}\nInício da resposta: ${inicio}`);
  }
  const json = r.json||{};
  const token = json.token || json.access_token;
  if (!token) throw new Error('API Token respondeu JSON, mas nenhum token foi encontrado.');
  const expiration = new Date(json.expiraEm || json.expiresAt || Date.now()+50*60*1000).getTime();
  props.setProperties({CORREIOS_TOKEN:token,CORREIOS_TOKEN_EXPIRA:String(Number.isFinite(expiration)?expiration:Date.now()+50*60*1000)});
  log_('TOKEN_CORREIOS','',r.http,'SUCESSO','Token recebido e armazenado em ScriptProperties','',1);
  return token;
}

function aplicarCacheNaBase_() {
  const ss = SpreadsheetApp.getActive();
  const baseSheet = ss.getSheetByName(PPN.SHEETS.BASE);
  const baseData = dados_(PPN.SHEETS.BASE); const b = indice_(baseData.headers);
  const cacheData = dados_(PPN.SHEETS.CACHE); const c = indice_(cacheData.headers);
  const cache = new Map(cacheData.rows.map(r => [digitos_(r[c.CEP]),r]));
  const card = texto_(config_('CARTAO_POSTAGEM'));
  const malote = texto_(config_('MALOTE')).toUpperCase();
  const updated = baseData.rows.map(row => {
    const item = cache.get(digitos_(row[b.CEP_ORIGINAL]));
    if (item) {
      row[b.LOGRADOURO_CORREIOS]=item[c.LOGRADOURO]; row[b.BAIRRO_CORREIOS]=item[c.BAIRRO]; row[b.CIDADE_CORREIOS]=item[c.CIDADE]; row[b.UF_CORREIOS]=item[c.UF]; row[b.CEP_RETORNADO_CORREIOS]=item[c.CEP_RETORNADO]; row[b.TIPO_CEP_CORREIOS]=item[c.TIPO_CEP]; row[b.STATUS_CEP_CORREIOS]=item[c.STATUS];
    }
    const decision = avaliarLinha_(row,b,card,malote);
    row[b.STATUS_EXPORTACAO]=decision.status; row[b.MOTIVO_BLOQUEIO]=decision.reason; row[b.ATUALIZADO_EM]=new Date();
    return row;
  });
  if (updated.length){formatarColunasTextoAntes_(baseSheet,2,updated.length,[1,2,3,5,6,7,12,13,15,29]);baseSheet.getRange(2,1,updated.length,PPN.BASE_HEADERS.length).setValues(updated);}
}

function avaliarLinha_(row,b,card,malote) {
  if (!card) return {status:'BLOQUEADO',reason:'Cartão de postagem não configurado'};
  if (!['S','N'].includes(malote)) return {status:'BLOQUEADO',reason:'Malote deve ser S ou N'};
  if (!texto_(row[b.CODIGO]) || !texto_(row[b.NOME])) return {status:'BLOQUEADO',reason:'Código ou nome do destinatário ausente'};
  if (row[b.DOCUMENTO_STATUS]!=='OK') return {status:'BLOQUEADO',reason:'CPF/CNPJ inválido'};
  if (row[b.CEP_FORMATO]!=='OK') return {status:'BLOQUEADO',reason:'CEP com formato inválido'};
  if (row[b.STATUS_CEP_CORREIOS]!=='OK') return {status:'PENDENTE_CEP',reason:'Validação oficial Correios pendente/erro'};
  if (digitos_(row[b.CEP_RETORNADO_CORREIOS])!==digitos_(row[b.CEP_ORIGINAL])) return {status:'BLOQUEADO_CEP_DIVERGENTE',reason:'CEP retornado difere do original; não substituir automaticamente'};
  const ufParser=normalizarCabecalho_(row[b.UF_PARSER]); const ufCorreios=normalizarCabecalho_(row[b.UF_CORREIOS]);
  const cidadeParser=normalizarCabecalho_(row[b.CIDADE_PARSER]); const cidadeCorreios=normalizarCabecalho_(row[b.CIDADE_CORREIOS]);
  if (ufParser && ufCorreios && ufParser!==ufCorreios) return {status:'BLOQUEADO_DIVERGENCIA_ENDERECO',reason:'UF do endereço diverge da UF oficial do CEP'};
  if (cidadeParser && cidadeCorreios && cidadeParser!==cidadeCorreios) return {status:'PENDENTE_EXCECAO',reason:'Cidade do endereço diverge da cidade oficial do CEP'};
  const approved = String(row[b.APROVACAO_EXCECAO]).toUpperCase()==='APROVADO';
  if (row[b.PARSER_CONFIANCA]!=='ALTA' && !approved) return {status:'PENDENTE_EXCECAO',reason:'Número/endereço exige revisão de exceção'};
  const numero = texto_(row[b.NUMERO_APROVADO] || row[b.NUMERO_PARSER]);
  const logradouro = texto_(row[b.LOGRADOURO_APROVADO] || row[b.LOGRADOURO_CORREIOS] || row[b.LOGRADOURO_PARSER]);
  const bairro = texto_(row[b.BAIRRO_APROVADO] || row[b.BAIRRO_CORREIOS] || row[b.BAIRRO_PARSER]);
  const cidade = texto_(row[b.CIDADE_APROVADA] || row[b.CIDADE_CORREIOS] || row[b.CIDADE_PARSER]);
  const uf = texto_(row[b.UF_APROVADA] || row[b.UF_CORREIOS] || row[b.UF_PARSER]);
  if (!numero || !logradouro || !bairro || !cidade || uf.length!==2) return {status:'PENDENTE_EXCECAO',reason:'Endereço oficial/complementar incompleto'};
  return {status:'APTO',reason:''};
}

function atualizarFilaExcecoes() {
  const data = dados_(PPN.SHEETS.BASE); const b = indice_(data.headers);
  validarCabecalhosLeitura_(data.headers,['CHAVE','CODIGO','CPF_CNPJ','NOME','CEP_ORIGINAL','ENDERECO_BRUTO','DOCUMENTO_STATUS','CEP_FORMATO','PARSER_CONFIANCA'],PPN.SHEETS.BASE);
  const previous = dados_(PPN.SHEETS.EXC); const e = indice_(previous.headers);
  const corrections = new Map(previous.rows.map(r => [r[e.CHAVE],r]));
  const rows = [];
  data.rows.forEach(row => {
    const issues = [];
    if (row[b.DOCUMENTO_STATUS]!=='OK') issues.push('DOCUMENTO_INVALIDO');
    if (row[b.CEP_FORMATO]!=='OK') issues.push('CEP_INVALIDO');
    if (row[b.PARSER_CONFIANCA]!=='ALTA') issues.push(row[b.PARSER_ALERTAS] || 'ENDERECO_AMBIGUO');
    if (row[b.STATUS_EXPORTACAO]==='BLOQUEADO_CEP_DIVERGENTE') issues.push('CEP_DIVERGENTE');
    if (row[b.STATUS_EXPORTACAO]==='BLOQUEADO_DIVERGENCIA_ENDERECO') issues.push('UF_DIVERGENTE');
    if (row[b.STATUS_CEP_CORREIOS]==='ERRO_CEP_PPN') issues.push('CEP_REJEITADO_CORREIOS');
    else if (String(row[b.STATUS_CEP_CORREIOS]).startsWith('ERRO_')) issues.push('CEP_API_'+row[b.STATUS_CEP_CORREIOS]);
    if (!issues.length) return;
    const old = corrections.get(row[b.CHAVE]) || [];
    const numeroCorrecao=old[e.NUMERO_CORRECAO]||''; const exigeNumero=issues.some(issue=>String(issue).includes('NUMERO_NAO_IDENTIFICADO'));
    const decisaoAnterior=texto_(old[e.DECISAO]||'PENDENTE').toUpperCase(); const decisao=exigeNumero&&!texto_(numeroCorrecao)&&decisaoAnterior==='APROVADO'?'PENDENTE':decisaoAnterior;
    const detalhe=exigeNumero&&!texto_(numeroCorrecao)?'Número obrigatório ausente: informe NUMERO_CORRECAO (número real ou S/N confirmado) antes de aprovar':row[b.MOTIVO_BLOQUEIO];
    rows.push([row[b.CHAVE],row[b.ORIGEM],row[b.LINHA_ORIGEM],row[b.CODIGO],row[b.CPF_CNPJ],row[b.NOME],row[b.CEP_ORIGINAL],row[b.ENDERECO_BRUTO],issues.join(' | '),detalhe,old[e.LOGRADOURO_CORRECAO]||'',numeroCorrecao,old[e.COMPLEMENTO_CORRECAO]||'',old[e.BAIRRO_CORRECAO]||'',old[e.CIDADE_CORRECAO]||'',old[e.UF_CORRECAO]||'',decisao||'PENDENTE',old[e.RESPONSAVEL]||'',old[e.DATA_DECISAO]||'',old[e.OBSERVACAO]||'']);
  });
  const sheet = SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.EXC);
  prepararAbaDados_(sheet,PPN.EXC_HEADERS);
  escreverEmBlocos_(sheet,2,rows,500);
  if (rows.length) sheet.getRange(2,17,rows.length,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['PENDENTE','APROVADO','BLOQUEADO'],true).build());
  sheet.setFrozenRows(1);
}

function aplicarCorrecoesExcecoes() {
  const baseData = dados_(PPN.SHEETS.BASE); const b = indice_(baseData.headers);
  const excData = dados_(PPN.SHEETS.EXC); const e = indice_(excData.headers);
  const invalidas=excData.rows.filter(r=>texto_(r[e.DECISAO]).toUpperCase()==='APROVADO'&&texto_(r[e.TIPO_EXCECAO]).includes('NUMERO_NAO_IDENTIFICADO')&&!texto_(r[e.NUMERO_CORRECAO]));
  if(invalidas.length)throw new Error(`Há ${invalidas.length} aprovação(ões) sem número corrigido. Preencha NUMERO_CORRECAO com o número confirmado ou S/N antes de aplicar. Códigos: ${invalidas.slice(0,20).map(r=>r[e.CODIGO]).join(', ')}`);
  checkpoint_('ANTES_CORRECOES');
  const byKey = new Map(baseData.rows.map((r,i) => [r[b.CHAVE],i]));
  excData.rows.forEach(r => {
    if (String(r[e.DECISAO]).toUpperCase()!=='APROVADO') return;
    const i = byKey.get(r[e.CHAVE]); if (i===undefined) return;
    const row = baseData.rows[i];
    row[b.LOGRADOURO_APROVADO]=r[e.LOGRADOURO_CORRECAO]; row[b.NUMERO_APROVADO]=r[e.NUMERO_CORRECAO]; row[b.COMPLEMENTO_APROVADO]=r[e.COMPLEMENTO_CORRECAO]; row[b.BAIRRO_APROVADO]=r[e.BAIRRO_CORRECAO]; row[b.CIDADE_APROVADA]=r[e.CIDADE_CORRECAO]; row[b.UF_APROVADA]=String(r[e.UF_CORRECAO]).toUpperCase(); row[b.APROVACAO_EXCECAO]='APROVADO';
  });
  const sheet=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.BASE);
  if (baseData.rows.length){formatarColunasTextoAntes_(sheet,2,baseData.rows.length,[1,2,3,5,6,7,12,13,15,29]);sheet.getRange(2,1,baseData.rows.length,PPN.BASE_HEADERS.length).setValues(baseData.rows);}
  aplicarCacheNaBase_(); atualizarFilaExcecoes(); atualizarPreviaDestinatarios_();
}

function avaliarEstruturaHomologacao_(row,b){
  if(!texto_(row[b.CODIGO])||!texto_(row[b.NOME]))return{status:'BLOQUEADO',reason:'Código ou nome ausente'};
  if(row[b.DOCUMENTO_STATUS]!=='OK')return{status:'BLOQUEADO',reason:'CPF/CNPJ inválido'};
  if(row[b.CEP_FORMATO]!=='OK')return{status:'BLOQUEADO',reason:'CEP sem 8 dígitos'};
  const approved=String(row[b.APROVACAO_EXCECAO]).toUpperCase()==='APROVADO';
  if(row[b.PARSER_CONFIANCA]!=='ALTA'&&!approved)return{status:'REVISAR',reason:row[b.PARSER_ALERTAS]||'Endereço ambíguo'};
  const numero=texto_(row[b.NUMERO_APROVADO]||row[b.NUMERO_PARSER]);
  const logradouro=texto_(row[b.LOGRADOURO_APROVADO]||row[b.LOGRADOURO_CORREIOS]||row[b.LOGRADOURO_PARSER]);
  const bairro=texto_(row[b.BAIRRO_APROVADO]||row[b.BAIRRO_CORREIOS]||row[b.BAIRRO_PARSER]);
  const cidade=texto_(row[b.CIDADE_APROVADA]||row[b.CIDADE_CORREIOS]||row[b.CIDADE_PARSER]);
  const uf=texto_(row[b.UF_APROVADA]||row[b.UF_CORREIOS]||row[b.UF_PARSER]);
  if(!numero||!logradouro||!bairro||!cidade||uf.length!==2)return{status:'REVISAR',reason:'Endereço incompleto'};
  return{status:'APTO_HOMOLOG',reason:'Validação estrutural; CEP oficial/PPN ainda pendente'};
}

function linhaDestinatario_(r,b,card,malote){
  const tamanhoDocumento=texto_(r[b.ORIGEM]).toUpperCase()==='EMPRESA'?14:11;
  return[card,malote,texto_(r[b.CODIGO]),texto_(r[b.NOME]),r[b.EMAIL_STATUS]==='OK'?texto_(r[b.EMAIL]):'',identificadorSeguro_(r[b.CPF_CNPJ],tamanhoDocumento),telefoneExport_(r[b.TELEFONE]),telefoneExport_(r[b.CELULAR]),identificadorSeguro_(r[b.CEP_ORIGINAL],8),texto_(r[b.LOGRADOURO_APROVADO]||r[b.LOGRADOURO_CORREIOS]||r[b.LOGRADOURO_PARSER]),texto_(r[b.NUMERO_APROVADO]||r[b.NUMERO_PARSER]),texto_(r[b.COMPLEMENTO_APROVADO]||r[b.COMPLEMENTO_PARSER]),texto_(r[b.BAIRRO_APROVADO]||r[b.BAIRRO_CORREIOS]||r[b.BAIRRO_PARSER]),texto_(r[b.CIDADE_APROVADA]||r[b.CIDADE_CORREIOS]||r[b.CIDADE_PARSER]),texto_(r[b.UF_APROVADA]||r[b.UF_CORREIOS]||r[b.UF_PARSER]).toUpperCase()];
}

function atualizarPreviaDestinatarios_(){
  const data=dados_(PPN.SHEETS.BASE); const b=indice_(data.headers);
  validarCabecalhosLeitura_(data.headers,['CODIGO','NOME','EMAIL','EMAIL_STATUS','CPF_CNPJ','TELEFONE','CELULAR','CEP_ORIGINAL','LOGRADOURO_PARSER','NUMERO_PARSER','COMPLEMENTO_PARSER','BAIRRO_PARSER','CIDADE_PARSER','UF_PARSER','DOCUMENTO_STATUS','CEP_FORMATO','PARSER_CONFIANCA'],PPN.SHEETS.BASE);
  const card=texto_(config_('CARTAO_POSTAGEM')); const malote=texto_(config_('MALOTE')).toUpperCase(); let aptos=0;
  const rows=data.rows.map(r=>{const d=avaliarEstruturaHomologacao_(r,b);if(d.status==='APTO_HOMOLOG')aptos++;return[...linhaDestinatario_(r,b,card,malote),d.status,d.reason];});
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.PREVIEW); prepararAbaDados_(sh,PPN.PREVIEW_HEADERS);
  formatarMatrizComoTextoAntes_(sh,2,rows.length,PPN.PREVIEW_HEADERS.length); escreverEmBlocos_(sh,2,rows,500); if(rows.length)sh.getRange(1,1,rows.length+1,PPN.PREVIEW_HEADERS.length).setNumberFormat('@'); sh.setFrozenRows(1);
  return aptos;
}

function validarOrigemAlvo_(value){
  const origem=texto_(value).toUpperCase();
  if(['','PROFISSIONAL','EMPRESA'].includes(origem))return origem;
  throw new Error(`Origem inválida: ${origem}. Use PROFISSIONAL, EMPRESA ou vazio para ambos.`);
}

function origemCorresponde_(row,b,origemAlvo){
  return !origemAlvo||texto_(row[b.ORIGEM]).toUpperCase()===origemAlvo;
}

function rotuloOrigem_(origemAlvo){
  if(origemAlvo==='PROFISSIONAL')return'de profissionais (PF)';
  if(origemAlvo==='EMPRESA')return'de empresas (PJ)';
  return'de profissionais e empresas (PF + PJ)';
}

function gerarXlsxDestinatariosHomologacao(){
  return gerarXlsxDestinatariosHomologacaoPorOrigem_('');
}

function gerarXlsxDestinatariosHomologacaoPf(){
  return gerarXlsxDestinatariosHomologacaoPorOrigem_('PROFISSIONAL');
}

function gerarXlsxDestinatariosHomologacaoPj(){
  return gerarXlsxDestinatariosHomologacaoPorOrigem_('EMPRESA');
}

function gerarXlsxDestinatariosHomologacaoPorOrigem_(origemAlvo){
  if(ambiente_()!=='HOMOLOG')throw new Error('A exportação estrutural sem CEP oficial só é permitida com AMBIENTE=HOMOLOG.');
  origemAlvo=validarOrigemAlvo_(origemAlvo);
  const data=dados_(PPN.SHEETS.BASE); const b=indice_(data.headers);
  const elegiveis=data.rows.filter(r=>origemCorresponde_(r,b,origemAlvo)&&avaliarEstruturaHomologacao_(r,b).status==='APTO_HOMOLOG');
  if(!elegiveis.length)throw new Error(`Nenhum registro ${rotuloOrigem_(origemAlvo)} está APTO_HOMOLOG. Consulte PREVIA_DESTINATARIOS e FILA_EXCECOES.`);
  return gerarXlsxDestinatariosSeparados_(elegiveis,b,'HOMOLOG_PPN_DESTINATARIOS','ANTES_EXPORT_HOMOLOG_DESTINATARIOS','HOMOLOG',origemAlvo);
}

function gerarXlsxDestinatarios() {
  return gerarXlsxDestinatariosPorOrigem_('');
}

function gerarXlsxDestinatariosPf(){
  return gerarXlsxDestinatariosPorOrigem_('PROFISSIONAL');
}

function gerarXlsxDestinatariosPj(){
  return gerarXlsxDestinatariosPorOrigem_('EMPRESA');
}

function gerarXlsxDestinatariosPorOrigem_(origemAlvo){
  if(ambiente_()!=='PRODUCAO')throw new Error('A exportação de destinatários para produção exige AMBIENTE=PRODUCAO. Para testes, use a ação de homologação.');
  origemAlvo=validarOrigemAlvo_(origemAlvo);
  aplicarCacheNaBase_();
  const data=dados_(PPN.SHEETS.BASE); const b=indice_(data.headers);
  const elegiveis=data.rows.filter(r=>origemCorresponde_(r,b,origemAlvo)&&r[b.STATUS_EXPORTACAO]==='APTO');
  if(!elegiveis.length)throw new Error(`Nenhum destinatário ${rotuloOrigem_(origemAlvo)} está APTO. Nenhum arquivo foi gerado.`);
  return gerarXlsxDestinatariosSeparados_(elegiveis,b,'PPN_DESTINATARIOS','ANTES_EXPORT_DESTINATARIOS','PRODUCAO',origemAlvo);
}

function gerarXlsxDestinatariosSeparados_(elegiveis,b,prefixo,checkpointLabel,ambiente,origemAlvo){
  validarConfig_(['CARTAO_POSTAGEM','MALOTE']);
  origemAlvo=validarOrigemAlvo_(origemAlvo);
  const card=texto_(config_('CARTAO_POSTAGEM')); const malote=texto_(config_('MALOTE')).toUpperCase();
  if(!['S','N'].includes(malote))throw new Error('MALOTE deve ser S ou N.');
  const grupos=[
    {origem:'PROFISSIONAL',sheet:PPN.SHEETS.EXPORT_DEST_PF,sufixo:'PROFISSIONAIS'},
    {origem:'EMPRESA',sheet:PPN.SHEETS.EXPORT_DEST_PJ,sufixo:'EMPRESAS'},
  ].filter(grupo=>!origemAlvo||grupo.origem===origemAlvo).map(grupo=>{
    const rows=elegiveis
      .filter(r=>texto_(r[b.ORIGEM]).toUpperCase()===grupo.origem)
      .map(r=>linhaDestinatario_(r,b,card,malote));
    gravarExportacaoDestinatarios_(grupo.sheet,rows);
    return{...grupo,rows};
  });
  const comDados=grupos.filter(grupo=>grupo.rows.length);
  if(!comDados.length)throw new Error('Nenhum destinatário elegível foi identificado como PROFISSIONAL ou EMPRESA.');
  checkpoint_(checkpointLabel);
  const stamp=carimbo_();
  const resultados=comDados.map(grupo=>{
    const resultado=criarArquivoXlsx_(
      grupo.sheet,
      `${prefixo}_${grupo.sufixo}_${stamp}.xlsx`,
      PPN_FILES.TEMPLATE_DEST,
      PPN.DEST_HEADERS,
      grupo.rows
    );
    registrarBaseEnvioDestinatarios_(resultado,grupo.origem,grupo.rows,ambiente);
    return resultado;
  });
  const linhas=resultados.map(r=>`${r.fileName}: ${r.rows} registros\nSHA-256: ${r.hash}`);
  log_('EXPORTAR_DESTINATARIOS_SEPARADOS','', '', 'SUCESSO',`ambiente=${ambiente}; ${resultados.map(r=>`${r.fileName}=${r.rows}`).join('; ')}`,'',1);
  SpreadsheetApp.getUi().alert(`Destinatários ${rotuloOrigem_(origemAlvo)} gerados com sucesso.\n\n${linhas.join('\n\n')}\n\nA aba EXPORT_DESTINATARIOS foi preservada apenas como histórico; as novas auditorias ficam nas abas segmentadas.`);
  return resultados.map(r=>r.fileId);
}

function gravarExportacaoDestinatarios_(sheetName,rows){
  validarMatrizExportacao_(PPN.DEST_HEADERS,rows,sheetName);
  const sh=SpreadsheetApp.getActive().getSheetByName(sheetName);
  prepararAbaDados_(sh,PPN.DEST_HEADERS);
  formatarMatrizComoTextoAntes_(sh,2,rows.length,PPN.DEST_HEADERS.length);
  escreverEmBlocos_(sh,2,rows,500);
  if(rows.length)for(let col=1;col<=PPN.DEST_HEADERS.length;col++)sh.getRange(2,col,rows.length,1).setNumberFormat('@');
  const actual=sh.getRange(1,1,1,PPN.DEST_HEADERS.length).getDisplayValues()[0];
  const mismatch=PPN.DEST_HEADERS.findIndex((header,i)=>actual[i]!==header);
  if(mismatch>=0)throw new Error(`Aba ${sheetName} fora do padrão na coluna ${mismatch+1}: esperado ${PPN.DEST_HEADERS[mismatch]}, recebido ${actual[mismatch]}.`);
  sh.getRange(1,1,1,PPN.DEST_HEADERS.length).setBackground('#0F5D50').setFontColor('#FFFFFF').setFontWeight('bold').setWrap(true);
  sh.setFrozenRows(1);
}

function registrarBaseEnvioDestinatarios_(resultado,origem,rows,ambiente){
  atualizarCabecalhosGerenciados_(SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.VERIFIED),PPN.VERIFIED_HEADERS);
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.VERIFIED); const existentes=dados_(PPN.SHEETS.VERIFIED); const v=indice_(existentes.headers);
  if(existentes.rows.some(r=>texto_(r[v.ARQUIVO_EXPORTADO])===resultado.fileName))return false;
  const id=Utilities.getUuid(); const agora=new Date(); const saida=rows.map((row,i)=>[
    id,resultado.fileName,origem,i+2,texto_(row[2]),texto_(row[3]),digitos_(row[5]),digitos_(row[8]),`VALIDADO_${ambiente}`,'AGUARDANDO_RETORNO','', '',agora,'','DESTINATARIOS_XLSX','',`${origem}|${texto_(row[2])}`,''
  ]);
  formatarColunasTextoAntes_(sh,sh.getLastRow()+1,saida.length,[1,2,3,4,5,6,7,8,15,16,17,18]);
  escreverEmBlocos_(sh,sh.getLastRow()+1,saida,500); sh.setFrozenRows(1); return true;
}

function importarReciboCorreios(){return importarRetornoCorreios();}

function importarRetornoCorreios(){
  const ui=SpreadsheetApp.getUi(); const prompt=ui.prompt('Importar retorno dos Correios','Cole o ID ou o link do recibo PDF ou do arquivo JSON/TXT de inconsistências salvo no Google Drive.',ui.ButtonSet.OK_CANCEL);
  if(prompt.getSelectedButton()!==ui.Button.OK)return;
  const fileId=extrairIdDrive_(prompt.getResponseText()); if(!fileId)throw new Error('ID do arquivo de retorno não identificado.');
  const file=DriveApp.getFileById(fileId); const nome=file.getName(); const mime=file.getMimeType(); let recibo;
  if(mime===MimeType.PDF||/\.pdf$/i.test(nome))recibo=analisarReciboCorreios_(extrairTextoPdf_(file));
  else if(mime==='application/json'||mime===MimeType.PLAIN_TEXT||/\.(json|txt)$/i.test(nome))recibo=analisarRetornoObjetoRegistrado_(file.getBlob().getDataAsString('UTF-8'),nome);
  else throw new Error(`Formato de retorno não suportado: ${nome}. Use PDF, JSON ou TXT.`);
  const reconstruido=recibo.tipoExportacao==='OBJETO_REGISTRADO_JSON'?false:garantirManifestoParaRecibo_(recibo.arquivo,recibo.origem);
  registrarRetornoCorreios_(fileId,recibo,reconstruido);
}

function registrarRetornoCorreios_(fileId,recibo,reconstruido){
  const ui=SpreadsheetApp.getUi();
  atualizarCabecalhosGerenciados_(SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.RETURNS),PPN.RETURN_HEADERS);
  atualizarCabecalhosGerenciados_(SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.VERIFIED),PPN.VERIFIED_HEADERS);
  const manifesto=dados_(PPN.SHEETS.VERIFIED); const v=indice_(manifesto.headers); const porLinha=new Map(); const porSequencial=new Map(); const porDocumento=new Map(); const porCodigo=new Map(); const porChave=new Map();
  let linhasManifesto=manifesto.rows.filter(r=>texto_(r[v.ARQUIVO_EXPORTADO])===recibo.arquivo);
  if(recibo.tipoExportacao==='OBJETO_REGISTRADO_JSON'&&!linhasManifesto.length){
    const arquivoRetorno=recibo.arquivo;
    const resolvido=resolverManifestoRetornoObjetoRegistrado_(recibo,manifesto,v);
    recibo.arquivoRetorno=arquivoRetorno;
    recibo.arquivo=resolvido.arquivo;
    recibo.loteHomologacao=resolvido.lote;
    recibo.criterioAssociacao=resolvido.criterio;
    linhasManifesto=resolvido.rows;
  }
  if(recibo.tipoExportacao==='OBJETO_REGISTRADO_JSON'&&!linhasManifesto.length)throw new Error(`Manifesto do objeto registrado não localizado para ${recibo.arquivo}. A associação não será inferida sem evidência.`);
  linhasManifesto.forEach(r=>{porLinha.set(Number(r[v.LINHA_ARQUIVO]),r);if(v.SEQUENCIAL!==undefined)porSequencial.set(texto_(r[v.SEQUENCIAL]),r);porDocumento.set(digitos_(r[v.CPF_CNPJ]),r);porCodigo.set(texto_(r[v.CODIGO]),r);if(v.CHAVE!==undefined)porChave.set(texto_(r[v.CHAVE]),r);});
  const retorno=dados_(PPN.SHEETS.RETURNS); const t=indice_(retorno.headers); const ids=new Set(retorno.rows.map(r=>texto_(r[t.ID_RETORNO]))); const agora=new Date(); const novas=[];
  recibo.erros.forEach(erro=>{
    const item=(erro.codigoDestinatario&&porCodigo.get(texto_(erro.codigoDestinatario)))||(erro.cpfCnpj&&porDocumento.get(digitos_(erro.cpfCnpj)))||(erro.chave&&porChave.get(texto_(erro.chave)))||(erro.sequencial&&porSequencial.get(texto_(erro.sequencial)))||porLinha.get(Number(erro.linha))||[]; const linha=Number(item[v.LINHA_ARQUIVO]||erro.linha||0); const sequencial=texto_(erro.sequencial||(v.SEQUENCIAL!==undefined?item[v.SEQUENCIAL]:''));
    const id=sha256Texto_(`${fileId}|${recibo.arquivo}|${linha}|${sequencial}|${erro.mensagem}`); if(ids.has(id))return;
    novas.push([id,recibo.arquivo,recibo.origem,linha,item[v.CODIGO]||'',item[v.NOME]||'',item[v.CPF_CNPJ]||erro.cpfCnpj||'',item[v.CEP]||erro.cep||'',erro.tipo,erro.codigo,erro.mensagem,'','','PENDENTE','','','',fileId,agora,recibo.tipoExportacao||'DESTINATARIOS_XLSX',sequencial]); ids.add(id);
  });
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.RETURNS); formatarColunasTextoAntes_(sh,sh.getLastRow()+1,novas.length,[1,2,3,4,5,7,8,10,12,13,18,20,21]); escreverEmBlocos_(sh,sh.getLastRow()+1,novas,250); configurarValidacoesOperacionais_();
  atualizarBaseEnvioVerificadaComRecibo_(recibo.arquivo,fileId,agora,recibo.erros);
  log_('IMPORTAR_RETORNO_CORREIOS',fileId,'',recibo.status,`${recibo.arquivo}; erros=${recibo.erros.length}; novos=${novas.length}; manifestoReconstruido=${reconstruido}`,'',1);
  ui.alert(`Retorno dos Correios importado.\n\nArquivo processado: ${recibo.arquivo}\nTipo: ${recibo.tipoExportacao||'DESTINATARIOS_XLSX'}\nStatus: ${recibo.status}\nMensagens de erro: ${recibo.erros.length}\nNovos itens para tratamento: ${novas.length}\n\nConsulte RETORNO_CORREIOS e BASE_ENVIO_VERIFICADA.${reconstruido?'\n\nA base do arquivo anterior foi reconstruída da aba de auditoria atual; confira se ela corresponde exatamente ao XLSX enviado.':''}`);
}

function resolverManifestoRetornoObjetoRegistrado_(recibo,manifesto,v){
  const nomeRetorno=texto_(recibo.arquivo);
  const origem=texto_(recibo.origem).toUpperCase();
  const loteMatch=nomeRetorno.match(/(?:^|[_\-\s])(LOTE\d+)(?:[_\-\s.]|$)/i);
  const lote=loteMatch?loteMatch[1].toUpperCase():'';
  const documentos=new Set((recibo.erros||[]).map(e=>digitos_(e.cpfCnpj)).filter(Boolean));
  if(lote){
    const fila=dados_(PPN.SHEETS.HOMOLOG_QUEUE); const q=indice_(fila.headers);
    const arquivos=[...new Set(fila.rows.filter(r=>texto_(r[q.ORIGEM]).toUpperCase()===origem&&texto_(r[q.LOTE_HOMOLOGACAO]).toUpperCase()===lote).map(r=>texto_(r[q.ARQUIVO_JSON])).filter(Boolean))];
    if(arquivos.length>1)throw new Error(`O ${lote} possui mais de um ARQUIVO_JSON na FILA_HOMOLOGACAO. Associação bloqueada.`);
    if(arquivos.length===1){
      const arquivo=arquivos[0];
      const rows=manifesto.rows.filter(r=>texto_(r[v.ARQUIVO_EXPORTADO])===arquivo&&texto_(r[v.ORIGEM]).toUpperCase()===origem&&(v.TIPO_EXPORTACAO===undefined||texto_(r[v.TIPO_EXPORTACAO])==='OBJETO_REGISTRADO_JSON'));
      if(!rows.length)throw new Error(`${lote} aponta para "${arquivo}", mas o manifesto não foi encontrado em BASE_ENVIO_VERIFICADA.`);
      const docsManifesto=new Set(rows.map(r=>digitos_(r[v.CPF_CNPJ])).filter(Boolean));
      const faltantes=[...documentos].filter(doc=>!docsManifesto.has(doc));
      if(faltantes.length)throw new Error(`${lote}: ${faltantes.length} documento(s) do retorno não pertencem ao manifesto identificado. Associação bloqueada.`);
      return{arquivo,rows,lote,criterio:'FILA_HOMOLOGACAO+DOCUMENTOS'};
    }
  }
  const grupos=new Map();
  manifesto.rows.forEach(r=>{
    if(texto_(r[v.ORIGEM]).toUpperCase()!==origem)return;
    if(v.TIPO_EXPORTACAO!==undefined&&texto_(r[v.TIPO_EXPORTACAO])!=='OBJETO_REGISTRADO_JSON')return;
    const arquivo=texto_(r[v.ARQUIVO_EXPORTADO]); if(!arquivo)return;
    if(!grupos.has(arquivo))grupos.set(arquivo,[]); grupos.get(arquivo).push(r);
  });
  const candidatos=[...grupos.entries()].filter(([,rows])=>documentos.size>0&&[...documentos].every(doc=>new Set(rows.map(r=>digitos_(r[v.CPF_CNPJ])).filter(Boolean)).has(doc)));
  if(candidatos.length!==1)throw new Error(`Não foi possível resolver unicamente o manifesto do retorno. Candidatos encontrados: ${candidatos.length}.`);
  return{arquivo:candidatos[0][0],rows:candidatos[0][1],lote:'',criterio:'DOCUMENTOS'};
}

function extrairIdDrive_(value){const m=texto_(value).match(/[-\w]{25,}/);return m?m[0]:'';}

function extrairTextoPdf_(file){
  let tempId='';
  try{
    const converted=Drive.Files.create({name:`__TMP_RECIBO_CORREIOS_${Date.now()}`,mimeType:MimeType.GOOGLE_DOCS},file.getBlob(),{fields:'id'}); tempId=converted.id;
    if(!tempId)throw new Error('Não foi possível converter o recibo PDF dos Correios.');
    let texto=''; let ultimoErro=null;
    for(let tentativa=1;tentativa<=3&&!texto;tentativa++){
      try{const exported=Drive.Files.export(tempId,'text/plain');texto=exported.getDataAsString('UTF-8').trim();}
      catch(e){ultimoErro=e;}
      if(!texto&&tentativa<3)Utilities.sleep(500*tentativa);
    }
    if(!texto)throw new Error(`O recibo foi convertido, mas nenhum texto pôde ser extraído.${ultimoErro?' '+texto_(ultimoErro.message):''}`);
    return texto;
  }finally{
    if(tempId)try{DriveApp.getFileById(tempId).setTrashed(true);}catch(e){log_('LIMPAR_TEMP_RECIBO',tempId,'','AVISO',texto_(e&&e.message),'',1);}
  }
}

function analisarReciboCorreios_(conteudo){
  const raw=String(conteudo||'').replace(/\r/g,'');
  const nome=(raw.match(/Nome\s+do\s+Arquivo\s*:\s*([^\n]+)/i)||[])[1];
  const status=(raw.match(/Status\s*:\s*([^\n]+)/i)||[])[1];
  if(!nome)throw new Error('O nome do XLSX processado não foi localizado no recibo.');
  const arquivo=texto_(nome); const origem=/EMPRESAS/i.test(arquivo)?'EMPRESA':/PROFISSIONAIS/i.test(arquivo)?'PROFISSIONAL':'';
  if(!origem)throw new Error(`Não foi possível identificar PF ou PJ no nome do arquivo: ${arquivo}`);
  const erros=[]; const rx=/Erro\s+na\s+linha\s+(\d+)\s*-\s*([\s\S]*?)(?=Erro\s+na\s+linha\s+\d+\s*-|$)/gi; let m;
  while((m=rx.exec(raw))!==null){
    const mensagem=texto_(m[2]); const codigo=(mensagem.match(/\b[A-Z]{2,}-\d+\b/i)||[])[0]||'';
    const tipo=classificarErroPpn_(codigo,mensagem);
    erros.push({linha:Number(m[1]),tipo,codigo:codigo.toUpperCase(),mensagem});
  }
  return{arquivo,origem,status:texto_(status||'STATUS_NAO_IDENTIFICADO').toUpperCase(),tipoExportacao:'DESTINATARIOS_XLSX',erros};
}

function classificarErroPpn_(codigo,mensagem){
  const c=texto_(codigo).toUpperCase();
  const m=texto_(mensagem);
  if(c==='PPN-050'||/comprimento.*envelope/i.test(m))return'REGRA_LAYOUT';
  if(c==='CEP-003'||c==='PZN-999'||/\bCEP\b/i.test(m))return'CEP_INVALIDO';
  if(/CPF\s*\/?\s*CNPJ/i.test(m))return'CPF_CNPJ_INVALIDO';
  if(/TELEFONE|CELULAR/i.test(m))return'CONTATO_INVALIDO';
  if(/DECLARA(?:ÇÃO|CAO)|CONTE[UÚ]DO/i.test(m))return'DECLARACAO_CONTEUDO';
  if(/FORMATO/i.test(m))return'FORMATO_OBJETO';
  return'OUTRO';
}

function analisarRetornoObjetoRegistrado_(conteudo,nomeArquivoRetorno){
  const raw=String(conteudo||'').replace(/^\uFEFF/,'').trim(); if(!raw)throw new Error('O arquivo de inconsistências está vazio.');
  let parsed=null; try{parsed=JSON.parse(raw);}catch(e){}
  const objetos=parsed===null?extrairObjetosJsonDoTexto_(raw):coletarObjetosRetorno_(parsed);
  if(!objetos.length)throw new Error('Nenhum objeto registrado foi localizado no retorno JSON/TXT.');
  const nomeDeclarado=valorRecursivoPorChaves_(parsed,['nomeArquivo','arquivo','arquivoProcessado','nomeDoArquivo']);
  const arquivo=normalizarNomeArquivoRetorno_(texto_(nomeDeclarado||nomeArquivoRetorno));
  const origem=/EMPRESAS/i.test(arquivo)?'EMPRESA':/PROFISSIONAIS/i.test(arquivo)?'PROFISSIONAL':'';
  if(!origem)throw new Error(`Não foi possível identificar PF ou PJ no nome do arquivo: ${arquivo}`);
  const erros=[];
  objetos.forEach((entrada,i)=>{
    const objeto=localizarPayloadRegistrado_(entrada); if(!objeto)return;
    const mensagens=extrairMensagensRetorno_(entrada); if(!mensagens.length)return;
    const sequencial=texto_(objeto.sequencial||objeto.numeroSequencial||objeto.idSequencial||'');
    const linha=Number(objeto.linhaArquivo||objeto.linha||objeto.numeroLinha||i+1);
    mensagens.forEach(mensagem=>{
      const codigo=(mensagem.match(/\b[A-Z]{2,}-\d+\b/i)||[])[0]||'';
      const tipo=classificarErroPpn_(codigo,mensagem);
      const campos=camposDestinatarioRetorno_(objeto);
      erros.push({linha,sequencial,chave:campos.chave,codigoDestinatario:campos.codigo,tipo,codigo:codigo.toUpperCase(),mensagem,cpfCnpj:campos.cpfCnpj,cep:campos.cep});
    });
  });
  if(!erros.length)throw new Error('O arquivo foi lido, mas nenhuma mensagem de inconsistência associada a objeto registrado foi localizada.');
  const status=(raw.match(/(\d+)\s+registros?\s+cont[eé]m\s+inconsist[eê]ncias/i)||[])[1];
  const quantidade=status||String(erros.length);
  return{arquivo,origem,status:`PROCESSADO_COM_${quantidade}_INCONSISTENCIAS`,tipoExportacao:'OBJETO_REGISTRADO_JSON',erros};
}

function chaveRetornoManifesto_(arquivo,origem,codigo){
  return [texto_(arquivo),texto_(origem).toUpperCase(),texto_(codigo)].join('|');
}

function adicionarIndiceManifestoRetorno_(mapa,chave,row){
  if(!chave)return;
  const lista=mapa.get(chave)||[];
  lista.push(row);
  mapa.set(chave,lista);
}

function indexarManifestoRetorno_(rows,v){
  const indice={porCodigo:new Map(),porDocumento:new Map(),porChave:new Map(),porSequencial:new Map(),porLinha:new Map()};
  rows.forEach(row=>{
    adicionarIndiceManifestoRetorno_(indice.porCodigo,texto_(row[v.CODIGO]),row);
    adicionarIndiceManifestoRetorno_(indice.porDocumento,digitos_(row[v.CPF_CNPJ]),row);
    if(v.CHAVE!==undefined)adicionarIndiceManifestoRetorno_(indice.porChave,texto_(row[v.CHAVE]),row);
    if(v.SEQUENCIAL!==undefined)adicionarIndiceManifestoRetorno_(indice.porSequencial,texto_(row[v.SEQUENCIAL]),row);
    adicionarIndiceManifestoRetorno_(indice.porLinha,String(Number(row[v.LINHA_ARQUIVO])),row);
  });
  return indice;
}

function indiceRetornoDireto_(){
  return indice_(PPN.RETURN_HEADERS);
}

function alvoRetornoManifesto_(item,t){
  return {
    codigo:texto_(item.codigoDestinatario!==undefined?item.codigoDestinatario:item[t.CODIGO]),
    documento:digitos_(item.cpfCnpj!==undefined?item.cpfCnpj:item[t.CPF_CNPJ]),
    chave:t.CHAVE!==undefined?texto_(item.chave!==undefined?item.chave:item[t.CHAVE]):'',
    sequencial:t.SEQUENCIAL!==undefined?texto_(item.sequencial!==undefined?item.sequencial:item[t.SEQUENCIAL]):'',
    linha:Number(item.linha!==undefined?item.linha:item[t.LINHA_ARQUIVO])
  };
}

function resolverLinhaManifestoRetorno_(item,indice,t){
  const alvo=alvoRetornoManifesto_(item,t);
  const candidatos=[
    alvo.codigo?indice.porCodigo.get(alvo.codigo):null,
    alvo.documento?indice.porDocumento.get(alvo.documento):null,
    alvo.chave?indice.porChave.get(alvo.chave):null,
    alvo.sequencial?indice.porSequencial.get(alvo.sequencial):null,
    Number.isFinite(alvo.linha)&&alvo.linha>0?indice.porLinha.get(String(alvo.linha)):null
  ];
  const lista=candidatos.find(value=>value&&value.length);
  if(!lista)return null;
  if(lista.length>1)throw new Error(`Retorno ambíguo para o registro ${alvo.codigo||alvo.documento||alvo.sequencial||alvo.linha}.`);
  return lista[0];
}

function agruparRetornosPorManifesto_(manifestoRows,retornoRows,v,t){
  const indice=indexarManifestoRetorno_(manifestoRows,v); const porManifesto=new Map();
  retornoRows.forEach((retorno,index)=>{
    const row=resolverLinhaManifestoRetorno_(retorno,indice,t);
    if(!row)throw new Error(`Retorno não vinculado ao manifesto: código ${texto_(retorno[t.CODIGO])}, CPF/CNPJ ${texto_(retorno[t.CPF_CNPJ])}, linha ${texto_(retorno[t.LINHA_ARQUIVO])}.`);
    const lista=porManifesto.get(row)||[]; lista.push({retorno,index}); porManifesto.set(row,lista);
  });
  return porManifesto;
}

function coletarObjetosRetorno_(value,out){
  out=out||[];
  if(Array.isArray(value)){value.forEach(v=>coletarObjetosRetorno_(v,out));return out;}
  if(!value||typeof value!=='object')return out;
  if(localizarPayloadRegistrado_(value)&&extrairMensagensRetorno_(value).length)out.push(value);
  Object.keys(value).forEach(k=>{const v=value[k];if(v&&typeof v==='object')coletarObjetosRetorno_(v,out);});
  return [...new Set(out)];
}

function ehObjetoRetornoRegistrado_(obj){
  if(!obj||typeof obj!=='object')return false;
  const destinatario=obj.destinatario;
  if(destinatario&&typeof destinatario==='object'&&(destinatario.cpfCnpj||destinatario.endereco))return true;
  return Boolean(obj.destinatarioCpfCnpj||obj.destinatarioEnderecoCep||obj.destinatarioCep||obj.destinatarioNome||obj.cpfCnpjDestinatario);
}

function localizarPayloadRegistrado_(entrada){
  if(!entrada||typeof entrada!=='object')return null;
  const candidatos=[entrada.objeto,entrada.registro,entrada.prePostagem,entrada.prepostagem,entrada.item,entrada.payload,entrada.dados,entrada];
  return candidatos.find(ehObjetoRetornoRegistrado_)||null;
}

function extrairMensagensRetorno_(entrada){
  const out=[]; const visitar=(value,key)=>{
    if(value===null||value===undefined)return;
    if(typeof value==='string'&&/(mensagem|message|erro|error|inconsist|descricao|detail)/i.test(key||'')){const t=texto_(value);if(t)out.push(t);return;}
    if(Array.isArray(value)){value.forEach(v=>visitar(v,key));return;}
    if(typeof value==='object')Object.keys(value).forEach(k=>visitar(value[k],k));
  }; visitar(entrada,''); return [...new Set(out)];
}

function extrairObjetosJsonDoTexto_(raw){
  const encontrados=[]; let inicio=-1,nivel=0,emString=false,escape=false;
  for(let i=0;i<raw.length;i++){
    const ch=raw[i];
    if(emString){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')emString=false;continue;}
    if(ch==='"'){emString=true;continue;}
    if(ch==='{'){if(nivel===0)inicio=i;nivel++;}
    else if(ch==='}'&&nivel>0){nivel--;if(nivel===0&&inicio>=0){try{const objeto=JSON.parse(raw.slice(inicio,i+1));if(ehObjetoRetornoRegistrado_(objeto))encontrados.push({objeto,inicio,fim:i});}catch(e){}inicio=-1;}}
  }
  return encontrados.map((item,i)=>{const fimProximo=i+1<encontrados.length?encontrados[i+1].inicio:raw.length;const mensagem=texto_(raw.slice(item.fim+1,fimProximo));return mensagem?{objeto:item.objeto,mensagem}:item.objeto;});
}

function camposDestinatarioRetorno_(objeto){
  const destinatario=objeto&&objeto.destinatario&&typeof objeto.destinatario==='object'?objeto.destinatario:{};
  const endereco=destinatario.endereco&&typeof destinatario.endereco==='object'?destinatario.endereco:{};
  return {
    codigo:texto_(objeto.codigo||objeto.codigoDestinatario||objeto.destinatarioCodigo||objeto.codigoCliente||''),
    chave:texto_(objeto.chave||objeto.chaveRegistro||objeto.chaveDestinatario||''),
    cpfCnpj:digitos_(destinatario.cpfCnpj||objeto.destinatarioCpfCnpj||objeto.cpfCnpjDestinatario||''),
    cep:digitos_(endereco.cep||objeto.destinatarioEnderecoCep||objeto.destinatarioCep||objeto.cepDestinatario||'')
  };
}

function valorRecursivoPorChaves_(value,keys){
  if(!value||typeof value!=='object')return''; const wanted=new Set(keys.map(k=>normalizarCabecalho_(k)));
  for(const key of Object.keys(value))if(wanted.has(normalizarCabecalho_(key))&&typeof value[key]!=='object')return value[key];
  for(const key of Object.keys(value)){const found=valorRecursivoPorChaves_(value[key],keys);if(found)return found;}
  return'';
}

function normalizarNomeArquivoRetorno_(nome){return texto_(nome).replace(/\s*\(\d+\)(?=\.(?:json|xlsx)$)/i,'');}

function garantirManifestoParaRecibo_(arquivo,origem){
  const verificado=dados_(PPN.SHEETS.VERIFIED); const v=indice_(verificado.headers);
  if(verificado.rows.some(r=>texto_(r[v.ARQUIVO_EXPORTADO])===arquivo))return false;
  const sheetName=origem==='EMPRESA'?PPN.SHEETS.EXPORT_DEST_PJ:PPN.SHEETS.EXPORT_DEST_PF; const auditoria=dados_(sheetName); const a=indice_(auditoria.headers);
  if(!auditoria.rows.length)throw new Error(`Não existe manifesto para ${arquivo} e a aba ${sheetName} está vazia. Não é seguro associar as linhas do recibo.`);
  const resultado={fileName:arquivo}; const rows=auditoria.rows.map(r=>[
    r[a.CARTAO_POSTAGEM],r[a['MALOTE (S OU N)']],r[a.CODIGO],r[a.NOME],r[a.EMAIL],r[a['CPF/CNPJ']],r[a.TELEFONE],r[a.CELULAR],r[a.CEP],r[a.LOGRADOURO],r[a.NUMERO],r[a.COMPLEMENTO],r[a.BAIRRO],r[a.CIDADE],r[a.UF]
  ]);
  registrarBaseEnvioDestinatarios_(resultado,origem,rows,'RECONSTRUIDO_AUDITORIA'); return true;
}

function atualizarBaseEnvioVerificadaComRecibo_(arquivo,reciboId,quando,erros){
  const data=dados_(PPN.SHEETS.VERIFIED); const v=indice_(data.headers); const manifestoRows=data.rows.filter(row=>texto_(row[v.ARQUIVO_EXPORTADO])===arquivo); const indice=indexarManifestoRetorno_(manifestoRows,v); const porManifesto=new Map();
  erros.forEach((erro,index)=>{const row=resolverLinhaManifestoRetorno_(erro,indice,indiceRetornoDireto_());if(!row)throw new Error(`Retorno não vinculado ao manifesto ${arquivo}: código ${texto_(erro.codigoDestinatario)}, CPF/CNPJ ${texto_(erro.cpfCnpj)}, sequencial ${texto_(erro.sequencial)}.`);const lista=porManifesto.get(row)||[];lista.push({erro,index});porManifesto.set(row,lista);});
  if(!manifestoRows.length)throw new Error(`Manifesto vazio para ${arquivo}; reconciliação bloqueada.`);
  data.rows.forEach(row=>{
    if(texto_(row[v.ARQUIVO_EXPORTADO])!==arquivo)return;
    const itens=(porManifesto.get(row)||[]).map(item=>item.erro);
    const mensagens=itens.map(e=>texto_(e.mensagem));
    const temCep=itens.some(e=>e.tipo==='CEP_INVALIDO');
    const temLayout=itens.some(e=>e.tipo==='REGRA_LAYOUT');
    row[v.STATUS_CORREIOS]=temCep?'REJEITADO_CEP':temLayout?'REJEITADO_LAYOUT':itens.length?'REJEITADO_CORREIOS':'SEM_ERRO_REPORTADO'; row[v.MOTIVO_CORREIOS]=mensagens.join(' | '); row[v.RECIBO_ID]=reciboId; row[v.RETORNO_EM]=quando;
  });
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.VERIFIED); if(data.rows.length){formatarColunasTextoAntes_(sh,data.headerRow+1,data.rows.length,[1,2,3,4,5,6,7,8,15,16,17,18]);sh.getRange(data.headerRow+1,1,data.rows.length,PPN.VERIFIED_HEADERS.length).setValues(data.rows.map(r=>r.slice(0,PPN.VERIFIED_HEADERS.length)));}
  marcarBasePorRetornoCorreios_(arquivo,erros); sincronizarFilaHomologacao_();
}

function marcarBasePorRetornoCorreios_(arquivo,erros){
  const verified=dados_(PPN.SHEETS.VERIFIED); const v=indice_(verified.headers);
  const base=dados_(PPN.SHEETS.BASE); const b=indice_(base.headers);
  const manifestoRows=verified.rows.filter(r=>texto_(r[v.ARQUIVO_EXPORTADO])===arquivo); const indice=indexarManifestoRetorno_(manifestoRows,v);
  const porChave=new Map(base.rows.map((r,i)=>[`${texto_(r[b.ORIGEM]).toUpperCase()}|${texto_(r[b.CHAVE])}`,i]));
  erros.filter(e=>e.tipo==='CEP_INVALIDO').forEach(e=>{
    const item=resolverLinhaManifestoRetorno_(e,indice,indiceRetornoDireto_());
    if(!item)throw new Error(`Retorno de CEP não vinculado ao manifesto ${arquivo}: CPF/CNPJ ${texto_(e.cpfCnpj)}, código ${texto_(e.codigoDestinatario)}.`);
    const chave=`${texto_(item[v.ORIGEM]).toUpperCase()}|${texto_(item[v.CHAVE])}`; const i=porChave.get(chave);
    if(i===undefined)throw new Error(`Manifesto ${arquivo} aponta para uma CHAVE ausente na BASE_NORMALIZADA: ${chave}.`);
    base.rows[i][b.STATUS_CEP_CORREIOS]='ERRO_CEP_PPN';
    base.rows[i][b.MOTIVO_BLOQUEIO]=`CEP rejeitado pelos Correios: ${texto_(e.codigo)} ${texto_(e.mensagem)}`.trim();
    base.rows[i][b.STATUS_EXPORTACAO]='PENDENTE_CEP';
  });
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.BASE);
  if(base.rows.length){formatarColunasTextoAntes_(sh,base.headerRow+1,base.rows.length,[1,2,3,5,6,7,12,13,15,29]);sh.getRange(base.headerRow+1,1,base.rows.length,PPN.BASE_HEADERS.length).setValues(base.rows.map(r=>r.slice(0,PPN.BASE_HEADERS.length)));}
  atualizarFilaExcecoes();
}

function atualizarBaseEnvioVerificada(){
  const data=dados_(PPN.SHEETS.VERIFIED); const v=indice_(data.headers); const retorno=dados_(PPN.SHEETS.RETURNS); const t=indice_(retorno.headers); const porArquivo=new Map();
  retorno.rows.forEach(r=>{const arquivo=texto_(r[t.ARQUIVO_EXPORTADO]);const lista=porArquivo.get(arquivo)||[];lista.push(r);porArquivo.set(arquivo,lista);});
  porArquivo.forEach((retornos,arquivo)=>{
    const manifestoRows=data.rows.filter(r=>texto_(r[v.ARQUIVO_EXPORTADO])===arquivo); if(!manifestoRows.length)throw new Error(`Retorno registrado para ${arquivo}, mas o manifesto não existe em BASE_ENVIO_VERIFICADA.`);
    const agrupados=agruparRetornosPorManifesto_(manifestoRows,retornos,v,t);
    manifestoRows.forEach(row=>{
      const itens=(agrupados.get(row)||[]).map(item=>item.retorno);
      if(itens.length){const resolvidos=itens.every(r=>texto_(r[t.DECISAO]).toUpperCase()==='APLICADO');const tipos=itens.map(r=>texto_(r[t.TIPO_ERRO]).toUpperCase());const status=tipos.includes('CEP_INVALIDO')?'REJEITADO_CEP':tipos.includes('REGRA_LAYOUT')?'REJEITADO_LAYOUT':'REJEITADO_CORREIOS';row[v.STATUS_CORREIOS]=resolvidos?'CORRIGIDO_PENDENTE_REENVIO':status;row[v.MOTIVO_CORREIOS]=itens.map(r=>texto_(r[t.MENSAGEM])).join(' | ');row[v.RECIBO_ID]=itens[0][t.RECIBO_ID]||row[v.RECIBO_ID];row[v.RETORNO_EM]=itens[0][t.IMPORTADO_EM]||row[v.RETORNO_EM];}
      else{row[v.STATUS_CORREIOS]='SEM_ERRO_REPORTADO';row[v.MOTIVO_CORREIOS]='';}
    });
  });
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.VERIFIED); if(data.rows.length){formatarColunasTextoAntes_(sh,data.headerRow+1,data.rows.length,[1,2,3,4,5,6,7,8,15,16,17,18]);sh.getRange(data.headerRow+1,1,data.rows.length,PPN.VERIFIED_HEADERS.length).setValues(data.rows.map(r=>r.slice(0,PPN.VERIFIED_HEADERS.length)));}
  sincronizarFilaHomologacao_(); SpreadsheetApp.getUi().alert('BASE_ENVIO_VERIFICADA atualizada com os tratamentos registrados em RETORNO_CORREIOS.');
}

function aplicarTratamentosRetornoCorreios(){
  const retorno=dados_(PPN.SHEETS.RETURNS); const t=indice_(retorno.headers); const aprovados=retorno.rows.filter(r=>texto_(r[t.DECISAO]).toUpperCase()==='APROVADO');
  if(!aprovados.length)throw new Error('Nenhum tratamento está marcado como APROVADO em RETORNO_CORREIOS.');
  const base=dados_(PPN.SHEETS.BASE); const b=indice_(base.headers); const porChave=new Map(base.rows.map((r,i)=>[`${texto_(r[b.ORIGEM]).toUpperCase()}|${texto_(r[b.CODIGO])}`,i])); const erros=[];
  aprovados.forEach(r=>{
    const origem=texto_(r[t.ORIGEM]).toUpperCase(); const codigo=texto_(r[t.CODIGO]); const tipo=texto_(r[t.TIPO_ERRO]).toUpperCase(); const doc=digitos_(r[t.CPF_CNPJ_CORRIGIDO]); const cep=digitos_(r[t.CEP_CORRIGIDO]);
    if(!porChave.has(`${origem}|${codigo}`))erros.push(`${codigo}: registro não localizado na base`);
    if(!['CPF_CNPJ_INVALIDO','CEP_INVALIDO'].includes(tipo))erros.push(`${codigo}: ${tipo} exige ajuste da configuração/exportador e nova geração; não pode ser aplicado automaticamente na base`);
    if(tipo==='CPF_CNPJ_INVALIDO'&&!doc)erros.push(`${codigo}: informe CPF_CNPJ_CORRIGIDO`);
    if(doc&&!((origem==='PROFISSIONAL'&&doc.length===11&&cpfValido_(doc))||(origem==='EMPRESA'&&doc.length===14&&cnpjValido_(doc))))erros.push(`${codigo}: documento corrigido não é válido para ${origem}`);
    if(tipo==='CEP_INVALIDO'&&cep.length!==8)erros.push(`${codigo}: informe CEP_CORRIGIDO com 8 dígitos`);
  });
  if(erros.length)throw new Error('Tratamentos não aplicados:\n- '+erros.join('\n- '));
  checkpoint_('ANTES_TRATAMENTO_RETORNO_CORREIOS'); const agora=new Date(); const executor=Session.getActiveUser().getEmail();
  aprovados.forEach(r=>{
    const origem=texto_(r[t.ORIGEM]).toUpperCase(); const codigo=texto_(r[t.CODIGO]); const row=base.rows[porChave.get(`${origem}|${codigo}`)]; const doc=digitos_(r[t.CPF_CNPJ_CORRIGIDO]); const cep=digitos_(r[t.CEP_CORRIGIDO]);
    if(doc){row[b.CPF_CNPJ]=doc;row[b.DOCUMENTO_STATUS]='OK';}
    if(cep){row[b.CEP_ORIGINAL]=cep;row[b.CEP_FORMATO]='OK';limparValidacaoCepLinha_(row,b);}
    r[t.DECISAO]='APLICADO'; if(!texto_(r[t.RESPONSAVEL]))r[t.RESPONSAVEL]=executor; r[t.DATA_DECISAO]=agora;
  });
  const baseSh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.BASE); formatarColunasTextoAntes_(baseSh,base.headerRow+1,base.rows.length,[1,2,3,5,6,7,12,13,15,29]); baseSh.getRange(base.headerRow+1,1,base.rows.length,PPN.BASE_HEADERS.length).setValues(base.rows.map(r=>r.slice(0,PPN.BASE_HEADERS.length)));
  const retSh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.RETURNS); formatarColunasTextoAntes_(retSh,retorno.headerRow+1,retorno.rows.length,[1,2,3,4,5,7,8,10,12,13,18,20,21]); retSh.getRange(retorno.headerRow+1,1,retorno.rows.length,PPN.RETURN_HEADERS.length).setValues(retorno.rows.map(r=>r.slice(0,PPN.RETURN_HEADERS.length)));
  higienizarCacheAposImportacao_(base.rows); aplicarCacheNaBase_(); atualizarFilaExcecoes(); atualizarPreviaDestinatarios_(); atualizarBaseEnvioVerificada();
  log_('APLICAR_TRATAMENTO_RETORNO','', '', 'SUCESSO',`tratamentos=${aprovados.length}`,'',1);
}

function configurarValidacoesOperacionais_(){
  const ss=SpreadsheetApp.getActive(); const exc=ss.getSheetByName(PPN.SHEETS.EXC); if(exc&&exc.getMaxRows()>1)exc.getRange(2,17,exc.getMaxRows()-1,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['PENDENTE','APROVADO','BLOQUEADO'],true).build());
  const ret=ss.getSheetByName(PPN.SHEETS.RETURNS); if(ret&&ret.getMaxRows()>1)ret.getRange(2,14,ret.getMaxRows()-1,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['PENDENTE','APROVADO','APLICADO','DESCARTADO'],true).build());
  const cfg=ss.getSheetByName(PPN.SHEETS.CONFIG); if(cfg){const data=dados_(PPN.SHEETS.CONFIG);const c=indice_(data.headers);data.rows.forEach((r,i)=>{const key=normalizarCabecalho_(r[c.PARAMETRO]);const cell=cfg.getRange(data.headerRow+i+1,c.VALOR+1);if(key==='OBJ_REG_FORMATO')cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['1','2','3'],true).setAllowInvalid(false).build());if(key==='OBJ_REG_MODO_LOTE')cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['CONTROLADO','COMPLETO'],true).setAllowInvalid(false).build());if(['OBJ_REG_USAR_AR','OBJ_REG_LOGISTICA_REVERSA','OBJ_REG_LAYOUT_HOMOLOGADO'].includes(key))cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['SIM','NAO'],true).setAllowInvalid(false).build());});}
}

function sha256Texto_(value){return sha256_(Utilities.newBlob(String(value),'text/plain').getBytes());}

function gerarXlsxObjetoSimples() {
  return gerarXlsxObjetoSimplesPorOrigem_('');
}

function gerarXlsxObjetoSimplesPf(){
  return gerarXlsxObjetoSimplesPorOrigem_('PROFISSIONAL');
}

function gerarXlsxObjetoSimplesPj(){
  return gerarXlsxObjetoSimplesPorOrigem_('EMPRESA');
}

function gerarXlsxObjetoSimplesPorOrigem_(origemAlvo){
  origemAlvo=validarOrigemAlvo_(origemAlvo);
  validarConfig_(['CODIGO_SERVICO','PESO_GRAMAS','DATA_PREVISTA_POSTAGEM','REMETENTE_NOME','REMETENTE_CEP','REMETENTE_LOGRADOURO','REMETENTE_NUMERO','REMETENTE_BAIRRO','REMETENTE_CIDADE','REMETENTE_UF','REMETENTE_CPF_CNPJ']);
  const dataPostagem=validarConfigObjetoSimples_();
  aplicarCacheNaBase_();
  const data=dados_(PPN.SHEETS.BASE); const b=indice_(data.headers);
  const elegiveis=data.rows.filter(r=>origemCorresponde_(r,b,origemAlvo)&&r[b.STATUS_EXPORTACAO]==='APTO');
  if(!elegiveis.length)throw new Error(`Nenhum registro ${rotuloOrigem_(origemAlvo)} está APTO para objeto simples.`);
  const grupos=[
    {origem:'PROFISSIONAL',sheet:PPN.SHEETS.EXPORT_SIMPLE_PF,sufixo:'PROFISSIONAIS'},
    {origem:'EMPRESA',sheet:PPN.SHEETS.EXPORT_SIMPLE_PJ,sufixo:'EMPRESAS'},
  ].filter(grupo=>!origemAlvo||grupo.origem===origemAlvo).map(grupo=>{
    let seq=0;
    const rows=elegiveis
      .filter(r=>texto_(r[b.ORIGEM]).toUpperCase()===grupo.origem)
      .map(r=>linhaObjetoSimples_(r,b,++seq,dataPostagem));
    gravarExportacaoPadrao_(grupo.sheet,PPN.SIMPLE_HEADERS,rows,250);
    return{...grupo,rows};
  });
  const comDados=grupos.filter(grupo=>grupo.rows.length);
  checkpoint_('ANTES_EXPORT_OBJ_SIMPLES');
  const stamp=carimbo_(); const prefix=ambiente_()==='HOMOLOG'?'HOMOLOG_PPN':'PPN';
  const resultados=comDados.map(grupo=>criarArquivoXlsx_(grupo.sheet,`${prefix}_OBJETO_SIMPLES_${grupo.sufixo}_${stamp}.xlsx`,PPN_FILES.TEMPLATE_SIMPLE,PPN.SIMPLE_HEADERS,grupo.rows));
  const linhas=resultados.map(r=>`${r.fileName}: ${r.rows} registros\nSHA-256: ${r.hash}`);
  log_('EXPORTAR_OBJ_SIMPLES','', '', 'SUCESSO',`${rotuloOrigem_(origemAlvo)}; ${resultados.map(r=>`${r.fileName}=${r.rows}`).join('; ')}`,'',1);
  SpreadsheetApp.getUi().alert(`Objetos simples ${rotuloOrigem_(origemAlvo)} gerados com sucesso.\n\n${linhas.join('\n\n')}`);
  return resultados.map(r=>r.fileId);
}

function linhaObjetoSimples_(r,b,sequencial,dataPostagem){
  const phone=digitos_(r[b.TELEFONE]||r[b.CELULAR]); const senderPhone=digitos_(config_('REMETENTE_TELEFONE'));
  const tamanhoDocumento=texto_(r[b.ORIGEM]).toUpperCase()==='EMPRESA'?14:11;
  return [sequencial,digitos_(config_('CODIGO_SERVICO')),digitos_(config_('SERVICO_ADICIONAL_1')),digitos_(config_('SERVICO_ADICIONAL_2')),digitos_(config_('SERVICO_ADICIONAL_3')),digitos_(config_('SERVICO_ADICIONAL_4')),digitos_(config_('SERVICO_ADICIONAL_5')),config_('VALOR_DECLARADO'),Number(config_('PESO_GRAMAS')),config_('REMETENTE_NOME'),identificadorSeguro_(config_('REMETENTE_CEP'),8),config_('REMETENTE_LOGRADOURO'),config_('REMETENTE_NUMERO'),config_('REMETENTE_COMPLEMENTO'),config_('REMETENTE_BAIRRO'),config_('REMETENTE_CIDADE'),String(config_('REMETENTE_UF')).toUpperCase(),identificadorSeguro_(config_('REMETENTE_CPF_CNPJ'),digitos_(config_('REMETENTE_CPF_CNPJ')).length<=11?11:14),senderPhone.slice(0,2),senderPhone.slice(2),config_('REMETENTE_EMAIL'),r[b.NOME],identificadorSeguro_(r[b.CEP_ORIGINAL],8),r[b.LOGRADOURO_APROVADO]||r[b.LOGRADOURO_CORREIOS]||r[b.LOGRADOURO_PARSER],r[b.NUMERO_APROVADO]||r[b.NUMERO_PARSER],r[b.COMPLEMENTO_APROVADO]||r[b.COMPLEMENTO_PARSER],r[b.BAIRRO_APROVADO]||r[b.BAIRRO_CORREIOS]||r[b.BAIRRO_PARSER],r[b.CIDADE_APROVADA]||r[b.CIDADE_CORREIOS]||r[b.CIDADE_PARSER],String(r[b.UF_APROVADA]||r[b.UF_CORREIOS]||r[b.UF_PARSER]).toUpperCase(),identificadorSeguro_(r[b.CPF_CNPJ],tamanhoDocumento),phone.slice(0,2),phone.slice(2),r[b.EMAIL_STATUS]==='OK'?r[b.EMAIL]:'',dataPostagem];
}

function gravarExportacaoPadrao_(sheetName,headers,rows,blockSize){
  validarMatrizExportacao_(headers,rows,sheetName);
  const sh=SpreadsheetApp.getActive().getSheetByName(sheetName);
  prepararAbaDados_(sh,headers);
  formatarMatrizComoTextoAntes_(sh,2,rows.length,headers.length);
  escreverEmBlocos_(sh,2,rows,blockSize||250);
  if(rows.length)for(let col=1;col<=headers.length;col++)sh.getRange(2,col,rows.length,1).setNumberFormat('@');
  const actual=sh.getRange(1,1,1,headers.length).getDisplayValues()[0];
  const mismatch=headers.findIndex((header,i)=>actual[i]!==header);
  if(mismatch>=0)throw new Error(`Aba ${sheetName} fora do padrão na coluna ${mismatch+1}: esperado ${headers[mismatch]}, recebido ${actual[mismatch]}.`);
  sh.getRange(1,1,1,headers.length).setBackground('#0F5D50').setFontColor('#FFFFFF').setFontWeight('bold').setWrap(true);
  sh.setFrozenRows(1);
}

function gerarXlsxObjetosRegistrados() {
  return gerarXlsxObjetosRegistradosPorOrigem_('',{});
}

function gerarXlsxObjetosRegistradosPf(){
  return gerarXlsxObjetosRegistradosPorOrigem_('PROFISSIONAL',{});
}

function gerarXlsxObjetosRegistradosPj(){
  return gerarXlsxObjetosRegistradosPorOrigem_('EMPRESA',{});
}

function prepararReensaioEnvelopePj20(){
  if(ambiente_()!=='HOMOLOG')throw new Error('O perfil ouro de 20 empresas só pode ser preparado em AMBIENTE=HOMOLOG.');
  const ui=SpreadsheetApp.getUi();
  const resposta=ui.alert(
    'Preparar reensaio envelope sem dimensões — mesmos 20',
    'Esta ação localizará o último JSON V1.7.6 com marcador PPN050_CORRIGIDO, criará um checkpoint e reaplicará o perfil ouro com as quatro dimensões do envelope vazias.\n\nAs mesmas 20 chaves continuarão fixadas e os retornos por registro serão preservados. Deseja continuar?',
    ui.ButtonSet.YES_NO
  );
  if(resposta!==ui.Button.YES)return false;
  const arquivoAnterior=localizarUltimoArquivoManifestoPorMarcador_('EMPRESA',PPN_SCHEMA_RETEST.PREVIOUS_MARKER,20);
  const chavesAnteriores=chavesManifestoReferencia_(arquivoAnterior,'EMPRESA',20);
  const chavesV171=chavesManifestoReferencia_(PPN_SCHEMA_RETEST.V171_FILE,'EMPRESA',20);
  if(chavesAnteriores.some((chave,i)=>chave!==chavesV171[i]))throw new Error('Reensaio bloqueado: o último lote V1.7.5 não contém as mesmas 20 chaves, na mesma ordem, da referência V1.7.1. Nenhum manifesto foi alterado.');
  checkpoint_('ANTES_REENSAIO_PPN050_PJ20');
  const perfil=perfilEnsaioOuroPj20_();
  atualizarValoresConfig_(perfil);
  const cfg=validarConfigObjetoRegistrado_();
  validarPerfilOuroPj20_(cfg);
  const chaves=chavesManifestoReferencia_(cfg.arquivoReferencia,'EMPRESA',20);
  log_('PREPARAR_REENSAIO_ENVELOPE_PJ20',arquivoAnterior,'', 'SUCESSO',`manifestoPreservado=${arquivoAnterior}; chaves=${chaves.length}; perfil ouro preservado; patch=OMITIR_DIMENSOES_ENVELOPE_V177; retornosPorRegistroPreservados=SIM`,'',1);
  ui.alert(
    'Reensaio envelope sem dimensões preparado com sucesso.\n\n'+
    `O manifesto ${arquivoAnterior} foi preservado com os retornos individuais já importados.\n`+
    `${chaves.length} chaves foram fixadas para reutilização, na mesma ordem dos sequenciais anteriores.\n\n`+
    'Altura, largura, comprimento e diâmetro serão omitidos quando o formato for ENVELOPE (1). O peso 10 permanece.\n\n'+
    'Agora execute PJ — Empresas > 2. Gerar registrado — envelope sem dimensões.'
  );
  return true;
}

function prepararReensaioQuantidadePj20(){
  return prepararReensaioEnvelopePj20();
}

function prepararReensaioTipoPj20(){
  return prepararReensaioEnvelopePj20();
}

function prepararReensaioValorPj20(){
  return prepararReensaioEnvelopePj20();
}

function prepararReensaioSchemaPj20(){
  return prepararReensaioEnvelopePj20();
}

function prepararPerfilOuroPj20(){
  return prepararReensaioEnvelopePj20();
}

function perfilEnsaioOuroPj20_(){
  return{
    AMBIENTE:'HOMOLOG',
    OBJ_REG_MODO_LOTE:'CONTROLADO',
    OBJ_REG_LIMITE_LOTE:'20',
    OBJ_REG_ARQUIVO_REFERENCIA:PPN_SCHEMA_RETEST.V171_FILE,
    OBJ_REG_CODIGO_SERVICO:'03220',
    PESO_GRAMAS:'10',
    OBJ_REG_USAR_AR:'SIM',
    OBJ_REG_CODIGO_AR:'001',
    OBJ_REG_ADICIONAL_2:'025',
    OBJ_REG_ADICIONAL_3:'',
    OBJ_REG_FORMATO:'1',
    OBJ_REG_ALTURA:'',
    OBJ_REG_LARGURA:'',
    OBJ_REG_COMPRIMENTO:'',
    OBJ_REG_DIAMETRO:'',
    OBJ_REG_LOGISTICA_REVERSA:'NAO',
    OBJ_REG_DATA_PREVISTA_POSTAGEM:'',
    OBJ_REG_PRAZO_POSTAGEM:'30/09/2026',
    OBJ_REG_DATA_VALIDADE_LOG_REVERSA:'',
    OBJ_REG_CODIGO_VALOR_DECLARADO:'',
    OBJ_REG_VALOR_DECLARADO:'',
    OBJ_REG_CODIGO_ENTREGA_VIZINHO:'',
    OBJ_REG_ORIENTACAO_ENTREGA_VIZINHO:'',
    OBJ_REG_CONTEUDO_1:'DOCUMENTO',
    OBJ_REG_CONTEUDO_QTD_1:'1',
    OBJ_REG_CONTEUDO_VALOR_1:'20',
    REMETENTE_TELEFONE:'7139011600',
    REMETENTE_CELULAR:'',
    REMETENTE_EMAIL:'postagem.correios@crtba.org.br',
    OBJ_REG_LAYOUT_HOMOLOGADO:'NAO'
  };
}

function validarPerfilOuroPj20_(cfg){
  const adicionais=[cfg.codigoAr,cfg.codigoAdicional2,cfg.codigoAdicional3].filter(Boolean).join(',');
  const correto=cfg.ambiente==='HOMOLOG'&&cfg.modoLote==='CONTROLADO'&&cfg.limiteLote===20&&cfg.arquivoReferencia===PPN_SCHEMA_RETEST.V171_FILE&&cfg.codigoServico==='03220'&&cfg.formato==='1'&&!cfg.altura&&!cfg.largura&&!cfg.comprimento&&!cfg.diametro&&cfg.peso==='10'&&cfg.usarAr&&adicionais==='001,025'&&cfg.logisticaReversa==='N'&&!cfg.dataPrevistaPostagem&&!cfg.dataValidadeLogReversa&&!cfg.codigoValorDeclarado&&!cfg.valorDeclarado&&!cfg.codigoEntregaVizinho&&!cfg.orientacaoEntregaVizinho&&cfg.conteudo1==='DOCUMENTO'&&cfg.conteudoQuantidade1==='1'&&cfg.conteudoValor1==='20'&&cfg.prazoPostagem==='30/09/2026'&&texto_(cfg.remetenteTelefone)==='7139011600'&&!texto_(cfg.remetenteCelular)&&cfg.remetenteEmail==='postagem.correios@crtba.org.br';
  if(!correto)throw new Error('O perfil ouro não pôde ser validado integralmente. Revise CONFIG_AUTOMACAO e não gere o lote.');
  return true;
}

function hashOrdemHomologacao_(seed,key){
  let hash=2166136261;
  const texto=String(seed)+'|'+String(key);
  for(let i=0;i<texto.length;i++){hash^=texto.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return hash>>>0;
}

function loteHomologacaoDoArquivo_(arquivo){
  const m=texto_(arquivo).match(/_LOTE(\d+)_ENVELOPE_SEM_DIMENSOES_/i);
  if(!m)return'';
  const n=Number(m[1]);
  return n===20?'LOTE01':`LOTE${String(n).padStart(2,'0')}`;
}

function statusFilaPorManifesto_(statusCorreios){
  const status=texto_(statusCorreios).toUpperCase();
  if(status==='REJEITADO_CEP')return'REJEITADO_CORREIOS_CEP';
  if(status==='REJEITADO_LAYOUT'||status==='REJEITADO_SCHEMA')return'ERRO_GERADOR_SCHEMA';
  if(status==='SEM_ERRO_REPORTADO'||status==='PREPOSTAGEM_CONFIRMADA')return'PREPOSTAGEM_CONFIRMADA';
  if(status==='AGUARDANDO_RETORNO')return'JSON_GERADO_AGUARDANDO_PPN';
  return'';
}

function sincronizarFilaHomologacao_(){
  const base=dados_(PPN.SHEETS.BASE); const b=indice_(base.headers);
  const fila=dados_(PPN.SHEETS.HOMOLOG_QUEUE); const q=indice_(fila.headers);
  const existentes=new Map(fila.rows.map(row=>[`${texto_(row[q.ORIGEM]).toUpperCase()}|${texto_(row[q.CHAVE])}`,row]));
  const verificado=dados_(PPN.SHEETS.VERIFIED); const v=indice_(verificado.headers); const manifestos=new Map();
  verificado.rows.forEach(row=>{
    if(texto_(row[v.ORIGEM]).toUpperCase()!=='EMPRESA'||texto_(row[v.TIPO_EXPORTACAO])!=='OBJETO_REGISTRADO_JSON')return;
    const chave=texto_(row[v.CHAVE]); if(!chave)return;
    const key=`EMPRESA|${chave}`; const anterior=manifestos.get(key);
    if(!anterior||Number(row[v.LINHA_ARQUIVO])>=Number(anterior[v.LINHA_ARQUIVO]))manifestos.set(key,row);
  });
  const rows=[];
  base.rows.forEach(row=>{
    if(texto_(row[b.ORIGEM]).toUpperCase()!=='EMPRESA')return;
    const chave=texto_(row[b.CHAVE]); if(!chave)return;
    const key=`EMPRESA|${chave}`; const old=existentes.get(key)||[]; const avaliacao=avaliarEstruturaHomologacao_(row,b); let statusElegibilidade=avaliacao.status==='APTO_HOMOLOG'?'ELEGIVEL':'NAO_ELEGIVEL';
    let status=texto_(old[q.STATUS_HOMOLOGACAO])|| (statusElegibilidade==='ELEGIVEL'?'NAO_TESTADO':'NAO_ELEGIVEL');
    const manifest=manifestos.get(key); let lote=texto_(old[q.LOTE_HOMOLOGACAO]); let ordem=texto_(old[q.ORDEM_LOTE]); let arquivo=texto_(old[q.ARQUIVO_JSON]); let enviado=old[q.ENVIADO_EM]||''; let statusCorreios=texto_(old[q.STATUS_CORREIOS]); let codigoObjeto=texto_(old[q.CODIGO_OBJETO]); let retorno=old[q.RETORNO_EM]||''; let tipoReteste=texto_(old[q.TIPO_RETESTE]); let motivo=texto_(old[q.MOTIVO]);
    if(status==='REJEITADO_CORREIOS_CEP'&&row[b.STATUS_CEP_CORREIOS]==='OK'&&statusElegibilidade==='ELEGIVEL'){status='APTO_RETESTE';tipoReteste=tipoReteste||'CEP';}
    if(manifest){
      arquivo=texto_(manifest[v.ARQUIVO_EXPORTADO]); lote=lote||loteHomologacaoDoArquivo_(arquivo); ordem=ordem||texto_(manifest[v.LINHA_ARQUIVO]); enviado=manifest[v.EXPORTADO_EM]||enviado; statusCorreios=texto_(manifest[v.STATUS_CORREIOS])||statusCorreios; retorno=manifest[v.RETORNO_EM]||retorno; motivo=texto_(manifest[v.MOTIVO_CORREIOS]); const statusManifesto=statusFilaPorManifesto_(statusCorreios); if(statusManifesto){status=statusManifesto;if(statusCorreios==='SEM_ERRO_REPORTADO')motivo='';}
    }
    if(status==='NAO_ELEGIVEL'&&statusElegibilidade==='ELEGIVEL')status='NAO_TESTADO';
    rows.push([chave,'EMPRESA',texto_(row[b.CODIGO]),texto_(row[b.NOME]),statusElegibilidade,status,lote,ordem,arquivo,enviado,statusCorreios,codigoObjeto,retorno,tipoReteste,motivo,new Date()]);
  });
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.HOMOLOG_QUEUE); prepararAbaDados_(sh,PPN.HOMOLOG_QUEUE_HEADERS); if(rows.length){formatarColunasTextoAntes_(sh,2,rows.length,[1,2,3,7,8,9,11,12]);escreverEmBlocos_(sh,2,rows,250);} sh.setFrozenRows(1); return rows;
}

function proximoNumeroLoteHomologacao_(rows){
  const nums=rows.map(row=>{const m=texto_(row[6]).match(/^LOTE(\d+)$/i);return m?Number(m[1]):0;});
  return Math.max(1,...nums)+1;
}

function atualizarReservasFilaHomologacao_(chaves,status,lote,tipoReteste){
  const data=dados_(PPN.SHEETS.HOMOLOG_QUEUE); const q=indice_(data.headers); const set=new Set(chaves.map(texto_)); const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.HOMOLOG_QUEUE); const agora=new Date();
  data.rows.forEach((row,i)=>{if(!set.has(texto_(row[q.CHAVE])))return;row[q.STATUS_HOMOLOGACAO]=status;row[q.LOTE_HOMOLOGACAO]=lote;row[q.TIPO_RETESTE]=tipoReteste||row[q.TIPO_RETESTE]||'';row[q.ATUALIZADO_EM]=agora;sh.getRange(data.headerRow+i+1,1,1,PPN.HOMOLOG_QUEUE_HEADERS.length).setValues([row]);});
}

function gerarProximoLoteHomologacaoPj20(){
  if(ambiente_()!=='HOMOLOG')throw new Error('A fila controlada de homologação só pode ser usada em AMBIENTE=HOMOLOG.');
  const cfg=validarConfigObjetoRegistrado_(); validarPerfilOuroPj20_(cfg); const rows=sincronizarFilaHomologacao_(); const q=indice_(PPN.HOMOLOG_QUEUE_HEADERS);
  const candidatos=rows.filter(row=>row[q.STATUS_ELEGIBILIDADE]==='ELEGIVEL'&&row[q.STATUS_HOMOLOGACAO]==='NAO_TESTADO').sort((a,z)=>{const ha=hashOrdemHomologacao_('PPN-PJ-2026',a[q.CHAVE]);const hz=hashOrdemHomologacao_('PPN-PJ-2026',z[q.CHAVE]);return ha-hz||texto_(a[q.CODIGO]).localeCompare(texto_(z[q.CODIGO]),'pt-BR',{numeric:true});});
  if(!candidatos.length)throw new Error('Não há empresas ELEGIVEL + NAO_TESTADO. Consulte a fila ou gere o lote de reteste.');
  const loteNumero=proximoNumeroLoteHomologacao_(rows); const lote=`LOTE${String(loteNumero).padStart(2,'0')}`; const selecionados=candidatos.slice(0,20); const chaves=selecionados.map(row=>row[q.CHAVE]);
  atualizarReservasFilaHomologacao_(chaves,`RESERVADO_${lote}`,lote,'');
  try{
    const resultado=gerarXlsxObjetosRegistradosPorOrigem_('EMPRESA',{chavesOverride:chaves,loteTag:lote});
    sincronizarFilaHomologacao_();
    const atuais=sincronizarFilaHomologacao_(); const restantes=atuais.filter(row=>row[q.STATUS_HOMOLOGACAO]==='NAO_TESTADO').length; const confirmados=atuais.filter(row=>row[q.STATUS_HOMOLOGACAO]==='PREPOSTAGEM_CONFIRMADA').length; const cep=atuais.filter(row=>row[q.STATUS_HOMOLOGACAO]==='REJEITADO_CORREIOS_CEP').length;
    const arquivos=atuais.filter(row=>row[q.LOTE_HOMOLOGACAO]===lote).map(row=>row[q.ARQUIVO_JSON]).filter(Boolean);
    SpreadsheetApp.getUi().alert(`${lote} criado com sucesso.\n\nSelecionados: ${selecionados.length}\nAinda não testados: ${restantes}\nJá homologados: ${confirmados}\nCom exceção Correios: ${cep}\n\n${arquivos.join('\n')}\n\nImporte somente o JSON; o XLSX é auditoria.`);
    return resultado;
  }catch(error){atualizarReservasFilaHomologacao_(chaves,'NAO_TESTADO','','');throw error;}
}

function consultarFilaHomologacaoPj(){
  const rows=sincronizarFilaHomologacao_(); const q=indice_(PPN.HOMOLOG_QUEUE_HEADERS); const contar=status=>rows.filter(row=>row[q.STATUS_HOMOLOGACAO]===status).length;
  SpreadsheetApp.getUi().alert(`Fila de homologação PJ\n\nNão testados: ${contar('NAO_TESTADO')}\nReservados/JSON aguardando PPN: ${rows.filter(row=>/^RESERVADO_|JSON_GERADO_/.test(texto_(row[q.STATUS_HOMOLOGACAO]))).length}\nPré-postagens confirmadas: ${contar('PREPOSTAGEM_CONFIRMADA')}\nRejeitados por CEP: ${contar('REJEITADO_CORREIOS_CEP')}\nAptos para reteste: ${contar('APTO_RETESTE')}\nNão elegíveis: ${contar('NAO_ELEGIVEL')}`);
  return rows;
}

function gerarLoteRetesteHomologacaoPj(){
  if(ambiente_()!=='HOMOLOG')throw new Error('O reteste controlado só pode ser usado em AMBIENTE=HOMOLOG.');
  const cfg=validarConfigObjetoRegistrado_(); validarPerfilOuroPj20_(cfg); const rows=sincronizarFilaHomologacao_(); const q=indice_(PPN.HOMOLOG_QUEUE_HEADERS); const candidatos=rows.filter(row=>row[q.STATUS_HOMOLOGACAO]==='APTO_RETESTE').sort((a,z)=>texto_(a[q.CODIGO]).localeCompare(texto_(z[q.CODIGO]),'pt-BR',{numeric:true}));
  if(!candidatos.length)throw new Error('Não há registros APTO_RETESTE. Corrija e aprove os retornos de CEP antes do reteste.');
  const indiceReteste=1+rows.filter(row=>/^RET_E\d+$/i.test(texto_(row[q.LOTE_HOMOLOGACAO]))).length; const lote=`RET_E${String(indiceReteste).padStart(2,'0')}`; const selecionados=candidatos.slice(0,20); const chaves=selecionados.map(row=>row[q.CHAVE]); atualizarReservasFilaHomologacao_(chaves,`RESERVADO_${lote}`,lote,'CEP');
  try{const resultado=gerarXlsxObjetosRegistradosPorOrigem_('EMPRESA',{chavesOverride:chaves,loteTag:lote});const atuais=sincronizarFilaHomologacao_();const arquivos=atuais.filter(row=>row[q.LOTE_HOMOLOGACAO]===lote).map(row=>row[q.ARQUIVO_JSON]).filter(Boolean);SpreadsheetApp.getUi().alert(`${lote} criado com sucesso.\n\nSelecionados: ${selecionados.length}\n${arquivos.join('\n')}\n\nImporte somente o JSON e mantenha o XLSX como auditoria.`);return resultado;}catch(error){atualizarReservasFilaHomologacao_(chaves,'APTO_RETESTE','', 'CEP');throw error;}
}

function bloquearLoteCompletoHomologacaoPj(){
  throw new Error('Lote completo bloqueado: conclua a fila determinística de homologação e o aceite formal do perfil ouro antes de liberar produção.');
}

function normalizarCodigoGate_(value,tamanho){
  const raw=texto_(value).replace(/\D/g,'');
  return raw?raw.padStart(tamanho,'0'):'';
}

function higienizarGatesHomologacao_(){
  const data=dados_(PPN.SHEETS.HOMOLOG_GATES); if(!data.rows.length)return;
  const g=indice_(data.headers); const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.HOMOLOG_GATES);
  data.rows.forEach(row=>{row[g.SERVICO]=normalizarCodigoGate_(row[g.SERVICO],5);row[g.AR]=normalizarCodigoGate_(row[g.AR],3);row[g.RR]=normalizarCodigoGate_(row[g.RR],3);});
  const start=data.headerRow+1; const cols=[g.SERVICO+1,g.AR+1,g.RR+1]; formatarColunasTextoAntes_(sh,start,data.rows.length,cols); sh.getRange(start,1,data.rows.length,PPN.HOMOLOG_GATES_HEADERS.length).setValues(data.rows.map(row=>row.slice(0,PPN.HOMOLOG_GATES_HEADERS.length))); cols.forEach(col=>sh.getRange(start,col,data.rows.length,1).setNumberFormat('@'));
}

function registrarGateHomologacaoPj20(){
  higienizarGatesHomologacao_();
  const rows=sincronizarFilaHomologacao_(); const q=indice_(PPN.HOMOLOG_QUEUE_HEADERS); const gates=dados_(PPN.SHEETS.HOMOLOG_GATES); const g=indice_(gates.headers); const registrados=new Set(gates.rows.map(row=>texto_(row[g.LOTE])));
  const lotes=[...new Set(rows.map(row=>texto_(row[q.LOTE_HOMOLOGACAO])).filter(lote=>/^LOTE\d+$/i.test(lote)))].sort((a,z)=>Number(a.slice(4))-Number(z.slice(4))); const lote=lotes.find(item=>!registrados.has(item)&&rows.filter(row=>row[q.LOTE_HOMOLOGACAO]===item).length>0); if(!lote)throw new Error('Não há lote controlado novo e completo para registrar. O gate já registrado não será duplicado.');
  const loteRows=rows.filter(row=>row[q.LOTE_HOMOLOGACAO]===lote); const confirmados=loteRows.filter(row=>row[q.STATUS_HOMOLOGACAO]==='PREPOSTAGEM_CONFIRMADA').length; const cep=loteRows.filter(row=>row[q.STATUS_HOMOLOGACAO]==='REJEITADO_CORREIOS_CEP').length; const total=loteRows.length;
  if(confirmados+cep!==total)throw new Error(`Gate ${lote} ainda não fecha ${total}/${total}: encontrados ${confirmados} confirmados, ${cep} rejeitados por CEP e ${total-confirmados-cep} pendentes.`);
  const ui=SpreadsheetApp.getUi(); const resposta=ui.alert(`Registrar gate ${lote} — homologação controlada`,`Confirma no painel PPN que as ${confirmados} pré-postagens receberam atribuição de código AD...BR e que ${cep} foram rejeitadas por CEP?`,ui.ButtonSet.YES_NO); if(resposta!==ui.Button.YES)return false;
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.HOMOLOG_GATES); const agora=new Date(); const row=[Utilities.getUuid(),agora,'EMPRESA','Importação JSON PPN','03220','Envelope','10 g','Omitidas','001','025','DOCUMENTO / 1 / R$ 20,00',lote,total,confirmados,cep,`${total}/${total}`,'PASS','PASS — confirmado no painel PPN','PASS',`Gate ${lote} ponta a ponta; ${confirmados} pré-postagens e ${cep} rejeições de CEP.`]; const target=sh.getLastRow()+1; sh.getRange(target,1,1,row.length).setValues([row]); [5,9,10].forEach(col=>{sh.getRange(target,col).setNumberFormat('@');sh.getRange(target,col).setValue(String(row[col-1]));}); SpreadsheetApp.getUi().alert(`Gate ${lote} registrado como PASS. A fila exclui esses registros do próximo lote.`); return true;
}

function localizarUltimoArquivoManifestoPorMarcador_(origem,marcador,quantidade){
  const data=dados_(PPN.SHEETS.VERIFIED); const v=indice_(data.headers);
  validarCabecalhosLeitura_(data.headers,['ARQUIVO_EXPORTADO','ORIGEM','TIPO_EXPORTACAO','SEQUENCIAL','CHAVE'],PPN.SHEETS.VERIFIED);
  const grupos=new Map(); data.rows.forEach((row,i)=>{
    const arquivo=texto_(row[v.ARQUIVO_EXPORTADO]);
    if(texto_(row[v.ORIGEM]).toUpperCase()!==origem||texto_(row[v.TIPO_EXPORTACAO])!=='OBJETO_REGISTRADO_JSON'||!arquivo.includes(marcador))return;
    const grupo=grupos.get(arquivo)||{arquivo,total:0,ultimaLinha:0}; grupo.total++; grupo.ultimaLinha=Math.max(grupo.ultimaLinha,i); grupos.set(arquivo,grupo);
  });
  const candidatos=[...grupos.values()].filter(grupo=>grupo.total===quantidade).sort((a,z)=>z.ultimaLinha-a.ultimaLinha);
  if(!candidatos.length)throw new Error(`Nenhum manifesto ${origem} com marcador ${marcador} e exatamente ${quantidade} linhas foi encontrado. O reensaio foi bloqueado antes de qualquer alteração.`);
  chavesManifestoReferencia_(candidatos[0].arquivo,origem,quantidade);
  return candidatos[0].arquivo;
}

function marcarManifestoRejeitadoSchema_(arquivo,motivo){
  const data=dados_(PPN.SHEETS.VERIFIED); const v=indice_(data.headers); const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.VERIFIED);
  validarCabecalhosLeitura_(data.headers,['ARQUIVO_EXPORTADO','ORIGEM','STATUS_CORREIOS','MOTIVO_CORREIOS','RETORNO_EM','TIPO_EXPORTACAO','SEQUENCIAL','CHAVE'],PPN.SHEETS.VERIFIED);
  const encontrados=data.rows.map((row,i)=>({row,sheetRow:data.headerRow+i+1})).filter(item=>texto_(item.row[v.ARQUIVO_EXPORTADO])===texto_(arquivo)&&texto_(item.row[v.ORIGEM]).toUpperCase()==='EMPRESA'&&texto_(item.row[v.TIPO_EXPORTACAO])==='OBJETO_REGISTRADO_JSON');
  if(encontrados.length!==20)throw new Error(`Manifesto inválido para o reensaio: esperado 20 linhas de EMPRESA em ${arquivo}, encontrado ${encontrados.length}. Nenhuma nova seleção será feita.`);
  chavesManifestoReferencia_(arquivo,'EMPRESA',20);
  encontrados.forEach(item=>{
    sh.getRange(item.sheetRow,v.STATUS_CORREIOS+1).setValue('REJEITADO_SCHEMA');
    sh.getRange(item.sheetRow,v.MOTIVO_CORREIOS+1).setValue(texto_(motivo));
    sh.getRange(item.sheetRow,v.RETORNO_EM+1).setValue(new Date());
  });
  SpreadsheetApp.flush();
  log_('REGISTRAR_REJEICAO_SCHEMA',arquivo,'', 'REJEITADO_SCHEMA',`${encontrados.length} objetos; ${motivo}`,'',1);
  return encontrados.length;
}

function chavesManifestoReferencia_(arquivo,origem,quantidade){
  const data=dados_(PPN.SHEETS.VERIFIED); const v=indice_(data.headers);
  validarCabecalhosLeitura_(data.headers,['ARQUIVO_EXPORTADO','ORIGEM','TIPO_EXPORTACAO','SEQUENCIAL','CHAVE'],PPN.SHEETS.VERIFIED);
  const itens=data.rows
    .filter(row=>texto_(row[v.ARQUIVO_EXPORTADO])===texto_(arquivo)&&texto_(row[v.ORIGEM]).toUpperCase()===origem&&texto_(row[v.TIPO_EXPORTACAO])==='OBJETO_REGISTRADO_JSON')
    .map(row=>({sequencial:Number(row[v.SEQUENCIAL]),chave:texto_(row[v.CHAVE])}))
    .sort((a,z)=>a.sequencial-z.sequencial);
  const sequenciais=new Set(itens.map(item=>item.sequencial)); const chaves=new Set(itens.map(item=>item.chave));
  if(itens.length!==quantidade||sequenciais.size!==quantidade||chaves.size!==quantidade||itens.some((item,i)=>item.sequencial!==i+1||!item.chave))throw new Error(`Manifesto de referência inválido: ${arquivo}. Esperados ${quantidade} sequenciais e chaves únicos de 1 a ${quantidade}.`);
  return itens.map(item=>item.chave);
}

function gerarXlsxObjetosRegistradosPorOrigem_(origemAlvo,opcoes){
  opcoes=opcoes||{};
  origemAlvo=validarOrigemAlvo_(origemAlvo);
  const cfg=validarConfigObjetoRegistrado_();
  if(cfg.ambiente==='PRODUCAO')aplicarCacheNaBase_();
  const data=dados_(PPN.SHEETS.BASE); const b=indice_(data.headers);
  validarCabecalhosLeitura_(data.headers,['ORIGEM','STATUS_EXPORTACAO','CODIGO','NOME','CPF_CNPJ','DOCUMENTO_STATUS','CEP_ORIGINAL','CEP_FORMATO','TELEFONE','CELULAR','EMAIL','EMAIL_STATUS','LOGRADOURO_PARSER','NUMERO_PARSER','COMPLEMENTO_PARSER','BAIRRO_PARSER','CIDADE_PARSER','UF_PARSER','PARSER_CONFIANCA'],PPN.SHEETS.BASE);
  const elegiveis=data.rows.filter(r=>origemCorresponde_(r,b,origemAlvo)&&registroElegivelParaObjeto_(r,b,cfg.ambiente));
  const mensagemSemElegiveis=cfg.ambiente==='PRODUCAO'?`Nenhum registro ${rotuloOrigem_(origemAlvo)} está APTO para produção. Nenhum arquivo foi gerado.`:`Nenhum registro ${rotuloOrigem_(origemAlvo)} está APTO_HOMOLOG para o layout registrado. Revise PREVIA_DESTINATARIOS e FILA_EXCECOES.`;
  if(!elegiveis.length)throw new Error(mensagemSemElegiveis);
  const grupos=[
    {origem:'PROFISSIONAL',sheet:PPN.SHEETS.EXPORT_REGISTERED_PF,sufixo:'PROFISSIONAIS'},
    {origem:'EMPRESA',sheet:PPN.SHEETS.EXPORT_REGISTERED_PJ,sufixo:'EMPRESAS'},
  ].filter(grupo=>!origemAlvo||grupo.origem===origemAlvo);
  const preparados=grupos.map(grupo=>{
    let seq=0;
    const todasFontes=elegiveis.filter(r=>texto_(r[b.ORIGEM]).toUpperCase()===grupo.origem);
    const fontes=selecionarFontesObjetoRegistrado_(todasFontes,b,cfg,grupo.origem,opcoes);
    const rows=fontes.map(r=>linhaObjetoRegistrado_(r,b,++seq,cfg));
    validarLayoutObjetoRegistrado_(PPN.REGISTERED_HEADERS,rows,grupo.origem);
    gravarExportacaoRegistrada_(grupo.sheet,rows);
    const payloads=rows.map((row,i)=>objetoRegistradoJson_(row,grupo.origem,i+1));
    validarJsonObjetosRegistrados_(payloads,grupo.origem);
    return{...grupo,fontes,rows,payloads,totalElegiveis:todasFontes.length};
  });
  const comDados=preparados.filter(x=>x.rows.length);
  if(!comDados.length)throw new Error(mensagemSemElegiveis);
  checkpoint_('ANTES_EXPORT_OBJ_REGISTRADO');
  const stamp=carimbo_(); const prefix=cfg.ambiente==='HOMOLOG'?'HOMOLOG_PPN':'PPN';
  const resultados=comDados.map(x=>{
    const lote=opcoes.loteTag?`_${opcoes.loteTag}`:(cfg.modoLote==='CONTROLADO'?`_LOTE${cfg.limiteLote}`:'_COMPLETO');
    const auditoria=criarArquivoXlsx_(x.sheet,`${prefix}_OBJ_REGISTRADO_${x.sufixo}${lote}${PPN_SCHEMA_RETEST.OUTPUT_MARKER}AUDITORIA_${stamp}.xlsx`,PPN_FILES.TEMPLATE_REGISTERED,PPN.REGISTERED_HEADERS,x.rows);
    const json=criarArquivoJson_(`${prefix}_OBJ_REGISTRADO_${x.sufixo}${lote}${PPN_SCHEMA_RETEST.OUTPUT_MARKER}${stamp}.json`,x.payloads,x.origem);
    registrarBaseEnvioObjetosRegistrados_(json,auditoria,x.origem,x.fontes,x.rows,cfg.ambiente,b);
    return{origem:x.origem,json,auditoria,totalElegiveis:x.totalElegiveis};
  });
  const linhas=resultados.map(r=>`IMPORTAR: ${r.json.fileName} (${r.json.rows} de ${r.totalElegiveis} elegíveis)\nSHA-256: ${r.json.hash}\nAUDITORIA — NÃO IMPORTAR: ${r.auditoria.fileName}`);
  log_('EXPORTAR_OBJ_REGISTRADO_JSON','', '', 'SUCESSO',`schema=ENVELOPE_SEM_DIMENSOES_V177; dimensoesEnvelope=OMITIDAS; cienteObjetoNaoProibido=Integer(1); declaracaoQuantidade=Integer; declaracaoValor=Number; referencia=${cfg.arquivoReferencia||'nenhuma'}; ambiente=${cfg.ambiente}; modo=${cfg.modoLote}; limite=${cfg.limiteLote||'COMPLETO'}; origem=${origemAlvo||'PF+PJ'}; AR=${cfg.usarAr?'SIM':'NAO'}; ${resultados.map(r=>`${r.json.fileName}=${r.json.rows}/${r.totalElegiveis}`).join('; ')}`,'',1);
  SpreadsheetApp.getUi().alert(`Objetos registrados ${rotuloOrigem_(origemAlvo)} gerados com sucesso.\n\n${linhas.join('\n\n')}\n\nImporte no PPN apenas os arquivos JSON. Os XLSX são evidências de auditoria. O código do objeto permanece omitido para atribuição pelos Correios.`);
  return resultados.flatMap(r=>[r.json.fileId,r.auditoria.fileId]);
}

function selecionarFontesObjetoRegistrado_(fontes,b,cfg,origem,opcoes){
  opcoes=opcoes||{};
  const ordenadas=fontes.slice().sort((a,z)=>{
    const linhaA=Number(a[b.LINHA_ORIGEM])||Number.MAX_SAFE_INTEGER;
    const linhaZ=Number(z[b.LINHA_ORIGEM])||Number.MAX_SAFE_INTEGER;
    if(linhaA!==linhaZ)return linhaA-linhaZ;
    return texto_(a[b.CODIGO]).localeCompare(texto_(z[b.CODIGO]),'pt-BR',{numeric:true});
  });
  if(Array.isArray(opcoes.chavesOverride)){
    if(!opcoes.chavesOverride.length||opcoes.chavesOverride.length>cfg.limiteLote)throw new Error(`Seleção controlada inválida: ${opcoes.chavesOverride.length} registros; limite configurado ${cfg.limiteLote}.`);
    const porChave=new Map(ordenadas.map(row=>[texto_(row[b.CHAVE]),row]));
    const ausentes=opcoes.chavesOverride.filter(chave=>!porChave.has(texto_(chave)));
    if(ausentes.length)throw new Error(`Seleção controlada bloqueada: ${ausentes.length} chaves não estão elegíveis na base atual: ${ausentes.join(', ')}.`);
    return opcoes.chavesOverride.map(chave=>porChave.get(texto_(chave)));
  }
  if(cfg.modoLote==='COMPLETO')return ordenadas;
  if(cfg.arquivoReferencia){
    if(origem!=='EMPRESA')throw new Error('OBJ_REG_ARQUIVO_REFERENCIA está configurado para o reensaio empresarial; execute somente PJ — Empresas.');
    const chaves=chavesManifestoReferencia_(cfg.arquivoReferencia,origem,cfg.limiteLote); const porChave=new Map(ordenadas.map(row=>[texto_(row[b.CHAVE]),row]));
    const ausentes=chaves.filter(chave=>!porChave.has(chave));
    if(ausentes.length)throw new Error(`Reensaio bloqueado: ${ausentes.length} das mesmas 20 chaves não estão elegíveis na base atual: ${ausentes.join(', ')}. Não serão escolhidas empresas substitutas.`);
    return chaves.map(chave=>porChave.get(chave));
  }
  if(ordenadas.length<cfg.limiteLote)throw new Error(`Lote controlado de ${origem} exige exatamente ${cfg.limiteLote} registros elegíveis, mas somente ${ordenadas.length} foram encontrados.`);
  return ordenadas.slice(0,cfg.limiteLote);
}

function registroElegivelParaObjeto_(row,b,ambiente){
  if(ambiente==='PRODUCAO')return texto_(row[b.STATUS_EXPORTACAO]).toUpperCase()==='APTO';
  return avaliarEstruturaHomologacao_(row,b).status==='APTO_HOMOLOG';
}

function linhaObjetoRegistrado_(r,b,sequencial,cfg){
  const contatoRem=classificarContatoPpn_(cfg.remetenteTelefone,cfg.remetenteCelular);
  const contatoDest=classificarContatoPpn_(r[b.TELEFONE],r[b.CELULAR]);
  const diametroExportado=cfg.formato==='3'?cfg.diametro:'';
  const tamanhoDocumento=texto_(r[b.ORIGEM]).toUpperCase()==='EMPRESA'?14:11;
  const row=[
    String(sequencial),cfg.remetenteDocumento,'',cfg.remetenteNome,contatoRem.dddTelefone,contatoRem.telefone,contatoRem.dddCelular,contatoRem.celular,cfg.remetenteEmail,cfg.remetenteObservacao,
    cfg.remetenteCep,cfg.remetenteLogradouro,cfg.remetenteNumero,cfg.remetenteComplemento,cfg.remetenteBairro,cfg.remetenteCidade,cfg.remetenteUf,
    identificadorSeguro_(r[b.CPF_CNPJ],tamanhoDocumento),'',texto_(r[b.NOME]),contatoDest.dddTelefone,contatoDest.telefone,contatoDest.dddCelular,contatoDest.celular,r[b.EMAIL_STATUS]==='OK'?texto_(r[b.EMAIL]):'','',
    identificadorSeguro_(r[b.CEP_ORIGINAL],8),texto_(r[b.LOGRADOURO_APROVADO]||r[b.LOGRADOURO_CORREIOS]||r[b.LOGRADOURO_PARSER]),texto_(r[b.NUMERO_APROVADO]||r[b.NUMERO_PARSER]),texto_(r[b.COMPLEMENTO_APROVADO]||r[b.COMPLEMENTO_PARSER]),texto_(r[b.BAIRRO_APROVADO]||r[b.BAIRRO_CORREIOS]||r[b.BAIRRO_PARSER]),texto_(r[b.CIDADE_APROVADA]||r[b.CIDADE_CORREIOS]||r[b.CIDADE_PARSER]),texto_(r[b.UF_APROVADA]||r[b.UF_CORREIOS]||r[b.UF_PARSER]).toUpperCase(),
    cfg.codigoServico,cfg.dataPrevistaPostagem,cfg.prazoPostagem,cfg.logisticaReversa,cfg.dataValidadeLogReversa,cfg.codigoValorDeclarado,cfg.valorDeclarado,cfg.codigoEntregaVizinho,cfg.orientacaoEntregaVizinho,cfg.codigoAr,cfg.codigoAdicional2,cfg.codigoAdicional3,
    cfg.peso,cfg.formato,cfg.altura,cfg.largura,cfg.comprimento,diametroExportado,String(cfg.cienteObjetoNaoProibido),cfg.observacao,'','',''
  ];
  for(let i=1;i<=10;i++)row.push(i===1?cfg.conteudo1:'',i===1?cfg.conteudoQuantidade1:'',i===1?cfg.conteudoValor1:'');
  row.push('');
  return row;
}

function validarConfigObjetoRegistrado_(){
  validarConfig_(['NUMERO_CONTRATO','CARTAO_POSTAGEM','OBJ_REG_CODIGO_SERVICO','PESO_GRAMAS','OBJ_REG_FORMATO','REMETENTE_NOME','REMETENTE_CEP','REMETENTE_LOGRADOURO','REMETENTE_NUMERO','REMETENTE_BAIRRO','REMETENTE_CIDADE','REMETENTE_UF','REMETENTE_CPF_CNPJ','OBJ_REG_CIENTE_NAO_PROIBIDO']);
  const errors=[]; const ambiente=ambiente_();
  const modoLote=texto_(config_('OBJ_REG_MODO_LOTE')||'CONTROLADO').toUpperCase();
  const limiteTexto=texto_(config_('OBJ_REG_LIMITE_LOTE')||'20'); const limiteLote=Number(limiteTexto);
  const arquivoReferencia=texto_(config_('OBJ_REG_ARQUIVO_REFERENCIA'));
  const layoutHomologado=texto_(config_('OBJ_REG_LAYOUT_HOMOLOGADO')).toUpperCase()==='SIM';
  const remetenteDocumento=digitos_(config_('REMETENTE_CPF_CNPJ')); const remetenteCep=digitos_(config_('REMETENTE_CEP')); const remetenteUf=texto_(config_('REMETENTE_UF')).toUpperCase();
  const codigoServico=digitos_(config_('OBJ_REG_CODIGO_SERVICO')); const peso=numeroPpn_(config_('PESO_GRAMAS')); const formato=digitos_(config_('OBJ_REG_FORMATO'));
  const usarAr=simNao_(config_('OBJ_REG_USAR_AR'),'OBJ_REG_USAR_AR',errors)==='S'; const codigoAr=digitos_(config_('OBJ_REG_CODIGO_AR'));
  const logisticaReversa=simNao_(config_('OBJ_REG_LOGISTICA_REVERSA'),'OBJ_REG_LOGISTICA_REVERSA',errors);
  const dataPrevistaPostagem=valorDataPpnOpcional_(config_('OBJ_REG_DATA_PREVISTA_POSTAGEM'),'OBJ_REG_DATA_PREVISTA_POSTAGEM',errors);
  const prazoPostagem=valorDataPpnOpcional_(config_('OBJ_REG_PRAZO_POSTAGEM'),'OBJ_REG_PRAZO_POSTAGEM',errors);
  const dataValidadeLogReversa=valorDataPpnOpcional_(config_('OBJ_REG_DATA_VALIDADE_LOG_REVERSA'),'OBJ_REG_DATA_VALIDADE_LOG_REVERSA',errors);
  const codigoValorDeclarado=digitos_(config_('OBJ_REG_CODIGO_VALOR_DECLARADO')); const valorDeclarado=numeroPpnOpcional_(config_('OBJ_REG_VALOR_DECLARADO'),'OBJ_REG_VALOR_DECLARADO',errors);
  const codigoEntregaVizinho=digitos_(config_('OBJ_REG_CODIGO_ENTREGA_VIZINHO')); const orientacaoEntregaVizinho=texto_(config_('OBJ_REG_ORIENTACAO_ENTREGA_VIZINHO'));
  const altura=numeroPpnOpcional_(config_('OBJ_REG_ALTURA'),'OBJ_REG_ALTURA',errors); const largura=numeroPpnOpcional_(config_('OBJ_REG_LARGURA'),'OBJ_REG_LARGURA',errors); const comprimento=numeroPpnOpcional_(config_('OBJ_REG_COMPRIMENTO'),'OBJ_REG_COMPRIMENTO',errors); const diametro=numeroPpnOpcional_(config_('OBJ_REG_DIAMETRO'),'OBJ_REG_DIAMETRO',errors);
  const conteudo1=texto_(config_('OBJ_REG_CONTEUDO_1')); const conteudoQuantidade1=numeroPpnOpcional_(config_('OBJ_REG_CONTEUDO_QTD_1'),'OBJ_REG_CONTEUDO_QTD_1',errors); const conteudoValor1=numeroPpnOpcional_(config_('OBJ_REG_CONTEUDO_VALOR_1'),'OBJ_REG_CONTEUDO_VALOR_1',errors);
  const dimensoes=[altura,largura,comprimento,diametro];
  if(formato==='1'&&dimensoes.some(Boolean))errors.push('Para OBJ_REG_FORMATO=1 (ENVELOPE), OBJ_REG_ALTURA, OBJ_REG_LARGURA, OBJ_REG_COMPRIMENTO e OBJ_REG_DIAMETRO devem ficar vazios');
  if(formato!=='1'&&[altura,largura,comprimento].some(Boolean)&&![altura,largura,comprimento].every(Boolean))errors.push('OBJ_REG_ALTURA, OBJ_REG_LARGURA e OBJ_REG_COMPRIMENTO devem ser preenchidos em conjunto');
  if(!((remetenteDocumento.length===11&&cpfValido_(remetenteDocumento))||(remetenteDocumento.length===14&&cnpjValido_(remetenteDocumento))))errors.push('CPF/CNPJ do remetente inválido');
  if(remetenteCep.length!==8)errors.push('CEP do remetente deve ter 8 dígitos');
  if(remetenteUf.length!==2)errors.push('UF do remetente deve ter 2 letras');
  if(!codigoServico)errors.push('OBJ_REG_CODIGO_SERVICO deve conter o código contratado, somente dígitos');
  if(!peso||Number(peso)<=0)errors.push('PESO_GRAMAS deve ser maior que zero');
  if(!['CONTROLADO','COMPLETO'].includes(modoLote))errors.push('OBJ_REG_MODO_LOTE deve ser CONTROLADO ou COMPLETO');
  if(modoLote==='CONTROLADO'&&(!Number.isInteger(limiteLote)||limiteLote<1||limiteLote>20))errors.push('OBJ_REG_LIMITE_LOTE deve ser um inteiro entre 1 e 20 no modo CONTROLADO');
  if(arquivoReferencia&&(modoLote!=='CONTROLADO'||limiteLote!==20))errors.push('OBJ_REG_ARQUIVO_REFERENCIA exige modo CONTROLADO e limite 20 para preservar o reensaio');
  if(modoLote==='COMPLETO'&&ambiente==='HOMOLOG'&&!layoutHomologado)errors.push('lote COMPLETO em homologação bloqueado: conclua o ensaio de 20 e marque OBJ_REG_LAYOUT_HOMOLOGADO=SIM somente após o aceite formal');
  if(!['1','2','3'].includes(formato))errors.push('OBJ_REG_FORMATO inválido. Use somente: 1=envelope, 2=caixa/pacote, 3=rolo/cilindro');
  if(formato!=='3'&&formato!=='1'&&diametro)errors.push('OBJ_REG_DIAMETRO deve ficar vazio para caixa/pacote');
  if(usarAr&& !codigoAr)errors.push('OBJ_REG_CODIGO_AR é obrigatório quando OBJ_REG_USAR_AR=SIM');
  if(!usarAr&&codigoAr)errors.push('OBJ_REG_CODIGO_AR deve ficar vazio quando OBJ_REG_USAR_AR=NAO');
  if(!dataPrevistaPostagem&&!prazoPostagem)errors.push('Informe OBJ_REG_DATA_PREVISTA_POSTAGEM ou OBJ_REG_PRAZO_POSTAGEM conforme o schema homologado');
  if(logisticaReversa==='S'&&!dataValidadeLogReversa)errors.push('OBJ_REG_DATA_VALIDADE_LOG_REVERSA é obrigatória quando logística reversa estiver ativa');
  if(Boolean(codigoValorDeclarado)!==Boolean(valorDeclarado))errors.push('Código e valor declarado devem ser preenchidos em conjunto');
  if(Boolean(codigoEntregaVizinho)!==Boolean(orientacaoEntregaVizinho))errors.push('Código e orientação de entrega ao vizinho devem ser preenchidos em conjunto');
  if(!conteudo1||conteudo1.length<5)errors.push('OBJ_REG_CONTEUDO_1 é obrigatório e deve ter no mínimo 5 caracteres');
  if(!conteudoQuantidade1||Number(conteudoQuantidade1)<=0)errors.push('OBJ_REG_CONTEUDO_QTD_1 deve ser maior que zero');
  if(conteudoValor1===''||!Number.isFinite(Number(conteudoValor1))||Number(conteudoValor1)<0)errors.push('OBJ_REG_CONTEUDO_VALOR_1 deve ser informado e não pode ser negativo');
  const cienteRaw=texto_(config_('OBJ_REG_CIENTE_NAO_PROIBIDO')).toUpperCase(); if(!['1','SIM'].includes(cienteRaw))errors.push('OBJ_REG_CIENTE_NAO_PROIBIDO deve ser 1 ou SIM após declaração do responsável');
  const cienteObjetoNaoProibido=1;
  if(ambiente==='PRODUCAO'&&!layoutHomologado)errors.push('produção bloqueada: marque OBJ_REG_LAYOUT_HOMOLOGADO=SIM somente após aceite formal dos Correios');
  if(errors.length)throw new Error('Configuração do objeto registrado inválida:\n- '+errors.join('\n- '));
  return{
    ambiente,modoLote,limiteLote:modoLote==='CONTROLADO'?limiteLote:'',arquivoReferencia,usarAr,codigoServico,codigoAr:usarAr?codigoAr:'',codigoAdicional2:digitos_(config_('OBJ_REG_ADICIONAL_2')),codigoAdicional3:digitos_(config_('OBJ_REG_ADICIONAL_3')),
    dataPrevistaPostagem,prazoPostagem,logisticaReversa,dataValidadeLogReversa:logisticaReversa==='S'?dataValidadeLogReversa:'',codigoValorDeclarado,valorDeclarado,codigoEntregaVizinho,orientacaoEntregaVizinho,
    peso,formato,altura,largura,comprimento,diametro,observacao:texto_(config_('OBJ_REG_OBSERVACAO')),
    remetenteDocumento,remetenteNome:texto_(config_('REMETENTE_NOME')),remetenteTelefone:config_('REMETENTE_TELEFONE'),remetenteCelular:config_('REMETENTE_CELULAR'),remetenteEmail:texto_(config_('REMETENTE_EMAIL')),remetenteObservacao:texto_(config_('REMETENTE_OBSERVACAO')),
    remetenteCep,remetenteLogradouro:texto_(config_('REMETENTE_LOGRADOURO')),remetenteNumero:texto_(config_('REMETENTE_NUMERO')),remetenteComplemento:texto_(config_('REMETENTE_COMPLEMENTO')),remetenteBairro:texto_(config_('REMETENTE_BAIRRO')),remetenteCidade:texto_(config_('REMETENTE_CIDADE')),remetenteUf,
    conteudo1,conteudoQuantidade1,conteudoValor1,cienteObjetoNaoProibido
  };
}

function validarLayoutObjetoRegistrado_(headers,rows,origem){
  const expected=PPN.REGISTERED_HEADERS;
  if(headers.length!==87)throw new Error(`Layout registrado inválido: esperado 87 colunas, recebido ${headers.length}.`);
  const duplicates=headers.filter((h,i)=>headers.indexOf(h)!==i); if(duplicates.length)throw new Error('Layout registrado contém cabeçalhos duplicados: '+[...new Set(duplicates)].join(', '));
  const mismatch=headers.findIndex((h,i)=>h!==expected[i]); if(mismatch>=0)throw new Error(`Layout registrado fora do padrão na coluna ${mismatch+1}: esperado ${expected[mismatch]}, recebido ${headers[mismatch]}.`);
  rows.forEach((row,i)=>{
    if(row.length!==87)throw new Error(`Linha ${i+2} de ${origem} possui ${row.length} colunas; esperado 87.`);
    if(!row[0]||!row[1]||!row[3]||!row[10]||!row[17]||!row[19]||!row[26]||!row[33]||!row[45]||!row[46]||row[51]!=='1')throw new Error(`Linha ${i+2} de ${origem} não atende aos campos estruturais obrigatórios do objeto registrado.`);
    const formato=texto_(row[46]); if(!['1','2','3'].includes(formato))throw new Error(`Linha ${i+2} de ${origem}: codigoFormatoObjetoInformado="${formato}" inválido.`);
    if(formato==='1'&&[47,48,49,50].some(index=>texto_(row[index])))throw new Error(`Linha ${i+2} de ${origem}: envelope não deve informar altura, largura, comprimento ou diâmetro.`);
    if(formato!=='3'&&formato!=='1'&&texto_(row[50]))throw new Error(`Linha ${i+2} de ${origem}: diametroInformado deve ficar vazio para formato ${formato}.`);
    const dddTel=digitos_(row[20]); const tel=digitos_(row[21]); const dddCel=digitos_(row[22]); const cel=digitos_(row[23]);
    if((dddTel||tel)&&(dddTel.length!==2||tel.length!==8))throw new Error(`Linha ${i+2} de ${origem}: telefone inválido. Esperado DDD com 2 dígitos + telefone com 8.`);
    if((dddCel||cel)&&(dddCel.length!==2||cel.length!==9||!cel.startsWith('9')))throw new Error(`Linha ${i+2} de ${origem}: celular inválido. Esperado DDD com 2 dígitos + celular com 9 iniciado em 9.`);
    const conteudo=texto_(row[56]); const quantidade=Number(String(row[57]??'').replace(',','.')); const valor=Number(String(row[58]??'').replace(',','.'));
    if(conteudo.length<5)throw new Error(`Linha ${i+2} de ${origem}: declaração de conteúdo obrigatória e com no mínimo 5 caracteres.`);
    if(!Number.isFinite(quantidade)||quantidade<=0)throw new Error(`Linha ${i+2} de ${origem}: quantidade da declaração inválida.`);
    if(!Number.isFinite(valor)||valor<0)throw new Error(`Linha ${i+2} de ${origem}: valor da declaração inválido.`);
    if(row[86])throw new Error(`Linha ${i+2} de ${origem} contém codigoObjetoIda; este gerador é exclusivamente sem código de registro.`);
  });
  return true;
}

function gravarExportacaoRegistrada_(sheetName,rows){
  const sh=SpreadsheetApp.getActive().getSheetByName(sheetName); prepararAbaDados_(sh,PPN.REGISTERED_HEADERS); formatarMatrizComoTextoAntes_(sh,2,rows.length,PPN.REGISTERED_HEADERS.length); escreverEmBlocos_(sh,2,rows,250);
  if(rows.length)sh.getRange(1,1,rows.length+1,PPN.REGISTERED_HEADERS.length).setNumberFormat('@');
  const actual=sh.getRange(1,1,1,PPN.REGISTERED_HEADERS.length).getDisplayValues()[0]; validarLayoutObjetoRegistrado_(actual,rows,sheetName);
  sh.getRange(1,1,1,PPN.REGISTERED_HEADERS.length).setBackground('#0F5D50').setFontColor('#FFFFFF').setFontWeight('bold').setWrap(true); sh.setFrozenRows(1);
}

function classificarContatoPpn_(telefone,celular){
  const out={dddTelefone:'',telefone:'',dddCelular:'',celular:''};
  const consumir=numero=>{
    numero=telefone_(numero); if(!numero)return;
    if(numero.length===11&&numero.charAt(2)==='9'){if(!out.celular){out.dddCelular=numero.slice(0,2);out.celular=numero.slice(2);}return;}
    if(numero.length===10&&!out.telefone){out.dddTelefone=numero.slice(0,2);out.telefone=numero.slice(2);}
  };
  consumir(celular); consumir(telefone); return out;
}

function montarPessoaPpn_(nome,cpfCnpj,contato,email,endereco){
  const pessoa={nome:texto_(nome),cpfCnpj:digitos_(cpfCnpj)};
  if(contato.dddTelefone&&contato.telefone){pessoa.dddTelefone=contato.dddTelefone;pessoa.telefone=contato.telefone;}
  if(contato.dddCelular&&contato.celular){pessoa.dddCelular=contato.dddCelular;pessoa.celular=contato.celular;}
  if(texto_(email))pessoa.email=texto_(email);
  pessoa.endereco={
    cep:digitos_(endereco.cep),logradouro:texto_(endereco.logradouro),numero:texto_(endereco.numero),bairro:texto_(endereco.bairro),cidade:texto_(endereco.cidade),uf:texto_(endereco.uf).toUpperCase()
  };
  if(texto_(endereco.complemento))pessoa.endereco.complemento=texto_(endereco.complemento);
  return pessoa;
}

function aplicarDimensoesObjetoPpn_(obj,dimensoes){
  dimensoes=dimensoes||{};
  const formato=texto_(dimensoes.formato);
  if(formato==='1'){
    delete obj.alturaInformada;
    delete obj.larguraInformada;
    delete obj.comprimentoInformado;
    delete obj.diametroInformado;
    return obj;
  }
  if(texto_(dimensoes.altura))obj.alturaInformada=texto_(dimensoes.altura);
  if(texto_(dimensoes.largura))obj.larguraInformada=texto_(dimensoes.largura);
  if(texto_(dimensoes.comprimento))obj.comprimentoInformado=texto_(dimensoes.comprimento);
  if(formato==='3'&&texto_(dimensoes.diametro))obj.diametroInformado=texto_(dimensoes.diametro);
  return obj;
}

function objetoRegistradoJson_(row,origem,linha){
  const contatoRem={dddTelefone:texto_(row[4]),telefone:texto_(row[5]),dddCelular:texto_(row[6]),celular:texto_(row[7])};
  const contatoDest={dddTelefone:texto_(row[20]),telefone:texto_(row[21]),dddCelular:texto_(row[22]),celular:texto_(row[23])};
  const obj={
    sequencial:texto_(row[0]),
    remetente:montarPessoaPpn_(row[3],row[1],contatoRem,row[8],{cep:row[10],logradouro:row[11],numero:row[12],complemento:row[13],bairro:row[14],cidade:row[15],uf:row[16]}),
    destinatario:montarPessoaPpn_(row[19],row[17],contatoDest,row[24],{cep:row[26],logradouro:row[27],numero:row[28],complemento:row[29],bairro:row[30],cidade:row[31],uf:row[32]}),
    codigoServico:texto_(row[33]),logisticaReversa:texto_(row[36]),pesoInformado:texto_(row[45]),codigoFormatoObjetoInformado:texto_(row[46]),cienteObjetoNaoProibido:1
  };
  const opcionais={dataPrevistaPostagem:row[34],prazoPostagem:row[35],dataValidadeLogReversa:row[37],observacao:row[52],numeroNotaFiscal:row[53],chaveNFe:row[54],rfidObjeto:row[55]};
  Object.keys(opcionais).forEach(k=>{if(texto_(opcionais[k])!=='')obj[k]=texto_(opcionais[k]);});
  aplicarDimensoesObjetoPpn_(obj,{formato:row[46],altura:row[47],largura:row[48],comprimento:row[49],diametro:row[50]});
  const adicionais=[]; const adicionar=(codigo,extras)=>{codigo=digitos_(codigo);if(!codigo)return;const item={codigoServicoAdicional:codigo};Object.keys(extras||{}).forEach(k=>{if(texto_(extras[k])!=='')item[k]=texto_(extras[k]);});if(!adicionais.some(a=>a.codigoServicoAdicional===codigo))adicionais.push(item);};
  adicionar(row[38],{valorDeclarado:row[39]}); adicionar(row[40],{orientacaoEntregaVizinho:row[41]}); adicionar(row[42]); adicionar(row[43]); adicionar(row[44]);
  if(adicionais.length)obj.listaServicoAdicional=adicionais;
  const itens=[];
  for(let i=0;i<10;i++){
    const pos=56+i*3;
    const conteudo=texto_(row[pos]);
    if(!conteudo)continue;
    itens.push({
      conteudo,
      quantidade:inteiroJsonPpn_(row[pos+1],`itensDeclaracaoConteudo[${i}].quantidade`,{obrigatorio:true,min:1}),
      valor:numeroJsonPpn_(row[pos+2],`itensDeclaracaoConteudo[${i}].valor`,{obrigatorio:true,min:0})
    });
  }
  obj.itensDeclaracaoConteudo=itens;
  if(texto_(row[86]))obj.codigoObjetoIda=texto_(row[86]);
  Object.defineProperty(obj,'__auditoria',{value:{origem,linha},enumerable:false});
  return obj;
}

function validarJsonObjetosRegistrados_(payloads,origem){
  if(!Array.isArray(payloads)||!payloads.length)throw new Error(`JSON de ${origem} sem objetos.`);
  const sequenciais=new Set(); payloads.forEach((obj,i)=>{
    const linha=i+1; const seq=texto_(obj.sequencial); if(!seq||sequenciais.has(seq))throw new Error(`JSON de ${origem}, item ${linha}: sequencial vazio ou duplicado.`); sequenciais.add(seq);
    if(!obj.remetente||typeof obj.remetente!=='object'||Array.isArray(obj.remetente))throw new Error(`JSON de ${origem}, sequencial ${seq}: Schema PPN exige remetente como objeto.`);
    if(!obj.destinatario||typeof obj.destinatario!=='object'||Array.isArray(obj.destinatario))throw new Error(`JSON de ${origem}, sequencial ${seq}: Schema PPN exige destinatario como objeto.`);
    validarPessoaPpn_(obj.remetente,'remetente',origem,seq);
    validarPessoaPpn_(obj.destinatario,'destinatario',origem,seq);
    const achatados=Object.keys(obj).filter(k=>/^(remetente|destinatario)[A-Z]/.test(k)); if(achatados.length)throw new Error(`JSON de ${origem}, sequencial ${seq}: propriedades achatadas proibidas: ${achatados.join(', ')}.`);
    if(!Number.isInteger(obj.cienteObjetoNaoProibido)||obj.cienteObjetoNaoProibido!==1)throw new Error(`JSON de ${origem}, sequencial ${seq}: cienteObjetoNaoProibido deve ser o inteiro 1.`);
    if(!['1','2','3'].includes(texto_(obj.codigoFormatoObjetoInformado)))throw new Error(`JSON de ${origem}, sequencial ${seq}: formato inválido.`);
    validarDimensoesJsonPpn_(obj);
    if(!Array.isArray(obj.itensDeclaracaoConteudo)||!obj.itensDeclaracaoConteudo.length)throw new Error(`JSON de ${origem}, sequencial ${seq}: declaração de conteúdo obrigatória.`);
    obj.itensDeclaracaoConteudo.forEach((item,index)=>{
      if(texto_(item.conteudo).length<5)throw new Error(`JSON de ${origem}, sequencial ${seq}: itensDeclaracaoConteudo[${index}].conteudo deve ter no mínimo 5 caracteres.`);
      if(!Number.isInteger(item.quantidade)||item.quantidade<1)throw new Error(`JSON de ${origem}, sequencial ${seq}: itensDeclaracaoConteudo[${index}].quantidade deve ser Integer >= 1.`);
      if(typeof item.valor!=='number'||!Number.isFinite(item.valor))throw new Error(`JSON de ${origem}, sequencial ${seq}: itensDeclaracaoConteudo[${index}].valor deve ser Number.`);
      if(item.valor<0)throw new Error(`JSON de ${origem}, sequencial ${seq}: valor da declaração não pode ser negativo.`);
    });
    if(obj.codigoObjetoIda!==undefined)throw new Error(`JSON de ${origem}, sequencial ${seq}: código de objeto não pode ser informado.`);
  }); return true;
}

function validarDimensoesJsonPpn_(obj){
  const formato=texto_(obj.codigoFormatoObjetoInformado);
  if(formato==='1'){
    const proibidos=['alturaInformada','larguraInformada','comprimentoInformado','diametroInformado'];
    const encontrados=proibidos.filter(campo=>Object.prototype.hasOwnProperty.call(obj,campo));
    if(encontrados.length)throw new Error(`Sequencial ${obj.sequencial}: ENVELOPE não deve informar dimensões: ${encontrados.join(', ')}`);
    return true;
  }
  if(formato!=='3'&&Object.prototype.hasOwnProperty.call(obj,'diametroInformado'))throw new Error(`Sequencial ${obj.sequencial}: diâmetro não permitido para o formato.`);
  return true;
}

function validarPessoaPpn_(pessoa,titulo,origem,seq){
  if(!texto_(pessoa.nome))throw new Error(`JSON de ${origem}, sequencial ${seq}: ${titulo}.nome obrigatório.`);
  const documento=digitos_(pessoa.cpfCnpj); if(![11,14].includes(documento.length))throw new Error(`JSON de ${origem}, sequencial ${seq}: ${titulo}.cpfCnpj deve ter 11 ou 14 dígitos.`);
  if(!pessoa.endereco||typeof pessoa.endereco!=='object'||Array.isArray(pessoa.endereco))throw new Error(`JSON de ${origem}, sequencial ${seq}: Schema PPN exige ${titulo}.endereco como objeto.`);
  const endereco=pessoa.endereco; const obrigatorios=['logradouro','numero','bairro','cidade','uf']; const ausentes=obrigatorios.filter(k=>!texto_(endereco[k]));
  if(digitos_(endereco.cep).length!==8)ausentes.unshift('cep');
  if(texto_(endereco.uf).length!==2&&!ausentes.includes('uf'))ausentes.push('uf');
  if(ausentes.length)throw new Error(`JSON de ${origem}, sequencial ${seq}: campos obrigatórios ausentes ou inválidos em ${titulo}.endereco: ${ausentes.join(', ')}.`);
  const dddTel=digitos_(pessoa.dddTelefone); const tel=digitos_(pessoa.telefone); const dddCel=digitos_(pessoa.dddCelular); const cel=digitos_(pessoa.celular);
  if((dddTel||tel)&&(dddTel.length!==2||tel.length!==8))throw new Error(`JSON de ${origem}, sequencial ${seq}: telefone de ${titulo} inválido.`);
  if((dddCel||cel)&&(dddCel.length!==2||cel.length!==9||!cel.startsWith('9')))throw new Error(`JSON de ${origem}, sequencial ${seq}: celular de ${titulo} inválido.`);
}

function criarArquivoJson_(fileName,payloads,origem){
  validarConfig_(['PASTA_SAIDA_ID']); validarJsonObjetosRegistrados_(payloads,origem);
  const textoJson=JSON.stringify(payloads,null,2); const blob=Utilities.newBlob(textoJson,'application/json',fileName); const file=DriveApp.getFolderById(config_('PASTA_SAIDA_ID')).createFile(blob); const hash=sha256_(blob.getBytes());
  log_('EXPORTAR_JSON_OBJ_REGISTRADO',file.getId(),origem,'SUCESSO',`${fileName}; registros=${payloads.length}; SHA-256=${hash}`,'',1);
  return{fileId:file.getId(),fileName,hash,rows:payloads.length};
}

function registrarBaseEnvioObjetosRegistrados_(json,auditoria,origem,fontes,rows,ambiente,b){
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.VERIFIED); atualizarCabecalhosGerenciados_(sh,PPN.VERIFIED_HEADERS); const existentes=dados_(PPN.SHEETS.VERIFIED); const v=indice_(existentes.headers);
  if(existentes.rows.some(r=>texto_(r[v.ARQUIVO_EXPORTADO])===json.fileName))return false;
  const id=Utilities.getUuid(); const agora=new Date(); const saida=fontes.map((fonte,i)=>[
    id,json.fileName,origem,i+1,texto_(fonte[b.CODIGO]),texto_(fonte[b.NOME]),digitos_(fonte[b.CPF_CNPJ]),digitos_(fonte[b.CEP_ORIGINAL]),`VALIDADO_${ambiente}`,'AGUARDANDO_RETORNO','', '',agora,'','OBJETO_REGISTRADO_JSON',texto_(rows[i][0]),texto_(fonte[b.CHAVE]),auditoria.fileName
  ]);
  formatarColunasTextoAntes_(sh,sh.getLastRow()+1,saida.length,[1,2,3,4,5,6,7,8,15,16,17,18]); escreverEmBlocos_(sh,sh.getLastRow()+1,saida,250); sh.setFrozenRows(1); return true;
}

function separarTelefone_(value){const phone=telefone_(value);return phone?{ddd:phone.slice(0,2),numero:phone.slice(2)}:{ddd:'',numero:''};}
function simNao_(value,name,errors){const v=texto_(value||'NAO').toUpperCase();if(['SIM','S'].includes(v))return'S';if(['NAO','N','NÃO'].includes(v))return'N';errors.push(`${name} deve ser SIM ou NAO`);return'N';}
function numeroPpn_(value){if(value===''||value===null||value===undefined)return'';const n=Number(String(value).replace(',','.'));return Number.isFinite(n)?String(n):'';}

function numeroJsonPpn_(value,nome,opcoes){
  opcoes=opcoes||{};
  const raw=String(value===null||value===undefined?'':value).trim().replace(',','.');
  if(raw===''){
    if(opcoes.obrigatorio)throw new Error(`${nome} é obrigatório no JSON PPN.`);
    return null;
  }
  const n=Number(raw);
  if(!Number.isFinite(n))throw new Error(`${nome} deve ser Number no JSON PPN. Valor recebido: "${raw}".`);
  if(opcoes.min!==undefined&&n<opcoes.min)throw new Error(`${nome} deve ser >= ${opcoes.min}.`);
  return n;
}

function inteiroJsonPpn_(value,nome,opcoes){
  opcoes=opcoes||{};
  const raw=String(value===null||value===undefined?'':value).trim();
  if(raw===''){
    if(opcoes.obrigatorio)throw new Error(`${nome} é obrigatório no JSON PPN.`);
    return null;
  }
  const n=Number(raw.replace(',','.'));
  if(!Number.isFinite(n))throw new Error(`${nome} deve ser Integer. Valor recebido: "${raw}".`);
  if(!Number.isInteger(n))throw new Error(`${nome} deve ser um número inteiro. Valor recebido: "${raw}".`);
  if(opcoes.min!==undefined&&n<opcoes.min)throw new Error(`${nome} deve ser >= ${opcoes.min}.`);
  return n;
}
function numeroPpnOpcional_(value,name,errors){if(texto_(value)==='')return'';const n=numeroPpn_(value);if(!n||Number(n)<0)errors.push(`${name} deve ser numérico e não negativo`);return n;}
function valorDataPpnOpcional_(value,name,errors){if(texto_(value)==='')return'';const d=dataPpn_(value);if(!d)errors.push(`${name} deve estar em dd/MM/aaaa`);return d;}

function exportarAbaComoXlsx_(sheetName,fileName,templateName,headers,rows) {
  const result=criarArquivoXlsx_(sheetName,fileName,templateName,headers,rows);
  SpreadsheetApp.getUi().alert(`Arquivo gerado com ${result.rows} registros:\n${result.fileName}\n\nSHA-256: ${result.hash}`);
  return result.fileId;
}

function criarArquivoXlsx_(sheetName,fileName,templateName,headers,rows) {
  validarConfig_(['PASTA_TEMPLATES_ID','PASTA_SAIDA_ID']);
  validarArquiteturaDrive_(false);
  validarMatrizExportacao_(headers,rows,sheetName);
  const template=localizarArquivoUnico_(config_('PASTA_TEMPLATES_ID'),templateName); const templateBlob=template.getBlob(); const templateHash=sha256_(templateBlob.getBytes());
  let tempId='';
  try {
    const converted=Drive.Files.create({name:`__TMP_PPN_TEMPLATE_${Date.now()}`,mimeType:MimeType.GOOGLE_SHEETS},templateBlob,{fields:'id'}); tempId=converted.id;
    const temp=SpreadsheetApp.openById(tempId); const sh=temp.getSheets()[0];
    prepararCopiaTemplate_(sh,templateName,headers,rows);
    SpreadsheetApp.flush(); Utilities.sleep(1000);
    const response=UrlFetchApp.fetch(`https://docs.google.com/spreadsheets/d/${tempId}/export?format=xlsx`,{headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});
    if (response.getResponseCode()!==200) throw new Error(`Falha ao exportar XLSX: HTTP ${response.getResponseCode()}`);
    const blob=response.getBlob().setName(fileName); const file=DriveApp.getFolderById(config_('PASTA_SAIDA_ID')).createFile(blob); const hash=sha256_(blob.getBytes());
    log_('EXPORTAR_XLSX',file.getId(),sheetName,'SUCESSO',`${fileName}; template=${templateName}; templateId=${template.getId()}; templateSHA-256=${templateHash}; registros=${rows.length}; SHA-256=${hash}`,'',1);
    return{fileId:file.getId(),fileName,hash,rows:rows.length};
  } finally { if(tempId)DriveApp.getFileById(tempId).setTrashed(true); }
}

function prepararCopiaTemplate_(sheet,templateName,headers,rows){
  const lastCol=Math.max(sheet.getLastColumn(),headers.length); const actual=sheet.getRange(1,1,1,lastCol).getDisplayValues()[0];
  const expected=headers.map(v=>String(v)); const received=actual.slice(0,expected.length).map(v=>String(v));
  if(received.length!==expected.length)throw new Error(`Template ${templateName} possui ${received.length} colunas; esperado ${expected.length}.`);
  const mismatch=expected.findIndex((h,i)=>received[i]!==h); if(mismatch>=0)throw new Error(`Template ${templateName} inválido na coluna ${mismatch+1}: esperado "${expected[mismatch]}", encontrado "${received[mismatch]}".`);
  const extras=actual.slice(expected.length).filter(v=>texto_(v)!==''); if(extras.length)throw new Error(`Template ${templateName} contém cabeçalhos extras após a coluna ${expected.length}. Operação bloqueada.`);
  garantirGrade_(sheet,rows.length+1,headers.length);
  const dataRows=Math.max(sheet.getLastRow()-1,rows.length); if(dataRows>0)for(let col=1;col<=headers.length;col++)sheet.getRange(2,col,dataRows,1).clearContent();
  formatarMatrizComoTextoAntes_(sheet,2,rows.length,headers.length);
  escreverEmBlocos_(sheet,2,rows,250);
  if(rows.length)for(let col=1;col<=headers.length;col++)sheet.getRange(2,col,rows.length,1).setNumberFormat('@');
  SpreadsheetApp.flush(); validarIdentificadoresCopia_(sheet,headers,rows.length,templateName);
  sheet.setFrozenRows(1);
  const finalHeaders=sheet.getRange(1,1,1,headers.length).getDisplayValues()[0]; const finalMismatch=headers.findIndex((h,i)=>finalHeaders[i]!==h);
  if(finalMismatch>=0)throw new Error(`Cabeçalho do template foi alterado durante a preparação: coluna ${finalMismatch+1}.`);
}

function validarIdentificadoresCopia_(sheet,headers,totalRows,nome){
  if(totalRows<=0)return true;
  const regras=[
    {nomes:['CPF/CNPJ','CNPJREMETENTE','CPFCNPJREMETENTE','CNPJCPFDESTINATARIO','CPFCNPJDESTINATARIO'],tamanhos:[11,14]},
    {nomes:['CEP','CEPREMETENTE','CEPDESTINATARIO'],tamanhos:[8]},
  ];
  const normalizados=headers.map(normalizarCabecalho_);
  regras.forEach(regra=>regra.nomes.forEach(cabecalho=>{
    const col=normalizados.indexOf(normalizarCabecalho_(cabecalho)); if(col<0)return;
    const valores=sheet.getRange(2,col+1,totalRows,1).getDisplayValues();
    valores.forEach((linha,i)=>{const tamanho=digitos_(linha[0]).length;if(!regra.tamanhos.includes(tamanho))throw new Error(`Exportação bloqueada em ${nome}: coluna ${headers[col]}, linha ${i+2}, possui ${tamanho} dígitos; esperado ${regra.tamanhos.join(' ou ')}. Reimporte as fontes antes de gerar o XLSX.`);});
  }));
  return true;
}

function validarMatrizExportacao_(headers,rows,name){
  if(!headers.length)throw new Error(`Layout vazio para ${name}.`);
  const duplicates=headers.filter((h,i)=>headers.indexOf(h)!==i); if(duplicates.length)throw new Error(`Layout ${name} contém cabeçalhos duplicados: ${[...new Set(duplicates)].join(', ')}`);
  rows.forEach((row,i)=>{if(row.length!==headers.length)throw new Error(`Linha ${i+2} de ${name} possui ${row.length} colunas; esperado ${headers.length}.`);});
}

function validarArquiteturaDrive(){return validarArquiteturaDrive_(true);}

function validarArquiteturaDrive_(showAlert){
  validarConfig_(['PASTA_PROJETO_ID','PASTA_ENTRADA_ID','PASTA_TEMPLATES_ID','PASTA_SAIDA_ID','PASTA_CHECKPOINTS_ID']);
  const configured={
    PROJECT:texto_(config_('PASTA_PROJETO_ID')),INPUT:texto_(config_('PASTA_ENTRADA_ID')),TEMPLATES:texto_(config_('PASTA_TEMPLATES_ID')),OUTPUT:texto_(config_('PASTA_SAIDA_ID')),CHECKPOINTS:texto_(config_('PASTA_CHECKPOINTS_ID')),
  };
  const ids=Object.values(configured); if(new Set(ids).size!==ids.length)throw new Error('Arquitetura inválida: os cinco IDs de pastas devem ser distintos.');
  const project=DriveApp.getFolderById(configured.PROJECT); if(project.getName()!==PPN_DRIVE.PROJECT.name)throw new Error(`PASTA_PROJETO_ID aponta para "${project.getName()}"; esperado "${PPN_DRIVE.PROJECT.name}".`);
  validarSubpastaDireta_(configured.INPUT,configured.PROJECT,PPN_DRIVE.INPUT.name);
  validarSubpastaDireta_(configured.TEMPLATES,configured.PROJECT,PPN_DRIVE.TEMPLATES.name);
  validarSubpastaDireta_(configured.OUTPUT,configured.PROJECT,PPN_DRIVE.OUTPUT.name);
  validarSubpastaDireta_(configured.CHECKPOINTS,configured.PROJECT,PPN_DRIVE.CHECKPOINTS.name);
  const ss=SpreadsheetApp.getActive(); if(ss.getName()!==PPN_FILES.ORCHESTRATOR)throw new Error(`Planilha vinculada com nome inválido: "${ss.getName()}"; esperado "${PPN_FILES.ORCHESTRATOR}".`);
  const spreadsheetFile=DriveApp.getFileById(ss.getId()); if(!possuiPai_(spreadsheetFile,configured.PROJECT))throw new Error(`A planilha ${PPN_FILES.ORCHESTRATOR} deve estar diretamente na raiz de ${PPN_DRIVE.PROJECT.name}.`);
  localizarArquivoUnico_(configured.INPUT,PPN_FILES.INPUT_PF); localizarArquivoUnico_(configured.INPUT,PPN_FILES.INPUT_PJ);
  localizarArquivoUnico_(configured.TEMPLATES,PPN_FILES.TEMPLATE_DEST); localizarArquivoUnico_(configured.TEMPLATES,PPN_FILES.TEMPLATE_REM); localizarArquivoUnico_(configured.TEMPLATES,PPN_FILES.TEMPLATE_SIMPLE); localizarArquivoUnico_(configured.TEMPLATES,PPN_FILES.TEMPLATE_REGISTERED);
  const summary='Projeto Correios validado: orquestrador na raiz, 2 entradas, 4 templates e destinos exclusivos de saída/checkpoint.';
  log_('VALIDAR_ARQUITETURA_DRIVE','', '', 'SUCESSO',summary,'',1); if(showAlert)SpreadsheetApp.getUi().alert(summary); return summary;
}

function validarSubpastaDireta_(folderId,projectId,expectedName){
  const folder=DriveApp.getFolderById(folderId); if(folder.getName()!==expectedName)throw new Error(`Pasta inválida para ${expectedName}: encontrado "${folder.getName()}".`);
  if(!possuiPai_(folder,projectId))throw new Error(`A pasta ${expectedName} não está diretamente sob ${PPN_DRIVE.PROJECT.name}.`);
  return folder;
}

function possuiPai_(driveItem,parentId){const parents=driveItem.getParents();while(parents.hasNext())if(parents.next().getId()===parentId)return true;return false;}

function localizarArquivoUnico_(folderId,nome){
  const folder=DriveApp.getFolderById(folderId); const files=folder.getFilesByName(nome);
  if(!files.hasNext())throw new Error(`Arquivo obrigatório não encontrado em ${folder.getName()}: ${nome}`);
  const file=files.next(); if(files.hasNext())throw new Error(`Mais de um arquivo chamado "${nome}" foi encontrado em ${folder.getName()}. Operação bloqueada para evitar ambiguidade.`);
  return file;
}

function migrarConfigPastasV150_(){
  const sheet=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.CONFIG); const values=sheet.getDataRange().getValues();
  const headerIndex=values.findIndex(row=>row.map(normalizarCabecalho_).includes('PARAMETRO')); if(headerIndex<0)throw new Error('Cabeçalho PARAMETRO não encontrado em CONFIG_AUTOMACAO.');
  const headers=values[headerIndex].map(normalizarCabecalho_); const idx=indice_(headers);
  const hasProject=values.slice(headerIndex+1).some(r=>normalizarCabecalho_(r[idx.PARAMETRO])==='PASTA_PROJETO_ID'); if(hasProject)return false;
  const descriptions={PASTA_PROJETO_ID:'Raiz institucional do Projeto Correios',PASTA_ENTRADA_ID:'Somente leitura dos dois XLSX AR Digital',PASTA_TEMPLATES_ID:'Modelos oficiais protegidos; nunca sobrescrever',PASTA_SAIDA_ID:'Somente XLSX gerados para homologação/produção',PASTA_CHECKPOINTS_ID:'Somente cópias de segurança da planilha orquestradora'};
  const rowByKey=new Map(); values.slice(headerIndex+1).forEach((r,i)=>{const key=normalizarCabecalho_(r[idx.PARAMETRO]);if(key)rowByKey.set(key,headerIndex+i+2);});
  Object.values(PPN_DRIVE).forEach(item=>{
    const row=[item.key,item.id,'SIM',descriptions[item.key]]; const sheetRow=rowByKey.get(item.key);
    if(sheetRow)sheet.getRange(sheetRow,1,1,4).setValues([row]); else sheet.appendRow(row);
  });
  log_('MIGRAR_CONFIG_V150','', '', 'SUCESSO','IDs de entrada/saída migrados e pastas projeto/templates/checkpoints adicionadas','',1); return true;
}

function preencherConfigPadrao_() {
  const sheet=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.CONFIG);
  const current=dados_(PPN.SHEETS.CONFIG); const existing=new Set(current.rows.map(r=>normalizarCabecalho_(r[0])));
  const defaults=[
    ['AMBIENTE','HOMOLOG','SIM','HOMOLOG ou PRODUCAO'],['PASTA_PROJETO_ID',PPN_DRIVE.PROJECT.id,'SIM','Raiz institucional do Projeto Correios'],['PASTA_ENTRADA_ID',PPN_DRIVE.INPUT.id,'SIM','Somente leitura dos dois XLSX AR Digital'],['PASTA_TEMPLATES_ID',PPN_DRIVE.TEMPLATES.id,'SIM','Modelos oficiais protegidos; nunca sobrescrever'],['PASTA_SAIDA_ID',PPN_DRIVE.OUTPUT.id,'SIM','Somente XLSX gerados para homologação/produção'],['PASTA_CHECKPOINTS_ID',PPN_DRIVE.CHECKPOINTS.id,'SIM','Somente cópias de segurança da planilha orquestradora'],['NUMERO_CONTRATO','','SIM','Contrato Correios'],['DR','','SIM','Superintendência Estadual'],['CARTAO_POSTAGEM','','SIM','Cartão habilitado'],['MALOTE','','SIM','S ou N, conforme perfil'],['BATCH_CEP',50,'SIM','CEPs por execução, máximo 100'],['VALIDADE_CACHE_DIAS',30,'SIM','Prazo de reutilização de CEP OK'],['CODIGO_SERVICO','','CONDICIONAL','Serviço do objeto simples'],['SERVICO_ADICIONAL_1','','NÃO','Código adicional, por exemplo AR, somente se habilitado'],['SERVICO_ADICIONAL_2','','NÃO','Código adicional'],['SERVICO_ADICIONAL_3','','NÃO','Código adicional'],['SERVICO_ADICIONAL_4','','NÃO','Código adicional'],['SERVICO_ADICIONAL_5','','NÃO','Código adicional'],['VALOR_DECLARADO','','NÃO','Somente quando aplicável'],['PESO_GRAMAS','','CONDICIONAL','Peso real do objeto'],['DATA_PREVISTA_POSTAGEM','','CONDICIONAL','Data do lote'],['REMETENTE_NOME','','CONDICIONAL','Cadastro mestre'],['REMETENTE_CEP','','CONDICIONAL','8 dígitos'],['REMETENTE_LOGRADOURO','','CONDICIONAL','Cadastro mestre'],['REMETENTE_NUMERO','','CONDICIONAL','Cadastro mestre'],['REMETENTE_COMPLEMENTO','','NÃO','Cadastro mestre'],['REMETENTE_BAIRRO','','CONDICIONAL','Cadastro mestre'],['REMETENTE_CIDADE','','CONDICIONAL','Cadastro mestre'],['REMETENTE_UF','','CONDICIONAL','2 letras'],['REMETENTE_CPF_CNPJ','','CONDICIONAL','Somente dígitos'],['REMETENTE_TELEFONE','','NÃO','DDD + telefone'],['REMETENTE_CELULAR','','NÃO','DDD + celular do remetente'],['REMETENTE_EMAIL','','NÃO','Cadastro mestre'],['REMETENTE_OBSERVACAO','','NÃO','Observação institucional do remetente'],
    ['OBJ_REG_MODO_LOTE','CONTROLADO','SIM','CONTROLADO limita o ensaio; COMPLETO exige aceite formal'],['OBJ_REG_LIMITE_LOTE','20','CONDICIONAL','Inteiro de 1 a 20 quando o modo for CONTROLADO'],['OBJ_REG_ARQUIVO_REFERENCIA','','NÃO','JSON anterior cujo manifesto fixa as mesmas chaves do reensaio'],['OBJ_REG_CODIGO_SERVICO','','SIM','Código do serviço registrado contratado; não copiar do exemplo'],['OBJ_REG_USAR_AR','SIM','SIM','SIM ou NAO; controla o AR por lote'],['OBJ_REG_CODIGO_AR','','CONDICIONAL','Código adicional AR/AR Digital confirmado no contrato'],['OBJ_REG_ADICIONAL_2','','NÃO','Segundo serviço adicional contratado'],['OBJ_REG_ADICIONAL_3','','NÃO','Terceiro serviço adicional contratado'],['OBJ_REG_DATA_PREVISTA_POSTAGEM','','CONDICIONAL','dd/MM/aaaa; exclusivo do objeto registrado'],['OBJ_REG_PRAZO_POSTAGEM','','CONDICIONAL','Preencher somente conforme schema autenticado/homologado'],['OBJ_REG_LOGISTICA_REVERSA','NAO','SIM','SIM ou NAO'],['OBJ_REG_DATA_VALIDADE_LOG_REVERSA','','CONDICIONAL','Obrigatória somente para logística reversa; omitida quando NAO'],['OBJ_REG_CODIGO_VALOR_DECLARADO','','CONDICIONAL','Serviço adicional de valor declarado; não confundir com declaração de conteúdo'],['OBJ_REG_VALOR_DECLARADO','','CONDICIONAL','Valor do serviço adicional declarado; não usa VALOR_DECLARADO do objeto simples'],['OBJ_REG_CODIGO_ENTREGA_VIZINHO','','CONDICIONAL','Código contratado para entrega ao vizinho'],['OBJ_REG_ORIENTACAO_ENTREGA_VIZINHO','','CONDICIONAL','Orientação associada ao serviço'],['OBJ_REG_FORMATO','','SIM','Código de formato homologado pelos Correios'],['OBJ_REG_ALTURA','','CONDICIONAL','Dimensão informada; preencher com largura e comprimento'],['OBJ_REG_LARGURA','','CONDICIONAL','Dimensão informada; preencher com altura e comprimento'],['OBJ_REG_COMPRIMENTO','','CONDICIONAL','Dimensão informada; preencher com altura e largura'],['OBJ_REG_DIAMETRO','','NÃO','Somente quando aplicável ao formato'],['OBJ_REG_CIENTE_NAO_PROIBIDO','','SIM','Digite 1 ou SIM após declaração formal do responsável'],['OBJ_REG_OBSERVACAO','','NÃO','Observação única do lote'],['OBJ_REG_CONTEUDO_1','','SIM','Descrição única do conteúdo do lote'],['OBJ_REG_CONTEUDO_QTD_1','','SIM','Quantidade do conteúdo 1'],['OBJ_REG_CONTEUDO_VALOR_1','','SIM','Valor unitário do conteúdo 1'],['OBJ_REG_LAYOUT_HOMOLOGADO','NAO','SIM','Produção e lote completo só são liberados após aceite formal dos Correios']
  ].filter(r=>!existing.has(normalizarCabecalho_(r[0])));
  if (defaults.length) sheet.getRange(sheet.getLastRow()+1,1,defaults.length,4).setValues(defaults);
}

function migrarConfigObjetoRegistradoV170_(){
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.CONFIG); const data=dados_(PPN.SHEETS.CONFIG); const c=indice_(data.headers);
  const regras={
    OBJ_REG_FORMATO:['SIM','Use somente 1=envelope, 2=caixa/pacote ou 3=rolo/cilindro'],
    OBJ_REG_DIAMETRO:['NÃO','Somente para formato 3=rolo/cilindro'],
    OBJ_REG_CONTEUDO_1:['SIM','Descrição real do conteúdo; mínimo 5 caracteres'],
    OBJ_REG_CONTEUDO_QTD_1:['SIM','Quantidade real do conteúdo; maior que zero'],
    OBJ_REG_CONTEUDO_VALOR_1:['SIM','Valor unitário real do conteúdo; zero ou maior']
  };
  data.rows.forEach((row,i)=>{const key=normalizarCabecalho_(row[c.PARAMETRO]);if(!regras[key])return;sh.getRange(data.headerRow+i+1,3,1,2).setValues([regras[key]]);});
}

function atualizarValoresConfig_(valores){
  const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.CONFIG); const data=dados_(PPN.SHEETS.CONFIG); const c=indice_(data.headers);
  const linhas=new Map(); data.rows.forEach((row,i)=>linhas.set(normalizarCabecalho_(row[c.PARAMETRO]),data.headerRow+i+1));
  const ausentes=Object.keys(valores).filter(key=>!linhas.has(normalizarCabecalho_(key)));
  if(ausentes.length)throw new Error('Execute Instalar/validar estrutura antes de preparar o ensaio. Parâmetros ausentes: '+ausentes.join(', '));
  Object.keys(valores).forEach(key=>{
    const row=linhas.get(normalizarCabecalho_(key)); const cell=sh.getRange(row,c.VALOR+1);
    cell.setNumberFormat('@'); cell.setValue(String(valores[key]));
  });
  SpreadsheetApp.flush();
  return true;
}

function validarConfigObjetoSimples_(){
  const errors=[]; const cep=digitos_(config_('REMETENTE_CEP')); const uf=texto_(config_('REMETENTE_UF')).toUpperCase(); const doc=digitos_(config_('REMETENTE_CPF_CNPJ')); const peso=Number(config_('PESO_GRAMAS'));
  if(cep.length!==8)errors.push('CEP do remetente deve ter 8 dígitos');
  if(uf.length!==2)errors.push('UF do remetente deve ter 2 letras');
  if(!((doc.length===11&&cpfValido_(doc))||(doc.length===14&&cnpjValido_(doc))))errors.push('CPF/CNPJ do remetente inválido');
  if(!Number.isFinite(peso)||peso<=0)errors.push('Peso deve ser numérico e maior que zero');
  if(!digitos_(config_('CODIGO_SERVICO')))errors.push('Código de serviço inválido');
  const date=dataPpn_(config_('DATA_PREVISTA_POSTAGEM')); if(!date)errors.push('Data prevista deve estar em dd/MM/aaaa');
  if(errors.length)throw new Error('Configuração do objeto simples inválida: '+errors.join('; '));
  return date;
}

function dataPpn_(value){
  if(Object.prototype.toString.call(value)==='[object Date]'&&!isNaN(value))return Utilities.formatDate(value,Session.getScriptTimeZone(),'dd/MM/yyyy');
  const s=texto_(value); let m=s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if(m)return s;
  m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?`${m[3]}/${m[2]}/${m[1]}`:'';
}

function atualizarCabecalhosGerenciados_(sheet,headers){
  if(!sheet)throw new Error('Aba gerenciada não localizada.');
  const atual=sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getDisplayValues()[0]; const usados=atual.map(texto_); while(usados.length&&!usados[usados.length-1])usados.pop();
  const mismatch=usados.findIndex((h,i)=>i>=headers.length||normalizarCabecalho_(h)!==normalizarCabecalho_(headers[i]));
  if(mismatch>=0)throw new Error(`Aba ${sheet.getName()} possui cabeçalho incompatível na coluna ${mismatch+1}. Operação bloqueada para preservar os dados.`);
  garantirGrade_(sheet,Math.max(sheet.getMaxRows(),1),headers.length); sheet.getRange(1,1,1,headers.length).setValues([headers]); return true;
}

function garantirAba_(ss,name,headers) { let sh=ss.getSheetByName(name); if(!sh) sh=ss.insertSheet(name); garantirGrade_(sh,1,headers.length); if(sh.getLastRow()===0 || sh.getRange(1,1,1,headers.length).getDisplayValues()[0].every(v=>!v)) sh.getRange(1,1,1,headers.length).setValues([headers]); return sh; }
function desmesclarAreaDados_(sheet,minCols){
  const rows=Math.max(sheet.getLastRow(),1); const cols=Math.max(sheet.getLastColumn(),minCols||1);
  sheet.getRange(1,1,rows,cols).breakApart();
}
function prepararAbaDados_(sheet,headers){
  desmesclarAreaDados_(sheet,headers.length);
  sheet.clearContents();
  sheet.getRange(1,1,1,headers.length).setValues([headers]);
}
function validarCabecalhosLeitura_(actual,required,name){
  const set=new Set(actual.map(normalizarCabecalho_)); const missing=required.map(normalizarCabecalho_).filter(h=>!set.has(h));
  if(missing.length)throw new Error(`Estrutura inválida na aba ${name}: cabeçalhos ausentes: ${missing.join(', ')}. Execute “1. Instalar/validar estrutura” com a versão 1.7.0 e reimporte.`);
}
function formatarColunasTextoAntes_(sheet,startRow,totalRows,columns){
  if(!sheet||totalRows<=0||!columns.length)return;
  garantirGrade_(sheet,startRow+totalRows-1,Math.max(...columns));
  columns.forEach(col=>sheet.getRange(startRow,col,totalRows,1).setNumberFormat('@'));
}
function formatarMatrizComoTextoAntes_(sheet,startRow,totalRows,totalCols){
  if(!sheet||totalRows<=0||totalCols<=0)return;
  garantirGrade_(sheet,startRow+totalRows-1,totalCols); sheet.getRange(startRow,1,totalRows,totalCols).setNumberFormat('@');
}
function garantirGrade_(sheet,rows,cols){
  if(sheet.getMaxRows()<rows)sheet.insertRowsAfter(sheet.getMaxRows(),rows-sheet.getMaxRows());
  if(sheet.getMaxColumns()<cols)sheet.insertColumnsAfter(sheet.getMaxColumns(),cols-sheet.getMaxColumns());
}
function formatarTextoPorColuna_(sheet,rows,cols){
  for(let col=1;col<=cols;col++)sheet.getRange(1,col,rows,1).setNumberFormat('@');
}
function estilizarEstrutura_(){ Object.values(PPN.SHEETS).forEach(name=>{const sh=SpreadsheetApp.getActive().getSheetByName(name); if(!sh)return; const cols=sh.getLastColumn(); if(cols){sh.getRange(1,1,1,cols).setBackground('#0F5D50').setFontColor('#FFFFFF').setFontWeight('bold').setWrap(true); sh.setFrozenRows(1); sh.getDataRange().setVerticalAlignment('middle');}}); }
function validarCabecalhos_(actual,expected,name){const set=new Set(actual.map(normalizarCabecalho_)); const missing=expected.map(normalizarCabecalho_).filter(h=>!set.has(h)); if(missing.length)throw new Error(`Cabeçalhos ausentes em ${name}: ${missing.join(', ')}`);}
function dados_(name){
  const sh=SpreadsheetApp.getActive().getSheetByName(name);
  if(!sh)return{headers:[],rows:[],headerRow:1};
  const values=sh.getDataRange().getValues();
  const markerBySheet={
    [PPN.SHEETS.CONFIG]:'PARAMETRO',[PPN.SHEETS.PF]:'CODIGO',[PPN.SHEETS.PJ]:'CODIGO',
    [PPN.SHEETS.BASE]:'CHAVE',[PPN.SHEETS.CACHE]:'CEP',[PPN.SHEETS.EXC]:'CHAVE',[PPN.SHEETS.PREVIEW]:'CARTAO_POSTAGEM',
    [PPN.SHEETS.EXPORT_DEST]:'CARTAO_POSTAGEM',[PPN.SHEETS.EXPORT_DEST_PF]:'CARTAO_POSTAGEM',[PPN.SHEETS.EXPORT_DEST_PJ]:'CARTAO_POSTAGEM',[PPN.SHEETS.EXPORT_SIMPLE]:'SEQUENCIAL',[PPN.SHEETS.EXPORT_SIMPLE_PF]:'SEQUENCIAL',[PPN.SHEETS.EXPORT_SIMPLE_PJ]:'SEQUENCIAL',[PPN.SHEETS.EXPORT_REGISTERED_PF]:'SEQUENCIAL',[PPN.SHEETS.EXPORT_REGISTERED_PJ]:'SEQUENCIAL',[PPN.SHEETS.IMPORT_CHECKLIST]:'LOTE',[PPN.SHEETS.RETURNS]:'ID_RETORNO',[PPN.SHEETS.VERIFIED]:'ID_EXPORTACAO',[PPN.SHEETS.LOG]:'TIMESTAMP'
  };
  const marker=markerBySheet[name];
  const headerIndex=values.findIndex(row=>row.map(normalizarCabecalho_).includes(marker));
  if(headerIndex<0)throw new Error(`Cabeçalho não encontrado na aba ${name}: esperado ${marker}.`);
  return{
    headers:values[headerIndex].map(normalizarCabecalho_),
    rows:values.slice(headerIndex+1).filter(r=>r.some(v=>v!==''&&v!==null)),
    headerRow:headerIndex+1
  };
}
function indice_(headers){return Object.fromEntries(headers.map((h,i)=>[normalizarCabecalho_(h),i]));}
function normalizarCabecalho_(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toUpperCase();}
function texto_(v){return String(v??'').trim().replace(/\s+/g,' ');}
function digitos_(v){return String(v??'').replace(/\D/g,'');}
function identificador_(v,len){const d=digitos_(v); return d ? d.padStart(len,'0') : '';}
function telefone_(v){const d=digitos_(v); return d.length>=10&&d.length<=11&&!/^(\d)\1+$/.test(d)?d:'';}
function telefoneExport_(v){return telefone_(v);}
function cpfValido_(cpf){cpf=digitos_(cpf);if(cpf.length!==11||/^(\d)\1+$/.test(cpf))return false;let s=0;for(let i=0;i<9;i++)s+=Number(cpf[i])*(10-i);let d1=s*10%11;if(d1===10)d1=0;if(d1!==Number(cpf[9]))return false;s=0;for(let i=0;i<10;i++)s+=Number(cpf[i])*(11-i);let d2=s*10%11;if(d2===10)d2=0;return d2===Number(cpf[10]);}
function cnpjValido_(cnpj){cnpj=digitos_(cnpj);if(cnpj.length!==14||/^(\d)\1+$/.test(cnpj))return false;const calc=(base,w)=>{const rem=base.split('').reduce((a,n,i)=>a+Number(n)*w[i],0)%11;return rem<2?0:11-rem;};const d1=calc(cnpj.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2]);const d2=calc(cnpj.slice(0,12)+d1,[6,5,4,3,2,9,8,7,6,5,4,3,2]);return cnpj.endsWith(`${d1}${d2}`);}
function config_(key){const data=dados_(PPN.SHEETS.CONFIG);const idx=indice_(data.headers);const row=data.rows.find(r=>String(r[idx.PARAMETRO]).toUpperCase()===key);return row?row[idx.VALOR]:'';}
function validarConfig_(keys){const missing=keys.filter(k=>texto_(config_(k))==='');if(missing.length)throw new Error('Configuração pendente: '+missing.join(', '));}
function ambiente_(){return String(config_('AMBIENTE')).toUpperCase().startsWith('PROD')?'PRODUCAO':'HOMOLOG';}
function escreverEmBlocos_(sheet,startRow,rows,size){for(let i=0;i<rows.length;i+=size){const block=rows.slice(i,i+size);sheet.getRange(startRow+i,1,block.length,block[0].length).setValues(block);}}
function checkpoint_(label){
  validarConfig_(['PASTA_PROJETO_ID','PASTA_CHECKPOINTS_ID']);
  const ss=SpreadsheetApp.getActive(); const projectId=texto_(config_('PASTA_PROJETO_ID')); const folderId=texto_(config_('PASTA_CHECKPOINTS_ID'));
  const project=DriveApp.getFolderById(projectId); if(project.getName()!==PPN_DRIVE.PROJECT.name)throw new Error(`PASTA_PROJETO_ID aponta para "${project.getName()}"; esperado "${PPN_DRIVE.PROJECT.name}".`);
  const folder=validarSubpastaDireta_(folderId,projectId,PPN_DRIVE.CHECKPOINTS.name);
  DriveApp.getFileById(ss.getId()).makeCopy(`CHECKPOINT_${label}_${carimbo_()}`,folder);
}
function removerTriggers_(handler){ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===handler).forEach(t=>ScriptApp.deleteTrigger(t));}
function upsertCache_(sheet,map,record){const key=record[0];const old=map.get(key);if(old){formatarColunasTextoAntes_(sheet,old.sheetRow,1,[1]);sheet.getRange(old.sheetRow,1,1,record.length).setValues([record]);old.row=record;}else{const row=sheet.getLastRow()+1;formatarColunasTextoAntes_(sheet,row,1,[1]);sheet.getRange(row,1,1,record.length).setValues([record]);map.set(key,{row:record,sheetRow:row});}}
function diasDepois_(days){return new Date(Date.now()+days*86400000);}
function carimbo_(){return Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd_HHmmss');}
function sha256_(bytes){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes).map(b=>(b+256)%256).map(b=>b.toString(16).padStart(2,'0')).join('');}
function resumirErro_(json,text){const msg=json&&(json.mensagem||json.message||json.erro);return texto_(msg||text).slice(0,500);}
function log_(op,item,http,result,message,duration,attempt){const sh=SpreadsheetApp.getActive().getSheetByName(PPN.SHEETS.LOG);if(!sh)return;sh.appendRow([new Date(),Utilities.getUuid(),op,item,http,result,message,duration,attempt,Session.getActiveUser().getEmail()]);}
