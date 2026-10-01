/**
 * SLICE-03C.2B1D — Registry server-side versionado dos templates da Campanha
 * PF. ZERO rede, ZERO banco, ZERO envio — fundação de GOVERNANÇA de conteúdo.
 *
 * Contratos normativos do gate:
 *   · cada entrada contém templateId, versão IMUTÁVEL, escopo, status,
 *     assunto, renderer texto, renderer HTML, data mode, metadados públicos
 *     seguros e hash determinístico da definição;
 *   · DRAFT: preview permitido, ENVIO proibido;
 *   · APPROVED: selecionável somente no escopo autorizado;
 *   · RETIRED: renderizável para HISTÓRICO, nunca selecionável para campanha
 *     nova;
 *   · alterar conteúdo significa criar NOVA versão (nunca editar sob o mesmo
 *     identificador); versão existente NUNCA muda silenciosamente (hash
 *     determinístico + regressões douradas de conteúdo);
 *   · o provider resolve pela versão PERSISTIDA (congelada) — request não
 *     fornece HTML, texto, subject, remetente nem versão arbitrária;
 *   · versão desconhecida/DRAFT/incompatível falha de forma SANITIZADA e
 *     ANTES do claim (gate em apps/api/src/campaign-execution.ts);
 *   · "editar template" = nova versão → revisão → testes → CI → aprovação.
 *     NÃO existe editor livre em runtime.
 *
 * Este módulo é PURO (sem I/O); o ownership de HTTP/DB permanece em apps/api.
 * Templates NUNCA importam módulos do piloto (segregação provada em teste).
 */

import { createHash } from "node:crypto";
import type { OutboundMail } from "../domain/message.js";
import {
  PF_UPDATE_CAMPAIGN_SUBJECT,
  PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION,
  renderPfUpdateCampaignMail,
} from "./pf-update-campaign.js";

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/** Identidade institucional do template (versão ≠ identidade). */
export type TemplateIdCampanha = "PF_EXPEDICAO_CARTEIRA";

/** Estados do ciclo de vida. Alterar status cria NOVA versão. */
export type TemplateStatus = "DRAFT" | "APPROVED" | "RETIRED";

/**
 * Modo de dados autoritativo do snapshot da campanha.
 * · RESPONSE_FORM (v1 histórica, RETIRED): campos de exibição VAZIOS para
 *   preenchimento pelo profissional.
 * · PREFILLED_CONFIRMATION (v2 APPROVED, contrato terminal do owner GF-2):
 *   campos de exibição PRÉ-PREENCHIDOS a partir do snapshot congelado
 *   (pipeline XLSX → normalização → snapshot JSONB → renderer). Ausente ⇒
 *   "Não informado". WhatsApp NUNCA é inferido; CPF NUNCA é renderizado.
 */
export type TemplateDataMode = "RESPONSE_FORM" | "PREFILLED_CONFIRMATION";

/** Escopo institucional autorizado para campanhas novas. */
export const TEMPLATE_SCOPE_PF_CAMPAIGN = "PF_CAMPAIGN" as const;
export type TemplateScope = typeof TEMPLATE_SCOPE_PF_CAMPAIGN;

/** Motivos de rejeição — SEMPRE sanitizados (sem stack, sem I/O). */
export type TemplateErrorCode =
  | "CAMPAIGN_TEMPLATE_UNSUPPORTED"
  | "CAMPAIGN_TEMPLATE_NOT_APPROVED"
  | "CAMPAIGN_TEMPLATE_SCOPE_MISMATCH";

/** Entrada de renderização — somente valores COMPROVADOS (sem PII extra). */
export interface RenderInputCampanha {
  /** Nome do profissional — ÚNICO campo do snapshot renderizável. */
  readonly professionalName: string;
  /** Protocolo de correlação server-side (sem UUID/PII). */
  readonly correlationCode: string;
  /**
   * Campos de exibição (PREFILLED_CONFIRMATION) — oriundos EXCLUSIVAMENTE do
   * snapshot congelado e JÁ normalizados para apresentação (whitespace
   * sequencial → espaço único; trim; vazio ⇒ ausente ⇒ "Não informado").
   * O renderer NUNCA completa endereço, NUNCA aplica heurística de CEP,
   * NUNCA converte tipos, NUNCA remove S/N ou zeros significativos e NUNCA
   * infere WhatsApp a partir do telefone.
   */
  readonly exibicao?: {
    readonly logradouro?: string;
    readonly numero?: string;
    readonly complemento?: string;
    readonly bairro?: string;
    readonly cidade?: string;
    readonly uf?: string;
    readonly cep?: string;
    readonly telefone?: string;
  };
  /** Identidade institucional — SEMPRE injetada server-side. */
  readonly remetente: { readonly name: string; readonly address: string };
  /** Tag de domínio do Message-ID. */
  readonly messageTag?: string;
}

/** Entrada imutável do registry. */
export interface TemplateEntryCampanha {
  readonly templateId: TemplateIdCampanha;
  /** Versão imutável (nunca reutilizada com outro conteúdo). */
  readonly templateVersion: string;
  readonly scope: TemplateScope;
  readonly status: TemplateStatus;
  /** Assunto institucional (CRLF-safe por construção). */
  readonly subject: string;
  /** Renderer texto (puro). */
  readonly renderText: (input: RenderInputCampanha) => string;
  /** Renderer HTML (puro). */
  readonly renderHtml: (input: RenderInputCampanha) => string;
  readonly dataMode: TemplateDataMode;
  /** Metadados públicos seguros (sem PII, sem conteúdo sensível). */
  readonly publicMetadata: {
    readonly dataMode: TemplateDataMode;
    readonly dataModeReason: string;
  };
  /** Hash determinístico do CONTRATO de registro (inclui status). */
  readonly definitionHash: string;
  /** Definição textual estática (esqueleto canônico com placeholders). */
  readonly contentTextDefinition: string;
  /** Definição HTML estática (esqueleto canônico com placeholders). */
  readonly contentHtmlDefinition: string;
  /**
   * Hash canônico do CONTEÚDO (SHA-256 hex) — status-INDEPENDENTE (GF-2 F3).
   * Entrada: templateId, templateVersion, scope, dataMode, subject e as
   * definições textual/HTML estáticas. NUNCA inclui status, ordem incidental
   * de propriedades, Function.toString(), render sintético, Date/random,
   * environment, remetente de runtime nem SOURCE_ELIGIBILITY_MODEL.
   */
  readonly contentHash: string;
}

export type TemplateSelectionResult =
  | { readonly ok: true; readonly templateVersion: string }
  | { readonly ok: false; readonly code: TemplateErrorCode };

export type TemplateResolutionResult =
  | { readonly ok: true; readonly entry: TemplateEntryCampanha }
  | { readonly ok: false; readonly code: TemplateErrorCode };

/** Resultado do render outbound (mesma forma do template legado). */
export type TemplateRenderOutboundResult =
  | { readonly ok: true; readonly mensagem: OutboundMail }
  | { readonly ok: false; readonly code: TemplateErrorCode };

// ---------------------------------------------------------------------------
// Hash determinístico da definição
// ---------------------------------------------------------------------------

const HASH_LABEL = "integra-correios:template-registry:v1";

/**
 * Hash determinístico sobre o CONTRATO da definição, com ordem FIXA de
 * escrita (independente de ordem de chaves de objetos). Renderers são
 * excluídos por natureza (funções); a imutabilidade do CONTEÚDO renderizado
 * é garantida por revisão+CI e pelas regressões douradas de renderização.
 */
export function templateDefinitionHash(definition: {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly scope: string;
  readonly status: string;
  readonly subject: string;
  readonly dataMode: string;
}): string {
  return createHash("sha256")
    .update(HASH_LABEL)
    .update("\n")
    .update(`templateId=${definition.templateId}\n`)
    .update(`templateVersion=${definition.templateVersion}\n`)
    .update(`scope=${definition.scope}\n`)
    .update(`status=${definition.status}\n`)
    .update(`subject=${definition.subject}\n`)
    .update(`dataMode=${definition.dataMode}\n`)
    .digest("hex");
}

/**
 * Assunto é campo de HEADER: CRLF em qualquer ponto = rejeição fail-closed
 * (header injection). Exportado como contrato testável do registry.
 */
export function validarSubjectCrlfSafe(templateVersion: string, subject: string): void {
  if (subject.length === 0 || subject.length > 998 || /[\r\n]/.test(subject)) {
    throw new Error(`Assunto inválido para a versão ${templateVersion} (CRLF/tamanho).`);
  }
}

/** Constrói uma entrada com hashes derivados do próprio contrato (imutável). */
function registrarEntrada(
  entrada: Omit<TemplateEntryCampanha, "definitionHash" | "contentHash">,
): TemplateEntryCampanha {
  validarSubjectCrlfSafe(entrada.templateVersion, entrada.subject);
  return Object.freeze({
    ...entrada,
    // `definitionHash` = hash do CONTRATO de REGISTRO (registryDefinitionHash):
    // INCLUI status — muda quando o ciclo de vida muda. NÃO é hash de conteúdo.
    definitionHash: templateDefinitionHash({
      templateId: entrada.templateId,
      templateVersion: entrada.templateVersion,
      scope: entrada.scope,
      status: entrada.status,
      subject: entrada.subject,
      dataMode: entrada.dataMode,
    }),
    // `contentHash` = hash canônico do CONTEÚDO — status-INDEPENDENTE (F3).
    contentHash: templateContentHash({
      templateId: entrada.templateId,
      templateVersion: entrada.templateVersion,
      scope: entrada.scope,
      dataMode: entrada.dataMode,
      subject: entrada.subject,
      textDefinition: entrada.contentTextDefinition,
      htmlDefinition: entrada.contentHtmlDefinition,
    }),
  });
}

// ---------------------------------------------------------------------------
// Renderização — escape integral de valores dinâmicos
// ---------------------------------------------------------------------------

/** Escape HTML de TODO valor dinâmico (defesa contra injeção de markup). */
function escapeHtml(valor: string): string {
  return valor.replace(
    /[&<>"']/g,
    (caractere) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[caractere] ??
      caractere,
  );
}

function escapeHtmlMultilinha(valor: string): string {
  return escapeHtml(valor).replace(/\n/g, "<br />");
}

/** Valor canônico para campo de exibição ausente/vazio (PREFILLED). */
const CAMPO_NAO_INFORMADO = "Não informado" as const;

/**
 * Normalização de APRESENTAÇÃO (contrato do owner): CR/LF/TAB e whitespace
 * sequencial → espaço único; trim; vazio ⇒ undefined (renderiza como
 * "Não informado"). Preserva o valor SEMÂNTICO: sem completar endereço,
 * sem heurística de CEP, sem conversão numérica, sem remover S/N ou zeros
 * significativos. Exportado como contrato testável do registry.
 */
export function campoExibicao(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined;
  const compactado = valor.replace(/\s+/g, " ").trim();
  return compactado === "" ? undefined : compactado;
}

/**
 * Converte a linha "Nome Completo: X" do corpo em <strong> no HTML,
 * mantendo equivalência semântica com o texto (mesmos campos, mesma ordem).
 */
function nomeHtmlDoTexto(textBody: string): string {
  const linha = textBody.split("\n").find((l) => l.startsWith("Nome Completo: "));
  const valor = linha?.slice("Nome Completo: ".length) ?? "";
  return `<strong>${escapeHtml(valor)}</strong>`;
}

// ---------------------------------------------------------------------------
// v1 — preservada INTEGRALMENTE (delegação ao template legado)
// ---------------------------------------------------------------------------

const v1Renderer = (input: RenderInputCampanha): OutboundMail =>
  renderPfUpdateCampaignMail({
    campaignId: "historico",
    itemId: "historico",
    professionalId: "historico",
    recipient: "sem-destinatario@historico.invalid",
    professionalName: input.professionalName,
    correlationCode: input.correlationCode,
    remetente: { name: input.remetente.name, address: input.remetente.address },
    ...(input.messageTag === undefined ? {} : { messageTag: input.messageTag }),
  });

/**
 * GF-2 F3 — espelho EXATO das partes estáticas do renderer legado v1
 * (renderPfUpdateCampaignMail): únicos valores dinâmicos são nome e protocolo.
 * A imutabilidade byte a byte do render v1 é provada pelas regressões douradas;
 * esta definição estática é a ENTRADA do contentHash canônico.
 */
const TEMPLATE_V1_CAMPOS_RESPOSTA = [
  "Telefone/WhatsApp com DDD:",
  "CEP:",
  "Logradouro:",
  "Número:",
  "Complemento:",
  "Bairro:",
  "Cidade:",
  "UF:",
] as const;

function corpoV1Texto(nome: string, correlationCode: string): string {
  return [
    `Olá, ${nome}.`,
    "",
    "Para prepararmos o envio da sua Carteira Profissional, responda este",
    "e-mail preenchendo os campos abaixo:",
    "",
    ...TEMPLATE_V1_CAMPOS_RESPOSTA,
    "",
    `Protocolo: ${correlationCode}`,
    "",
    "Complemento é opcional. Nos demais campos, informe os dados completos;",
    "para Número, use S/N quando aplicável.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// v2 — APPROVED · PREFILLED_CONFIRMATION (contrato terminal do owner GF-2)
// ---------------------------------------------------------------------------

const TEMPLATE_V2_SUBJECT =
  "Campanha de Atualização Cadastral e Expedição da Carteira Profissional — CRTBA" as const;

const TEMPLATE_V2_ABERTURA_TEXTO = [
  "Prezado(a) profissional,",
  "",
  "Informamos que sua carteira profissional física do Conselho Regional dos",
  "Técnicos Industriais da Bahia (CRTBA) está pronta para envio.",
  "",
  "Para garantir a correta expedição do documento, solicitamos a conferência e",
  "confirmação dos seus dados cadastrais antes da emissão da ordem de postagem.",
] as const;

const TEMPLATE_V2_TITULO_CAMPOS = "Dados cadastrais para confirmação" as const;

const TEMPLATE_V2_PRAZO_TEXTO = [
  "Prazo de confirmação",
  "",
  "Pedimos que responda a esta mensagem ou atualize suas informações no",
  "SINCETI em até 5 (cinco) dias úteis, para inclusão no lote prioritário de",
  "envio.",
] as const;

const TEMPLATE_V2_CONDICIONAIS_TEXTO = [
  "Havendo divergência nos dados de endereçamento, a postagem poderá",
  "permanecer temporariamente pendente até a regularização cadastral.",
  "",
  "Após a postagem, as informações de rastreamento serão disponibilizadas",
  "pelos canais institucionais aplicáveis.",
] as const;

const TEMPLATE_V2_ENCERRAMENTO_TEXTO = [
  "Para orientações adicionais, acesse www.crtba.org.br ou utilize os canais",
  "oficiais de atendimento do CRT-BA.",
] as const;

const TEMPLATE_V2_AGRADECIMENTO_TEXTO =
  "Agradecemos sua colaboração para manter o cadastro atualizado e contribuir para a correta entrega do documento profissional." as const;

const TEMPLATE_V2_ASSINATURA_TEXTO = [
  "Atenciosamente,",
  "Conselho Regional dos Técnicos Industriais da Bahia — CRTBA",
] as const;

/** Linha "Cidade / UF" — combinação dos valores disponíveis (ou ausente). */
function cidadeUfV2Texto(exibicao: RenderInputCampanha["exibicao"]): string {
  const cidade = campoExibicao(exibicao?.cidade);
  const uf = campoExibicao(exibicao?.uf);
  if (cidade && uf) return `Cidade / UF: ${cidade} / ${uf}`;
  if (cidade) return `Cidade / UF: ${cidade}`;
  if (uf) return `Cidade / UF: ${uf}`;
  return `Cidade / UF: ${CAMPO_NAO_INFORMADO}`;
}

function corpoV2Texto(
  nome: string,
  correlationCode: string,
  exibicao: RenderInputCampanha["exibicao"],
): string {
  const campo = (rotulo: string, valor: string | undefined): string =>
    `${rotulo}: ${campoExibicao(valor) ?? CAMPO_NAO_INFORMADO}`;
  const partes: string[] = [
    ...TEMPLATE_V2_ABERTURA_TEXTO,
    "",
    TEMPLATE_V2_TITULO_CAMPOS,
    "",
    `Nome Completo: ${nome}`,
    campo("Logradouro / Endereço", exibicao?.logradouro),
    campo("Número", exibicao?.numero),
    campo("Complemento", exibicao?.complemento),
    campo("Bairro", exibicao?.bairro),
    cidadeUfV2Texto(exibicao),
    campo("CEP", exibicao?.cep),
    campo("Telefone Principal", exibicao?.telefone),
    // NUNCA inferir TELEFONE == WHATSAPP: o WhatsApp permanece campo de
    // confirmação na resposta (contrato explícito do owner).
    "WhatsApp Atualizado: informar/confirmar na resposta",
    "",
    ...TEMPLATE_V2_PRAZO_TEXTO,
    "",
    ...TEMPLATE_V2_CONDICIONAIS_TEXTO,
    "",
    ...TEMPLATE_V2_ENCERRAMENTO_TEXTO,
    "",
    `Protocolo: ${correlationCode}`,
    "",
    TEMPLATE_V2_AGRADECIMENTO_TEXTO,
    "",
    ...TEMPLATE_V2_ASSINATURA_TEXTO,
  ];
  return partes.join("\n");
}

function renderV2Texto(input: RenderInputCampanha): string {
  const nome = input.professionalName.trim();
  const correlationCode = input.correlationCode.trim();
  if (!nome) throw new Error("Nome de exibição é obrigatório");
  if (!correlationCode || /[\r\n]/.test(correlationCode)) {
    throw new Error("Código de correlação inválido");
  }
  // PREFILLED_CONFIRMATION: os campos de exibição vêm do snapshot congelado
  // (já normalizados na ingestion; renormalizados aqui por defesa). Ausentes
  // ⇒ "Não informado". Nenhum valor heurístico, lateral ou presumido é
  // renderizado; WhatsApp NUNCA é inferido; CPF NUNCA é renderizado.
  return corpoV2Texto(nome, correlationCode, input.exibicao);
}

function htmlFromTextoV2(texto: string, exibicao: RenderInputCampanha["exibicao"]): string {
  const linhas = texto.split("\n");
  const indiceTitulo = linhas.indexOf(TEMPLATE_V2_TITULO_CAMPOS);
  const indicePrazo = linhas.indexOf(TEMPLATE_V2_PRAZO_TEXTO[0]!);
  const indiceEncerramento = linhas.indexOf(TEMPLATE_V2_ENCERRAMENTO_TEXTO[0]!);
  if (indiceTitulo < 0 || indicePrazo < 0 || indiceEncerramento < 0) {
    throw new Error("Estrutura inesperada do corpo v2");
  }
  const linhaProtocolo = linhas.findIndex((l) => l.startsWith("Protocolo: "));
  if (linhaProtocolo < 0) throw new Error("Protocolo ausente do corpo v2");

  const abertura = linhas.slice(0, indiceTitulo).join("\n");
  const campos = linhas
    .slice(indiceTitulo + 2, indicePrazo - 1)
    .map((linha) => {
      if (linha.startsWith("Nome Completo: ")) {
        const valor = linha.slice("Nome Completo: ".length);
        return `<p><strong>Nome Completo:</strong> ${escapeHtml(valor)}</p>`;
      }
      return `<p>${escapeHtml(linha)}</p>`;
    })
    .join("");
  const prazo = linhas.slice(indicePrazo, indiceEncerramento - 1).join("\n");
  const condicionaisECanais = linhas.slice(indiceEncerramento, linhaProtocolo - 1).join("\n");
  const protocoloValor = (linhas[linhaProtocolo] ?? "").slice("Protocolo: ".length);
  const agradecimento = linhas.slice(linhaProtocolo + 2, -2).join("\n");
  const assinatura = linhas.slice(-2).join("\n");

  return [
    `<p>${escapeHtmlMultilinha(abertura)}</p>`,
    "<h3>Dados cadastrais para confirmação</h3>",
    campos,
    `<h4>${escapeHtml(TEMPLATE_V2_PRAZO_TEXTO[0]!)}</h4>`,
    `<p>${escapeHtmlMultilinha(prazo.split("\n").slice(2).join("\n"))}</p>`,
    `<p>${escapeHtmlMultilinha(condicionaisECanais)}</p>`,
    `<p><strong>Protocolo:</strong> ${escapeHtml(protocoloValor)}</p>`,
    `<p>${escapeHtml(agradecimento)}</p>`,
    `<p>${escapeHtmlMultilinha(assinatura)}</p>`,
  ].join("");
}

function renderV2Html(input: RenderInputCampanha): string {
  return htmlFromTextoV2(renderV2Texto(input), input.exibicao);
}

// ---------------------------------------------------------------------------
// contentHash CANÔNICO do conteúdo (OWNER GF-2 — FASE 3)
// ---------------------------------------------------------------------------

const CONTENT_HASH_LABEL = "integra-correios:template-content-hash:v1";

/** Placeholders canônicos das definições estáticas (nunca dados reais). */
const PLACEHOLDER_NOME_PROFISSIONAL = "{{NOME_PROFISSIONAL}}" as const;
const PLACEHOLDER_PROTOCOLO = "{{PROTOCOLO}}" as const;

/**
 * Hash canônico do CONTEÚDO — status-INDEPENDENTE. Entrada canônica (ordem
 * FIXA de escrita, independente de ordem de propriedades): templateId,
 * templateVersion, scope, dataMode, subject, definição textual estática e
 * definição HTML estática. NUNCA inclui: status, Function.toString(),
 * render sintético, Date/random, environment, remetente de runtime,
 * SOURCE_ELIGIBILITY_MODEL (decisão documental fora do conteúdo da mensagem).
 * Prova obrigatória: contentHash(v2 DRAFT) == contentHash(v2 APPROVED).
 */
export function templateContentHash(definition: {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly scope: string;
  readonly dataMode: string;
  readonly subject: string;
  readonly textDefinition: string;
  readonly htmlDefinition: string;
}): string {
  return createHash("sha256")
    .update(CONTENT_HASH_LABEL)
    .update("\n")
    .update(`templateId=${definition.templateId}\n`)
    .update(`templateVersion=${definition.templateVersion}\n`)
    .update(`scope=${definition.scope}\n`)
    .update(`dataMode=${definition.dataMode}\n`)
    .update(`subject=${definition.subject}\n`)
    .update(`textDefinition=${definition.textDefinition}\n`)
    .update(`htmlDefinition=${definition.htmlDefinition}\n`)
    .digest("hex");
}

// Definições estáticas — derivadas dos MESMOS compositores dos renderers de
// envio (zero duplicação de conteúdo): placeholders substituem os únicos
// valores dinâmicos (nome do profissional e protocolo).
const DEFINICAO_V1_TEXTO = corpoV1Texto(
  PLACEHOLDER_NOME_PROFISSIONAL,
  PLACEHOLDER_PROTOCOLO,
);
const DEFINICAO_V1_HTML = [
  `<p>Olá, <strong>${PLACEHOLDER_NOME_PROFISSIONAL}</strong>.</p>`,
  "<p>Para prepararmos o envio da sua Carteira Profissional, responda este e-mail preenchendo os campos abaixo:</p>",
  `<pre>${TEMPLATE_V1_CAMPOS_RESPOSTA.join("\n")}</pre>`,
  `<p><strong>Protocolo:</strong> ${PLACEHOLDER_PROTOCOLO}</p>`,
  "<p>Complemento é opcional. Nos demais campos, informe os dados completos; para Número, use S/N quando aplicável.</p>",
].join("");
const DEFINICAO_V2_TEXTO = corpoV2Texto(
  PLACEHOLDER_NOME_PROFISSIONAL,
  PLACEHOLDER_PROTOCOLO,
  undefined,
);
const DEFINICAO_V2_HTML = htmlFromTextoV2(DEFINICAO_V2_TEXTO, undefined);

// ---------------------------------------------------------------------------
// Entradas registradas (v1 RETIRED preservada; v2 APPROVED)
// ---------------------------------------------------------------------------

export const TEMPLATE_V1_VERSION = PF_UPDATE_CAMPAIGN_TEMPLATE_VERSION;
export const TEMPLATE_V2_VERSION = "pf-expedicao-carteira-2026-v2" as const;
export const TEMPLATE_V2_ID: TemplateIdCampanha = "PF_EXPEDICAO_CARTEIRA";

const templateV1 = registrarEntrada({
  templateId: "PF_EXPEDICAO_CARTEIRA",
  templateVersion: TEMPLATE_V1_VERSION,
  scope: TEMPLATE_SCOPE_PF_CAMPAIGN,
  // OWNER GF-2 — v1 histórica APOSENTADA (RETIRED): renderização HISTÓRICA
  // (auditoria/reconstrução) permanece permitida byte a byte; seleção para
  // campanha NOVA e envio NOVO bloqueados; NUNCA redirecionar silenciosamente
  // para v2 (V1_SILENT_REDIRECT_TO_V2=false).
  status: "RETIRED",
  subject: PF_UPDATE_CAMPAIGN_SUBJECT,
  contentTextDefinition: DEFINICAO_V1_TEXTO,
  contentHtmlDefinition: DEFINICAO_V1_HTML,
  renderText: (input) => v1Renderer(input).textBody,
  renderHtml: (input) => v1Renderer(input).htmlBody,
  dataMode: "RESPONSE_FORM",
  publicMetadata: {
    dataMode: "RESPONSE_FORM",
    dataModeReason: "Snapshot da campanha não possui endereço/telefone autoritativos.",
  },
});

const templateV2 = registrarEntrada({
  templateId: TEMPLATE_V2_ID,
  templateVersion: TEMPLATE_V2_VERSION,
  scope: TEMPLATE_SCOPE_PF_CAMPAIGN,
  // OWNER GF-2 — decisões incorporadas EXPRESSAMENTE (não inferidas): prazo
  // de 5 (cinco) dias úteis; canal = resposta por e-mail OU SINCETI; contato
  // www.crtba.org.br com assinatura "Conselho Regional dos Técnicos
  // Industriais da Bahia — CRTBA"; redação "sua carteira profissional física
  // está pronta para envio". TEMPLATE_TEXT_OWNER_APPROVED=true,
  // FIVE_BUSINESS_DAYS_APPROVED=true, SINCETI_UPDATE_CHANNEL_APPROVED=true,
  // INSTITUTIONAL_CONTACTS_APPROVED=true. Redação v2 intocada neste gate;
  // continuam proibidos: adimplência, Resolução CFT nº 82/2019, promessa de
  // SRO, prazo dos Correios, endereço/telefone inventados.
  status: "APPROVED",
  subject: TEMPLATE_V2_SUBJECT,
  contentTextDefinition: DEFINICAO_V2_TEXTO,
  contentHtmlDefinition: DEFINICAO_V2_HTML,
  renderText: renderV2Texto,
  renderHtml: renderV2Html,
  dataMode: "PREFILLED_CONFIRMATION",
  publicMetadata: {
    dataMode: "PREFILLED_CONFIRMATION",
    dataModeReason:
      "Contrato terminal do owner (GF-2): campos de exibição pré-preenchidos a partir do snapshot congelado (telefone, CEP, logradouro, número, complemento, bairro, cidade, UF); ausente ⇒ Não informado; WhatsApp NUNCA inferido; CPF NUNCA renderizado.",
  },
});

/** Entradas do registry (ordem de registro; somente leitura). */
export const TEMPLATE_REGISTRY: readonly TemplateEntryCampanha[] = Object.freeze([
  templateV1,
  templateV2,
]);

// ---------------------------------------------------------------------------
// Seleção (campanha NOVA — server-side, escopo + status)
// ---------------------------------------------------------------------------

/**
 * Seleção para campanha NOVA: somente versões registradas, APPROVED e do
 * escopo autorizado. Cliente pode SOLICITAR um identificador conhecido; o
 * servidor é a autoridade final. RETIRED/DRAFT/desconhecido/incompatível ⇒
 * código sanitizado (persistência NUNCA grava a versão rejeitada).
 */
export function selecionarTemplateCampanhaNova(input: {
  readonly templateId?: string;
  readonly templateVersion?: string;
  readonly scope?: string;
}): TemplateSelectionResult {
  const escopoSolicitado = (input.scope ?? TEMPLATE_SCOPE_PF_CAMPAIGN).trim();
  if (escopoSolicitado !== TEMPLATE_SCOPE_PF_CAMPAIGN) {
    return { ok: false, code: "CAMPAIGN_TEMPLATE_SCOPE_MISMATCH" };
  }
  const templateIdSolicitado = (input.templateId ?? "PF_EXPEDICAO_CARTEIRA").trim();
  // OWNER GF-2 (FASE 5) — NENHUM default implícito: versão ausente ⇒
  // CAMPAIGN_TEMPLATE_UNSUPPORTED (fail-closed sanitizado ⇒ 422 na API).
  // Seleção para campanha nova é SEMPRE explícita (MISSING ⇒ BLOCKED).
  const versaoSolicitada = (input.templateVersion ?? "").trim();
  const entry = TEMPLATE_REGISTRY.find(
    (candidata) =>
      candidata.templateVersion === versaoSolicitada &&
      candidata.templateId === templateIdSolicitado,
  );
  if (!entry) return { ok: false, code: "CAMPAIGN_TEMPLATE_UNSUPPORTED" };
  if (entry.scope !== escopoSolicitado) {
    return { ok: false, code: "CAMPAIGN_TEMPLATE_SCOPE_MISMATCH" };
  }
  if (entry.status !== "APPROVED") {
    return { ok: false, code: "CAMPAIGN_TEMPLATE_NOT_APPROVED" };
  }
  return { ok: true, templateVersion: entry.templateVersion };
}

// ---------------------------------------------------------------------------
// Resolução (server-side) pela versão PERSISTIDA
// ---------------------------------------------------------------------------

function entradaPersistida(persistedTemplateVersion: string): TemplateResolutionResult {
  const versao = persistedTemplateVersion.trim();
  const entry = TEMPLATE_REGISTRY.find((candidata) => candidata.templateVersion === versao);
  if (!entry) return { ok: false, code: "CAMPAIGN_TEMPLATE_UNSUPPORTED" };
  if (entry.scope !== TEMPLATE_SCOPE_PF_CAMPAIGN) {
    return { ok: false, code: "CAMPAIGN_TEMPLATE_SCOPE_MISMATCH" };
  }
  // DRAFT ou RETIRED NÃO renderizam para EXECUÇÃO — apenas histórico/preview.
  if (entry.status !== "APPROVED") {
    return { ok: false, code: "CAMPAIGN_TEMPLATE_NOT_APPROVED" };
  }
  return { ok: true, entry };
}

/**
 * Resolve o RENDERER pela versão congelada no lote (status APPROVED no
 * escopo). Contexto `history`: renderização de reconstrução histórica é
 * permitida para qualquer versão REGISTRADA (v1 nunca é redirecionada para
 * v2 e vice-versa).
 */
export function resolverRendererTemplate(
  persistedTemplateVersion: string,
  contexto: "execution" | "history" = "execution",
): TemplateResolutionResult {
  if (contexto === "history") {
    const versao = persistedTemplateVersion.trim();
    const entry = TEMPLATE_REGISTRY.find((candidata) => candidata.templateVersion === versao);
    if (!entry) return { ok: false, code: "CAMPAIGN_TEMPLATE_UNSUPPORTED" };
    return { ok: true, entry };
  }
  return entradaPersistida(persistedTemplateVersion);
}

/**
 * Prévia READ-ONLY (dados sintéticos) via o MESMO renderer do envio.
 * Permitido para DRAFT; usado pelo preview sintético (scripts/rote/).
 */
export function renderizarPreviewTemplate(
  templateVersion: string,
  input: RenderInputCampanha,
): TemplateRenderOutboundResult {
  const versao = templateVersion.trim();
  const entry = TEMPLATE_REGISTRY.find((candidata) => candidata.templateVersion === versao);
  if (!entry) return { ok: false, code: "CAMPAIGN_TEMPLATE_UNSUPPORTED" };
  if (entry.scope !== TEMPLATE_SCOPE_PF_CAMPAIGN) {
    return { ok: false, code: "CAMPAIGN_TEMPLATE_SCOPE_MISMATCH" };
  }
  // Preview renderiza TEXTO e HTML pelo mesmo renderer do envio (v1 delega
  // ao template legado; v2 usa os renderers próprios). Nenhum envio aqui.
  return {
    ok: true,
    mensagem: {
      idempotencyKey: `preview:${entry.templateId}:${entry.templateVersion}`,
      confirmationId: "preview",
      to: "profissional@example.test",
      replyTo: input.remetente.address,
      from: { name: input.remetente.name, address: input.remetente.address },
      subject: entry.subject,
      textBody: entry.renderText(input),
      htmlBody: entry.renderHtml(input),
      templateVersion: entry.templateVersion,
    },
  };
}

/**
 * Render OUTBOUND server-side pela versão congelada — ÚNICO caminho do
 * provider. O request NUNCA fornece subject/corpos/remetente/versão.
 * Falha sanitizada para versão ausente/DRAFT/incompatível (o gate ANTES do
 * claim em campaign-execution.ts impede chegar aqui em estado inválido;
 * esta defesa em profundidade mantém o fail-closed).
 */
export function renderizarTemplatePersistido(input: {
  readonly persistedTemplateVersion: string;
  readonly professionalName: string;
  readonly correlationCode: string;
  readonly exibicao?: RenderInputCampanha["exibicao"];
  readonly remetente: { readonly name: string; readonly address: string };
  readonly campaignId: string;
  readonly itemId: string;
  readonly professionalId: string;
  readonly recipient: string;
  readonly messageTag?: string;
}): TemplateRenderOutboundResult {
  const resolucao = entradaPersistida(input.persistedTemplateVersion);
  if (!resolucao.ok) return resolucao;
  const entradaRender: RenderInputCampanha = {
    professionalName: input.professionalName,
    correlationCode: input.correlationCode,
    // GF-2 FINAL — os campos de exibição (PREFILLED_CONFIRMATION) seguem do
    // snapshot até os renderers (v2); a v1 os ignora por contrato.
    ...(input.exibicao === undefined ? {} : { exibicao: input.exibicao }),
    remetente: input.remetente,
    ...(input.messageTag === undefined ? {} : { messageTag: input.messageTag }),
  };
  const mensagem: OutboundMail =
    resolucao.entry.templateVersion === TEMPLATE_V1_VERSION
      ? // v1 legada mantém o contrato integral: campaignId/itemId/
        // professionalId/recipient reais entram na idempotência e Message-ID.
        renderPfUpdateCampaignMail({
          campaignId: input.campaignId,
          itemId: input.itemId,
          professionalId: input.professionalId,
          recipient: input.recipient,
          professionalName: input.professionalName,
          correlationCode: input.correlationCode,
          remetente: input.remetente,
          ...(input.messageTag === undefined ? {} : { messageTag: input.messageTag }),
        })
      : {
          idempotencyKey: `pf-campanha:${input.campaignId}:${input.itemId}:${resolucao.entry.templateVersion}`,
          confirmationId: input.itemId,
          to: input.recipient,
          replyTo: input.remetente.address.trim().toLowerCase(),
          from: {
            name: input.remetente.name.trim(),
            address: input.remetente.address.trim().toLowerCase(),
          },
          messageTag: input.messageTag ?? "pf-campanha",
          subject: resolucao.entry.subject,
          textBody: resolucao.entry.renderText(entradaRender),
          htmlBody: resolucao.entry.renderHtml(entradaRender),
          templateVersion: resolucao.entry.templateVersion,
        };
  return { ok: true, mensagem };
}

/**
 * Preview de metadados do registry (sem render): id, versão, status, escopo,
 * assunto, data mode, metadados públicos, `contentHash` (hash canônico do
 * CONTEÚDO, status-independente) e `registryDefinitionHash` (hash do CONTRATO
 * de registro, inclui status — claramente separado do hash de conteúdo).
 */
export function metadadosTemplate(templateVersion: string): {
  readonly ok: boolean;
  readonly code?: TemplateErrorCode;
  readonly templateId?: string;
  readonly status?: TemplateStatus;
  readonly scope?: string;
  readonly subject?: string;
  readonly dataMode?: TemplateDataMode;
  readonly publicMetadata?: TemplateEntryCampanha["publicMetadata"];
  readonly contentHash?: string;
  readonly registryDefinitionHash?: string;
} {
  const entry = TEMPLATE_REGISTRY.find((c) => c.templateVersion === templateVersion.trim());
  if (!entry) return { ok: false, code: "CAMPAIGN_TEMPLATE_UNSUPPORTED" };
  return {
    ok: true,
    templateId: entry.templateId,
    status: entry.status,
    scope: entry.scope,
    subject: entry.subject,
    dataMode: entry.dataMode,
    publicMetadata: entry.publicMetadata,
    contentHash: entry.contentHash,
    registryDefinitionHash: entry.definitionHash,
  };
}

/**
 * GF-2 F4 — contentHash canônico da versão (puro, somente leitura). Entrada
 * do binding durável em autorização/persistência; `undefined` para versão não
 * registrada. Nenhum render é executado aqui.
 */
export function contentHashDoTemplate(templateVersion: string): string | undefined {
  return TEMPLATE_REGISTRY.find(
    (candidata) => candidata.templateVersion === templateVersion.trim(),
  )?.contentHash;
}
