import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { AppHeader } from "../components/AppHeader";
import { campaignLogoutDisposition } from "./campaign-logout-state";
import { visaoEtapa8 } from "./campaign-step8-presentation";
import {
  disposicaoRetomada,
  LIMPEZA_RETOMADA,
  type CampanhaRetomavelResumo,
  type ModoDescobertaRetomada,
} from "./campaign-resume-state";
import {
  macroEtapaAtual,
  mapeamentoDeterministico,
  pendenciasMapeamento,
} from "./campaign-macro-stage";

type OperatorMe = {
  operatorId: string;
  code: string;
  displayName: string;
  status: "ATIVO";
  roles: string[];
  sessionExpiresAt: string;
};

type CampaignPolicy = {
  enabled: boolean;
  phase: "FOUNDATION" | "PERSISTENCE";
  individualOperatorIdentityRequired: true;
  canPersistImport: boolean;
  canCreateBatch: boolean;
  canExecute: false;
  canPrepareBatch: boolean;
  realSendEnabled: boolean;
};

/** SLICE-03B — readiness operacional read-only (server-driven). */
type AcaoOperacao = {
  permitida: boolean;
  bloqueios: readonly string[];
};

type ReadinessOperacional = {
  lote: {
    loteCampanhaId: string;
    codigo: string;
    estado: string;
    totalItens: number;
    contagemPorEstado: Readonly<Record<string, number>>;
  };
  politicas: {
    canPrepareBatch: boolean;
    canExecute: boolean;
    realSendEnabled: boolean;
    canarySendEnabled: boolean;
    // GF5.3 — apenas diagnóstico (DISPLAY ONLY): a autoridade do botão é
    // EXCLUSIVAMENTE acoes.EXECUTAR_LOTE.permitida.
    batchSendEnabled: boolean;
  };
  autorizacaoHumana: { concedida: boolean; referenciaPresente: boolean };
  // SLICE-03C.1 — campos de ativação (não sensíveis: nenhum fingerprint,
  // nenhuma chave, nenhum e-mail).
  ativacao: {
    proofKeyReady: boolean;
    canaryRecipientConfigured: boolean;
    canarySelected: boolean;
    canaryReferencePresent: boolean;
    providerReady: boolean;
  };
  acoes: {
    PREPARAR_LOTE: AcaoOperacao;
    AUTORIZAR_EXECUCAO: AcaoOperacao;
    ATIVAR_LOTE: AcaoOperacao;
    EXECUTAR_ITEM: AcaoOperacao;
    // GF4.5 — ação do canário derivada EXCLUSIVAMENTE pelo servidor (mesmo
    // preflight canônico read-only do envio real); o cliente nunca reconstrói
    // elegibilidade a partir de flags locais.
    EXECUTAR_CANARIO: AcaoOperacao;
    // GF5.3 — ação do lote derivada EXCLUSIVAMENTE pelo servidor (mesmo
    // preflight canônico read-only do executarLoteCampanha); o cliente nunca
    // reconstrói elegibilidade a partir de flags/contagens locais.
    EXECUTAR_LOTE: AcaoOperacao;
  };
  // SLICE-03C.2A — OAuth readiness read-only (estados sanitizados).CONNECTED
  // significa SOMENTE "persistido + conta esperada correspondente" — nunca
  // token testado ao vivo ou Gmail alcançável.
  oauth: {
    configurationReady: boolean;
    connectionStored: boolean;
    expectedAccountConfigured: boolean;
    storedAccountMatchesExpected: boolean;
    encryptionConfigurationReady: boolean;
    executionReady: boolean;
  };
  envioCanario: {
    armado: boolean;
    providerWiringReady: boolean;
    gateOperacional: string;
  };
  executavel: false;
  envioRealDesabilitado: boolean;
  proximaAcao: string;
};

type RegistroAprovacao = {
  profissional_id: string;
  nome: string;
  email_normalizado: string;
  status_validacao: string;
  source_record_key?: string;
  exibicao?: {
    telefone?: string;
    cep?: string;
    logradouro?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
  };
};

type DecisaoHumana = {
  linha: number;
  profissional_id: string;
  tipo: "EXCLUSAO_HUMANA" | "INCONSISTENCIA_JULGADA";
  motivo: string;
};

type CampanhaPersistida = {
  campanhaId: string;
  operatorId: string;
  fingerprintArquivo: string;
  templateVersao: string;
  hashAprovacao: string;
  estado: string;
  totalRegistros: number;
  totalAptos: number;
  totalBloqueados: number;
  totalAprovados: number;
  loteId: string | null;
  loteCodigo: string | null;
  loteEstado: string | null;
  outboxTotal: number;
  outboxNaoExecutavel: number;
  criadaEm: string;
};

type WorkspaceStatus = {
  campaign: CampaignPolicy;
  operatorIdentity: "INDIVIDUAL_ACTIVE";
  operatorId: string;
  roles: string[];
  availableActions: string[];
  queueAvailable: false;
  nextAction: string;
};

type AvaliacaoArquivo = {
  sha256: string;
  folhas_disponiveis: readonly string[];
  cabecalhos: readonly string[];
  total_linhas: number;
  mapeamento_sugerido: Readonly<Record<string, number>>;
  campos_obrigatorios: readonly string[];
};

type RegistroAvaliado = {
  readonly linha: number;
  readonly source_record_key?: string;
  readonly profissional_id: string;
  readonly nome: string;
  readonly nome_exibicao: string;
  readonly email_original: string;
  readonly email_normalizado: string;
  readonly status_validacao: "APTO" | "BLOQUEADO" | "EXCLUIDO_DO_LOTE";
  readonly motivo_bloqueio: readonly string[];
  readonly normalizacoes_aplicadas: readonly string[];
  readonly inconsistencias: readonly string[];
  readonly exibicao?: {
    readonly telefone?: string;
    readonly cep?: string;
    readonly logradouro?: string;
    readonly numero?: string;
    readonly complemento?: string;
    readonly bairro?: string;
    readonly cidade?: string;
    readonly uf?: string;
  };
};

/** Catálogo server-driven de templates selecionáveis (GF-2 FINAL). */
type TemplateSelecionavel = {
  templateVersao: string;
  templateId: string;
  status: string;
  scope: string;
  subject: string;
  dataMode: string;
};

/** Prévia server-side do registro persistido (mesmo renderer do provider). */
type PreviaRegistro = {
  templateVersao: string;
  templateContentHash: string;
  dataMode: string;
  assunto: string;
  mensagem: { subject: string; textBody: string; htmlBody: string };
};

type AvaliacaoBase = {
  sha256: string;
  total_registros: number;
  aptos: number;
  bloqueados: number;
  inconsistencias_pendentes: number;
  duplicidades_email: readonly {
    email_normalizado: string;
    linhas: readonly number[];
    profissionais: readonly string[];
  }[];
  registros: readonly RegistroAvaliado[];
};

type Aprovacao = {
  status: "CAMPAIGN_APPROVAL_FROZEN";
  conteudoHash: string;
  totalItens: number;
  aprovadaPor: string;
  persistida: false;
  aviso: string;
};

type Etapa = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

type OperatorListEntry = {
  readonly operatorId: string;
  readonly code: string;
  readonly displayName: string;
  readonly status: "ATIVO" | "SUSPENSO";
  readonly roles: readonly string[];
  readonly criadoEm: string;
  readonly atualizadoEm: string;
  readonly suspensoEm: string | null;
  readonly credentialActive: boolean;
  readonly credentialExpiresAt: string | null;
  readonly credentialState: "ATIVA" | "EXPIRADA" | "INDEFINIDA" | "AUSENTE";
  readonly activeSessions: number;
};

type AdminRoleOption = "PREPARADOR" | "REVISOR" | "APROVADOR" | "EXECUTOR" | "SUPERVISOR";

const ETAPAS: readonly { readonly numero: Etapa; readonly titulo: string; readonly descricao: string }[] = [
  { numero: 1, titulo: "Identificação individual", descricao: "Credencial validada no servidor; sessão curta e auditada." },
  { numero: 2, titulo: "Campanha", descricao: "Estado e gates da campanha de atualização cadastral PF." },
  { numero: 3, titulo: "Importação", descricao: "Pré-voo XLSX seguro, sem assumir colunas e sem persistir." },
  { numero: 4, titulo: "Mapeamento de colunas", descricao: "Confirmação campo a campo; obrigatórios exigidos." },
  { numero: 5, titulo: "Inconsistências", descricao: "Classificação recalculada no servidor; decisões humanas." },
  { numero: 6, titulo: "Revisão dos profissionais", descricao: "Base final por identificador institucional." },
  { numero: 7, titulo: "Prévia das mensagens", descricao: "Destinatário mascarado, assunto e corpo do template." },
  { numero: 8, titulo: "Aprovação", descricao: "Hash de congelamento do conteúdo (SHA-256)." },
  { numero: 9, titulo: "Execução controlada", descricao: "Bloqueada nesta fase (canExecute=false)." },
  { numero: 10, titulo: "Acompanhamento", descricao: "Contadores operacionais e trilha de auditoria." },
];

const ROTULOS_ETAPA: Readonly<Record<Etapa, string>> = {
  1: "Identificação",
  2: "Campanha",
  3: "Importação",
  4: "Mapeamento",
  5: "Inconsistências",
  6: "Revisão",
  7: "Prévia",
  8: "Aprovação",
  9: "Execução",
  10: "Acompanhamento",
};

/**
 * UX-FLOW-01A — Quatro MACROETAPAS derivadas do estado operacional. Os dez
 * destinos antigos permanecem apenas como PAINEL DE ATIVIDADE (histórico e
 * auditoria); nenhum clique exclusivamente navegacional é exigido.
 */
const MACROETAPAS_UI = [
  { numero: 1, titulo: "Identificação e contexto", descricao: "Credencial individual validada no servidor; sessão curta e auditada." },
  { numero: 2, titulo: "Preparação", descricao: "Importação, mapeamento e classificação da base — nada persistido ainda." },
  { numero: 3, titulo: "Revisão e aprovação", descricao: "Revisão dos destinatários, prévia da comunicação e congelamento por hash." },
  { numero: 4, titulo: "Operação e acompanhamento", descricao: "Campanha persistida: preparo do lote HOLD e acompanhamento auditável." },
] as const;

const ROTULO_MACROETAPA: Readonly<Record<number, string>> = Object.fromEntries(
  MACROETAPAS_UI.map((macro) => [macro.numero, macro.titulo]),
);

/** Rótulos dos campos do contrato mínimo (etapa 4). */
const CAMPOS_MAPEAMENTO = [
  "profissional_id",
  "nome",
  "nome_exibicao",
  "email_original",
  "email_normalizado",
  "status_validacao",
  "motivo_bloqueio",
] as const;

const CAMPOS_OBRIGATORIOS = ["profissional_id", "nome", "email_original"] as const;

const ROTULOS_CAMPO: Readonly<Record<string, string>> = {
  profissional_id: "Identificador institucional",
  nome: "Nome",
  nome_exibicao: "Nome de exibição",
  email_original: "E-mail original",
  email_normalizado: "E-mail normalizado (derivado)",
  status_validacao: "Status de validação (derivado)",
  motivo_bloqueio: "Motivo de bloqueio (derivado)",
};

// GF-2 FINAL — SERVER_REGISTRY_AUTHORITY: NÃO existe constante de template
// client-side. O catálogo vem de GET /api/campaigns/template-selecionaveis
// (status APPROVED, escopo PF_CAMPAIGN) e o operador seleciona explicitamente
// uma templateVersion registrada; o servidor revalida em authorize/persist/
// claim. A prévia textual client-side foi REMOVIDA como autoridade: o preview
// usa o MESMO registry/renderer do provider via /api/campaigns/preview-registro.

function mascararEmail(email: string): string {
  const [local, dominio] = email.split("@");
  if (!local || !dominio) return "***";
  const visivel = local.slice(0, 2);
  return `${visivel}${"•".repeat(Math.max(local.length - 2, 2))}@${dominio}`;
}

/**
 * Gera credencial individual com CSPRNG de 256 bits e devolve o par
 * (credencial bruta, SHA-256 hex). Formato idêntico ao homologado:
 * 32 bytes -> base64url de 43 caracteres -> SHA-256 UTF-8 hex.
 * A credencial bruta existe APENAS em memória nesta tela; a API recebe
 * somente o hash (contrato preservado).
 */
function gerarCredencialIndividual(): Promise<{ credencial: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binario = "";
  for (const byte of bytes) binario += String.fromCharCode(byte);
  const credencial = btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(credencial));
  return digest.then((ab) => ({
    credencial,
    hash: Array.from(new Uint8Array(ab), (b) => b.toString(16).padStart(2, "0")).join(""),
  }));
}

async function sha256Hex(valor: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(valor));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", cache: "no-store", ...init });
  const texto = await response.text();
  let body: unknown = undefined;
  try {
    body = texto ? JSON.parse(texto) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const codigo = (body as { codigo?: string } | undefined)?.codigo ?? "";
    const erro = (body as { erro?: string } | undefined)?.erro ?? `HTTP ${response.status}`;
    throw new ApiCampanhaError(erro, codigo, response.status);
  }
  return body as T;
}

// UX-FLOW-01B — modo de descoberta do servidor (EMPTY / SINGLE / MULTIPLE).
// O cliente NUNCA escolhe campanha alheia nem infere por hash local.
type RetomadaEstado =
  | { readonly status: "indefinida" }
  | { readonly status: "vazio" }
  | { readonly status: "aplicada"; readonly campanha: CampanhaPersistida }
  | { readonly status: "multipla"; readonly campanhas: readonly CampanhaRetomavelResumo[] };

/** Detalhe autenticado da campanha do PRÓPRIO operador (seleção explícita). */
/** Readiness read-only do plano de controle (SLICE-03B) — sem mutação. */
async function obterReadinessOperacional(campanhaId: string): Promise<ReadinessOperacional> {
  const resposta = await fetchJson<ReadinessOperacional>(
    `/api/campaigns/operational-readiness?campanhaId=${encodeURIComponent(campanhaId)}`,
  );
  return resposta;
}

// SLICE-03C.1 — Ações mutáveis do plano de controle: cada função chama
// SOMENTE a sua rota, com corpo restrito a { campanhaId }. Nenhum operatorId,
// loteCampanhaId, itemId, e-mail, fingerprint, proofKey, estado, chave
// idempotente ou provider é enviado pelo cliente; o resultado exibido é
// SEMPRE o status sanitizado devolvido pelo servidor.
type ResultadoControleCampanha = {
  status: string;
  aviso?: string;
};

async function prepararLoteOperacional(campanhaId: string): Promise<ResultadoControleCampanha> {
  return fetchJson<ResultadoControleCampanha>("/api/campaigns/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campanhaId }),
  });
}

async function autorizarExecucaoOperacional(campanhaId: string): Promise<ResultadoControleCampanha> {
  return fetchJson<ResultadoControleCampanha>("/api/campaigns/authorize-execution", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campanhaId }),
  });
}

async function ativarLoteOperacional(campanhaId: string): Promise<ResultadoControleCampanha> {
  return fetchJson<ResultadoControleCampanha>("/api/campaigns/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campanhaId }),
  });
}

// GF4.5 — canário controlado: EXATAMENTE a rota canônica
// POST /api/campaigns/canary-send, com corpo restrito a { campanhaId }.
// Nenhum operatorId, loteId, itemId, destinatário, e-mail, fingerprint,
// prova, hash, dado de OAuth, provider, valor de flag ou chave de
// idempotência é enviado pelo cliente — o servidor reconstrói TODA a
// autoridade. Nenhum retry automático existe nesta função.
type ResultadoCanarioOperacional = {
  resultado: string;
  itemId?: string;
  receipt?: { messageId?: string; provider?: string; acceptedAt?: string };
  motivo?: string;
  erro?: string;
};

async function executarCanarioOperacional(
  campanhaId: string,
): Promise<ResultadoCanarioOperacional> {
  return fetchJson<ResultadoCanarioOperacional>("/api/campaigns/canary-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campanhaId }),
  });
}

// GF5.3 — execução limitada do lote: EXATAMENTE a rota canônica
// POST /api/campaigns/batch-send, com corpo restrito a { campanhaId }.
// Nenhum operatorId, loteCampanhaId, itemId/ids, destinatário, e-mail,
// fingerprint, template, assunto, corpo, provider, prova, dado de OAuth,
// chave de idempotência, limit, batchSize, maxItems, offset, cursor, retry
// ou flag é enviado pelo cliente — o servidor reconstrói TODA a autoridade e
// aplica a janela server-side (máx 10 itens por invocação). Nenhum retry
// automático existe nesta função.
type ResultadoLoteOperacional = {
  resultado: string;
  campanhaId?: string;
  loteCampanhaId?: string;
  totalItens?: number;
  preparadosInicio?: number;
  enviadosAntes?: number;
  processadosNestaExecucao?: number;
  enviadosNestaExecucao?: number;
  falhasNestaExecucao?: number;
  restantesPreparados?: number;
  ultimaOrdemProcessada?: number;
  motivoInterrupcao?: string;
  janelaItensPorExecucao?: number;
  continuaSomenteComNovaAcaoHumana?: boolean;
  erro?: string;
};

async function executarLoteOperacional(
  campanhaId: string,
): Promise<ResultadoLoteOperacional> {
  return fetchJson<ResultadoLoteOperacional>("/api/campaigns/batch-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campanhaId }),
  });
}

async function obterCampanhaDetalhe(campanhaId: string): Promise<CampanhaPersistida> {
  const resposta = await fetchJson<{ campanha: CampanhaPersistida }>(
    `/api/campaigns/detail?campanhaId=${encodeURIComponent(campanhaId)}`,
  );
  return resposta.campanha;
}

class ApiCampanhaError extends Error {
  constructor(
    message: string,
    readonly codigo: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiCampanhaError";
  }
}

export function CampaignWorkspace() {
  const [me, setMe] = useState<OperatorMe | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState("");

  // Jornada operacional
  const [etapa, setEtapa] = useState<Etapa>(2);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [statusErro, setStatusErro] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [avaliacaoArquivo, setAvaliacaoArquivo] = useState<AvaliacaoArquivo | null>(null);
  const [mapeamento, setMapeamento] = useState<Record<string, number>>({});
  const [base, setBase] = useState<AvaliacaoBase | null>(null);
  const [avaliando, setAvaliando] = useState(false);
  const [erroEtapa, setErroEtapa] = useState("");
  const [aprovacao, setAprovacao] = useState<Aprovacao | null>(null);
  const [confirmacaoAprovacao, setConfirmacaoAprovacao] = useState("");
  const [previaIndice, setPreviaIndice] = useState(0);
  const [excluidos, setExcluidos] = useState<readonly number[]>([]);
  // GF-3 CORRECTIVE-01 (F2) — limpeza canônica do logout: TODOS os estados
  // ligados ao operador montado (arquivo, avaliacaoArquivo, mapeamento, base,
  // aprovacao, confirmacaoAprovacao, excluidos, previaIndice, erroEtapa,
  // painelAdmin, operadores, credencialUnica, credencialSalvaConfirmada,
  // acaoMensagem, acaoErro, campanha, retomada, modoRetomada). O logout
  // confirmado (SIGNED_OUT) aplica o reset completo; a retomada server-driven
  // re-deriva tudo do servidor para o próximo login — ownership permanece
  // autoridade SERVER-SIDE e nenhuma request pendente de A restaura estado
  // para B (o efeito é cancelado pelo cleanup `ativo` ao trocar `me`).
  // GF-3 CORRECTIVE-02 (F5) — o reset completo passa a cobrir TAMBÉM os
  // estados de template/prévia (templatesSelecionaveis, templateSelecionada,
  // previaMensagemServidor, previaIndice, previaCarregando, previaErro).
  // NENHUMA persistência/localStorage para estes dados.
  const limparEstadoOperador = () => {
    setArquivo(null);
    setAvaliacaoArquivo(null);
    setMapeamento({});
    setBase(null);
    setAprovacao(null);
    setConfirmacaoAprovacao("");
    setExcluidos([]);
    setPreviaIndice(0);
    setErroEtapa("");
    setPainelAdmin(false);
    setOperadores([]);
    setCredencialUnica(null);
    setCredencialSalvaConfirmada(false);
    setAcaoMensagem("");
    setAcaoErro("");
    setCampanha(null);
    setRetomada(LIMPEZA_RETOMADA.retomada);
    setModoRetomada(LIMPEZA_RETOMADA.modo);
    // GF-3 CORRECTIVE-02 (F5) — estados de TEMPLATE/PRÉVIA também são
    // ligados ao operador montado: catálogo, seleção, prévia renderizada,
    // índice, carregando e erro. Nada de catálogo/seleção/prévia do
    // operador A sobrevive ao logout confirmado para o operador B. Sem
    // localStorage/sessionStorage (prova estrutural dedicada).
    setTemplatesSelecionaveis([]);
    setTemplateSelecionada("");
    setPreviaMensagemServidor(null);
    setPreviaIndice(0);
    setPreviaCarregando(false);
    setPreviaErro("");
  };
  const [painelAdmin, setPainelAdmin] = useState(false);
  const [operadores, setOperadores] = useState<readonly OperatorListEntry[]>([]);
  const [adminErro, setAdminErro] = useState("");
  const [adminMensagem, setAdminMensagem] = useState("");
  const [novoCodigo, setNovoCodigo] = useState("");
  const [novoNome, setNovoNome] = useState("");
  const [novosPapeis, setNovosPapeis] = useState<readonly AdminRoleOption[]>([]);
  const [credencialUnica, setCredencialUnica] = useState<{ operator: string; credencial: string } | null>(null);
  const [credencialSalvaConfirmada, setCredencialSalvaConfirmada] = useState(false);
  const [credencialExpiracaoDias, setCredencialExpiracaoDias] = useState(90);
  const [persistindo, setPersistindo] = useState(false);
  const [criandoLote, setCriandoLote] = useState(false);
  const [campanha, setCampanha] = useState<CampanhaPersistida | null>(null);
  // UX-FLOW-01B.1 DEAD HASH LIFECYCLE CLEANUP — o estado React do hash de
  // sessão e a leitura inicial de ic_campanha_hash foram REMOVIDOS: sem o efeito
  // legado não existe leitor, e estado write-only não é conveniência
  // operacional. A retomada é 100% server-driven (resumable + detail).
  // UX-FLOW-01A — detalhamento das dez etapas: consulta (painel), não wizard.
  // GF-2 FINAL — catálogo server-driven de templates selecionáveis + seleção
  // EXPLÍCITA do operador (sem default implícito no cliente).
  const [templatesSelecionaveis, setTemplatesSelecionaveis] = useState<readonly TemplateSelecionavel[]>([]);
  const [templateSelecionada, setTemplateSelecionada] = useState("");
  // Prévia server-side (mesmo renderer do provider) para o registro selecionado.
  const [previaMensagemServidor, setPreviaMensagemServidor] = useState<PreviaRegistro | null>(null);
  const [previaCarregando, setPreviaCarregando] = useState(false);
  // GF-3 CORRECTIVE-02 (F5) — erro da prévia é estado do operador (limpo no
  // logout e na troca de template/registro).
  const [previaErro, setPreviaErro] = useState("");
  const [painelAtividade, setPainelAtividade] = useState(false);
  const [etapaConsulta, setEtapaConsulta] = useState<Etapa>(1);
  // UX-FLOW-01B — retomada server-driven (descoberta por operator_id).
  const [retomada, setRetomada] = useState<RetomadaEstado>({ status: "indefinida" });
  const [retomando, setRetomando] = useState(false);
  const [retomadaErro, setRetomadaErro] = useState("");
  // UX-FLOW-01B SERVER-DRIVEN RECOVERY AUTHORITY — modo definido
  // EXCLUSIVAMENTE pela descoberta server-driven (resumable):
  // EMPTY/SINGLE/MULTIPLE é registro audível da decisão do servidor.
  // Nenhum mecanismo legado por hash coordena ou disputa esta decisão.
  const [modoRetomada, setModoRetomada] = useState<ModoDescobertaRetomada>("INDEFINIDO");
  // SLICE-03B — readiness do plano de controle: estado DERIVADO do servidor
  // (read-only). Sem Session Storage; nenhuma autorização é decidida aqui.
  const [readiness, setReadiness] = useState<ReadinessOperacional | null>(null);
  const [readinessErro, setReadinessErro] = useState("");
  // GF-3 CORRECTIVE-01 (F6) — ciclo de vida do blob URL da credencial: UM URL
  // por credencial (nunca URL.createObjectURL dentro do JSX/render). O URL é
  // revogado quando a credencial muda, o modal fecha (credencialUnica → null)
  // ou o componente desmonta. A credencial bruta NUNCA é persistida.
  const [credencialBlobUrl, setCredencialBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!credencialUnica) {
      setCredencialBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([credencialUnica.credencial], { type: "text/plain" }),
    );
    setCredencialBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setCredencialBlobUrl(null);
    };
  }, [credencialUnica]);
  // SLICE-03C.1 — guarda de duplo clique e feedback das ações mutáveis.
  const [acaoPendente, setAcaoPendente] = useState<"PREPARAR" | "AUTORIZAR" | "ATIVAR" | null>(null);
  const [acaoMensagem, setAcaoMensagem] = useState("");
  const [acaoErro, setAcaoErro] = useState("");
  // GF4.5 — guarda local de clique pendente do canário: usada SOMENTE para
  // impedir duplo clique durante o POST em andamento. A elegibilidade em si
  // é SEMPRE do servidor (readiness.acoes.EXECUTAR_CANARIO).
  const [canarioPendente, setCanarioPendente] = useState(false);
  // GF5.3 — guarda dedicada de duplo clique/reação da execução do lote:
  // enquanto verdadeira, o botão do lote fica desabilitado (uma confirmação
  // humana = exatamente UM POST).
  const [lotePendente, setLotePendente] = useState(false);

  async function loadMe(): Promise<boolean> {
    try {
      const response = await fetch("/api/operator/me", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        setMe(null);
        return false;
      }
      setMe((await response.json()) as OperatorMe);
      return true;
    } catch {
      setMe(null);
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMe();
  }, []);

  // GF-2 FINAL — catálogo de templates selecionáveis vem SEMPRE do servidor
  // (registry: APPROVED no escopo PF_CAMPAIGN). Nenhum default implícito.
  // GF-3 CORRECTIVE-02 (F6) — ciclo de vida LIGADO À SESSÃO: sem `me` ⇒
  // catálogo limpo e NENHUMA request; ao autenticar ⇒ request; troca de
  // operador/logout/login ⇒ cleanup cancela a resposta stale (`ativo`),
  // catálogo anterior é limpo e a recarga ocorre para a sessão atual. Sem
  // polling (dependência única `me`).
  useEffect(() => {
    if (!me) {
      setTemplatesSelecionaveis([]);
      setTemplateSelecionada("");
      return;
    }
    let ativo = true;
    void fetchJson<{ templates: readonly TemplateSelecionavel[] }>(
      "/api/campaigns/template-selecionaveis",
    )
      .then((corpo) => {
        if (ativo) setTemplatesSelecionaveis(corpo.templates);
      })
      .catch(() => {
        if (ativo) setTemplatesSelecionaveis([]);
      });
    return () => {
      ativo = false;
    };
  }, [me]);

  useEffect(() => {
    if (!me) {
      setStatus(null);
      return;
    }
    let ativo = true;
    setStatusErro("");
    void fetchJson<WorkspaceStatus>("/api/operator/workspace/status")
      .then((body) => {
        if (ativo) setStatus(body);
      })
      .catch((error: unknown) => {
        if (!ativo) return;
        setStatus(null);
        if (error instanceof ApiCampanhaError && error.status === 403) {
          setStatusErro(
            "Identidade válida, mas a jornada de campanha requer papel operacional (PREPARADOR, APROVADOR, EXECUTOR ou SUPERVISOR). Use a área administrativa se você é ADMIN_TECNICO.",
          );
          return;
        }
        setStatusErro(
          error instanceof ApiCampanhaError
            ? error.message
            : "Não foi possível carregar o estado da campanha.",
        );
      });
    return () => {
      ativo = false;
    };
  }, [me]);

  // UX-FLOW-01B SERVER-DRIVEN RECOVERY AUTHORITY — corretivo
  // LEGACY_HASH_RECOVERY_OVERWRITES_SERVER_DRIVEN_STATE: o efeito legado de
  // recuperação por hash via GET /api/campaigns/persisted foi REMOVIDO
  // do fluxo autenticado. Nenhuma request por hash parte da retomada:
  // · SINGLE → /resumable + /detail aplicam a campanha automaticamente;
  // · MULTIPLE → somente seleção explícita humana chama /detail;
  // · EMPTY/INDEFINIDO → nenhuma recuperação.
  // Um 403 CAMPAIGN_PERSIST_DISABLED de /persisted NUNCA mais limpa
  // setCampanha de uma campanha válida aplicada por /detail. Os únicos
  // consumidores de /persisted que restam são os fluxos de CRIAÇÃO
  // (persistirCampanha e criarLoteCampanha), que seguem legítimos.
  // UX-FLOW-01B.1: nenhum estado de hash e nenhum acesso de leitura/gravação
  // a Session Storage na retomada — SINGLE/seleção aplicam via /detail.

  // UX-FLOW-01B — Retomada SERVER-DRIVEN: a descoberta usa exclusivamente o
  // operator_id da sessão autenticada (GET /api/campaigns/resumable). Session
  // Storage vazio ou outro navegador NÃO impede a reconstrução — o débito
  // CROSS_BROWSER_RESUME_DEPENDS_ON_SESSION_CONTEXT é encerrado. SINGLE é
  // retomado automaticamente (contrato server-driven): o detalhe é APLICADO
  // ao estado operacional (setCampanha). A retomada é exclusivamente
  // server-driven: /resumable descobre e /detail aplica a campanha
  // autorizada. MULTIPLE exige seleção EXPLÍCITA do operador — nenhuma
  // escolha silenciosa.
  useEffect(() => {
    if (!me) {
      setModoRetomada("INDEFINIDO");
      setRetomada({ status: "indefinida" });
      setCampanha(null);
      return;
    }
    let ativo = true;
    void (async () => {
      try {
        const resposta = await fetchJson<{ mode: string; campaign?: CampanhaRetomavelResumo; campaigns?: readonly CampanhaRetomavelResumo[] }>(
          "/api/campaigns/resumable",
        );
        if (!ativo) return;
        if (resposta.mode === "SINGLE" && resposta.campaign) {
          // Corretivo UX-FLOW-01B: SINGLE server-driven APLICA o detalhe ao
          // estado operacional (campanha) — é dele que visaoMacro deriva a
          // macroetapa 4 (Operação / preparar lote OU acompanhamento). Sem
          // isso, navegador novo + Session Storage vazio nunca reconstruía a
          // operação. Mesmo padrão da seleção explícita MULTIPLE.
          const detalhe = await obterCampanhaDetalhe(resposta.campaign.campanhaId);
          if (!ativo) return;
          setModoRetomada("SINGLE");
          setCampanha(detalhe);
          setRetomada({ status: "aplicada", campanha: detalhe });
          return;
        }
        if (resposta.mode === "MULTIPLE" && resposta.campaigns) {
          // SERVER-DRIVEN AUTHORITY: a descoberta é a AUTORIDADE — nenhuma
          // campanha permanece ativa e NENHUMA recuperação concorrente por
          // hash existe (o efeito legado foi removido). Só o clique humano em
          // "Retomar esta campanha" chama detail e aplica setCampanha.
          setModoRetomada("MULTIPLE");
          setCampanha(null);
          setRetomada({ status: "multipla", campanhas: resposta.campaigns });
          return;
        }
        // EMPTY: nenhuma campanha ativa; hash antigo NÃO reativa nada
        // (não existe recuperação por hash neste fluxo).
        setModoRetomada("EMPTY");
        setCampanha(null);
        setRetomada({ status: "vazio" });
      } catch {
        if (ativo) setRetomada({ status: "vazio" });
      }
    })();
    return () => {
      ativo = false;
    };
  }, [me]);

  /** Seleção EXPLÍCITA do operador na retomada MULTIPLE (0 mutações). */
  async function retomarCampanhaSelecionada(campanhaId: string) {
    setRetomando(true);
    setRetomadaErro("");
    try {
      const detalhe = await obterCampanhaDetalhe(campanhaId);
      setCampanha(detalhe);
      setRetomada({ status: "aplicada", campanha: detalhe });
    } catch (error) {
      setRetomadaErro(error instanceof ApiCampanhaError ? error.message : "Retomada indisponível.");
    } finally {
      setRetomando(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback("");
    setLoading(true);
    try {
      const response = await fetch("/api/operator/identity/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setToken("");
      if (!response.ok) {
        setFeedback("Credencial individual inválida, expirada ou revogada.");
        setMe(null);
        return;
      }
      if (!(await loadMe())) {
        setFeedback("Sessão criada, mas a identidade não pôde ser carregada.");
      }
    } catch {
      setToken("");
      setFeedback("Identidade operacional indisponível.");
      setMe(null);
    } finally {
      setLoading(false);
    }
  }

  // ------------- Administração (exclusiva de ADMIN_TECNICO) -------------
  const souAdminTecnico = me?.roles.includes("ADMIN_TECNICO") ?? false;

  async function carregarOperadores(): Promise<void> {
    setAdminErro("");
    try {
      const resposta = await fetchJson<{ operadores: readonly OperatorListEntry[] }>(
        "/api/operator/admin/operators?limit=100",
      );
      setOperadores(resposta.operadores);
    } catch (error) {
      setOperadores([]);
      setAdminErro(
        error instanceof ApiCampanhaError
          ? error.message
          : "Não foi possível carregar a lista de operadores.",
      );
    }
  }

  function abrirPainelAdmin(): void {
    setPainelAdmin(true);
    setAdminMensagem("");
    setAdminErro("");
    setOperadores([]);
    void carregarOperadores();
  }

  async function provisionarOperador(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAdminErro("");
    setAdminMensagem("");
    if (novosPapeis.length === 0) {
      setAdminErro("Selecione ao menos um papel para o novo operador.");
      return;
    }
    setLoading(true);
    try {
      const { credencial, hash } = await gerarCredencialIndividual();
      const expiracao = new Date(Date.now() + credencialExpiracaoDias * 24 * 60 * 60 * 1000);
      const resposta = await fetchJson<{ operatorId: string }>("/api/operator/admin/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: novoCodigo.trim(),
          displayName: novoNome.trim(),
          roles: novosPapeis,
          credentialHash: hash,
          tokenExpiresAt: Number.isFinite(expiracao.getTime()) ? expiracao.toISOString() : undefined,
        }),
      });
      const rotulo =
        operadores.find((o) => o.operatorId === resposta.operatorId)?.code ?? novoCodigo.trim();
      setCredencialUnica({ operator: rotulo, credencial });
      setCredencialSalvaConfirmada(false);
      setNovoCodigo("");
      setNovoNome("");
      setNovosPapeis([]);
      setAdminMensagem(`Operador ${rotulo} provisionado com papel(éis): ${novosPapeis.join(", ")}.`);
      await carregarOperadores();
    } catch (error) {
      setAdminErro(
        error instanceof ApiCampanhaError ? error.message : "Provisionamento indisponível.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function suspender(entry: OperatorListEntry): Promise<void> {
    setAdminErro("");
    setAdminMensagem("");
    setLoading(true);
    try {
      await fetchJson("/api/operator/admin/suspend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorId: entry.operatorId }),
      });
      setAdminMensagem(`Operador ${entry.code} suspenso e sessões revogadas.`);
      await carregarOperadores();
    } catch (error) {
      setAdminErro(
        error instanceof ApiCampanhaError ? error.message : "Suspensão indisponível.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function rotacionarCredencial(entry: OperatorListEntry, motivo: "ROTACAO" | "RECUPERACAO"): Promise<void> {
    setAdminErro("");
    setAdminMensagem("");
    setLoading(true);
    try {
      const { credencial, hash } = await gerarCredencialIndividual();
      const expiracao = new Date(Date.now() + credencialExpiracaoDias * 24 * 60 * 60 * 1000);
      await fetchJson(`/api/operator/admin/credentials/${motivo === "ROTACAO" ? "rotate" : "recover"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operatorId: entry.operatorId,
          credentialHash: hash,
          tokenExpiresAt: Number.isFinite(expiracao.getTime()) ? expiracao.toISOString() : undefined,
        }),
      });
      setCredencialUnica({ operator: entry.code, credencial });
      setCredencialSalvaConfirmada(false);
      setAdminMensagem(
        motivo === "ROTACAO"
          ? `Credencial rotacionada para ${entry.code}.`
          : `Credencial de recuperação emitida para ${entry.code}.`,
      );
      await carregarOperadores();
    } catch (error) {
      setAdminErro(
        error instanceof ApiCampanhaError ? error.message : "Rotação de credencial indisponível.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    setFeedback("");
    setLoading(true);
    try {
      const response = await fetch("/api/operator/identity/session", {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (campaignLogoutDisposition(response.status) === "SIGNED_OUT") {
        // GF-3 CORRECTIVE-01 (F2): NENHUM estado ligado ao operador anterior
        // sobrevive ao logout confirmado — workspace (arquivo, avaliação,
        // mapeamento, base, aprovação, exclusões, prévia, erros), painel
        // administrativo (operadores, credencial única e confirmação) e ações
        // em curso. A retomada server-driven re-deriva tudo do servidor para o
        // próximo login; ownership permanece autoridade SERVER-SIDE. Sem
        // persistência/localStorage para estes dados. Limpeza HISTÓRICA
        // (UX-FLOW-01B.1) de ic_campanha_hash permanece (sem leitor/gravador).
        sessionStorage.removeItem(LIMPEZA_RETOMADA.chaveHashSessao);
        limparEstadoOperador();
        setMe(null);
        setToken("");
        return;
      }
      setFeedback("Não foi possível confirmar a saída. Sua sessão permanece exibida como ativa.");
    } catch {
      setFeedback("Não foi possível confirmar a saída. Sua sessão permanece exibida como ativa.");
    } finally {
      setLoading(false);
    }
  }

  // ------- Etapa 3: análise estrutural do arquivo (sem assumir colunas) ------
  async function analisarArquivo() {
    if (!arquivo) return;
    setErroEtapa("");
    setAvaliando(true);
    try {
      const resultado = await fetchJson<AvaliacaoArquivo>("/api/campaigns/analyze", {
        method: "POST",
        headers: { "x-file-name": arquivo.name },
        body: arquivo,
      });
      setAvaliacaoArquivo(resultado);
      const sugerido: Record<string, number> = {};
      for (const [campo, coluna] of Object.entries(resultado.mapeamento_sugerido)) {
        if (typeof coluna === "number" && coluna >= 0) sugerido[campo] = coluna;
      }
      setMapeamento(sugerido);
      setBase(null);
      setAprovacao(null);
      setExcluidos([]);
      // UX-FLOW-01A (regras 3/5): mapeamento DETERMINÍSTICO pelas regras
      // homologadas é aplicado e a avaliação segue automaticamente — sem
      // clique exclusivamente navegacional. Ambíguo: a preparação apresenta
      // SOMENTE os campos pendentes de decisão humana.
      if (mapeamentoDeterministico(sugerido, resultado.campos_obrigatorios)) {
        void avaliarArquivoSubmetido(arquivo, sugerido);
      } else {
        // Ambíguo: apresentar SOMENTE os campos que exigem decisão humana.
        setEtapa(4);
      }
    } catch (error) {
      setErroEtapa(
        error instanceof ApiCampanhaError
          ? error.message
          : "Arquivo não pôde ser analisado.",
      );
    } finally {
      setAvaliando(false);
    }
  }

  // ------- Etapas 4→5: mapeamento confirmado e recálculo server-side ------
  async function avaliarArquivoSubmetido(
    arquivoSubmetido: File,
    mapeamentoSubmetido: Record<string, number>,
  ) {
    const ausentes = pendenciasMapeamento(mapeamentoSubmetido, CAMPOS_OBRIGATORIOS);
    if (ausentes.length > 0) {
      setErroEtapa(`Mapeamento incompleto: ${ausentes.join(", ")}.`);
      return;
    }
    setErroEtapa("");
    setAvaliando(true);
    try {
      const resultado = await fetchJson<AvaliacaoBase>("/api/campaigns/evaluate", {
        method: "POST",
        headers: {
          "x-file-name": arquivoSubmetido.name,
          "x-mapping": JSON.stringify(mapeamentoSubmetido),
        },
        body: arquivoSubmetido,
      });
      setBase(resultado);
      setExcluidos([]);
      setAprovacao(null);
      setCampanha(null);
      // UX-FLOW-01A: a revisão unificada (com o bloco de exceções, quando
      // houver) abre automaticamente após a avaliação.
      setEtapa(6);
    } catch (error) {
      setErroEtapa(
        error instanceof ApiCampanhaError
          ? error.message
          : "Base não pôde ser avaliada.",
      );
    } finally {
      setAvaliando(false);
    }
  }

  // ------- Etapa 8: aprovação com congelamento por hash (server-side) ------
  async function aprovar() {
    if (!base) return;
    const aptos = base.registros.filter(
      (registro) => registro.status_validacao === "APTO" && !excluidos.includes(registro.linha),
    );
    if (aptos.length === 0) {
      setErroEtapa("Nenhum profissional apto para aprovar.");
      return;
    }
    if (templateSelecionada === "") {
      setErroEtapa("Selecione explicitamente um template registrado (APPROVED) antes de aprovar.");
      return;
    }
    setErroEtapa("");
    setAvaliando(true);
    try {
      const resultado = await fetchJson<Aprovacao>("/api/campaigns/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateVersao: templateSelecionada,
          registros: aptos.map((registro) => ({
            profissional_id: registro.profissional_id,
            nome: registro.nome,
            email_normalizado: registro.email_normalizado,
            status_validacao: registro.status_validacao,
            ...(registro.source_record_key === undefined
              ? {}
              : { source_record_key: registro.source_record_key }),
            ...(registro.exibicao === undefined ? {} : { exibicao: registro.exibicao }),
          })),
        }),
      });
      setAprovacao(resultado);
      // UX-FLOW-01A: pós-aprovação o destino segue derivado — a revisão
      // unificada apresenta persistência e lote como ações humanas explícitas.
      setEtapa(6);
    } catch (error) {
      setErroEtapa(
        error instanceof ApiCampanhaError ? error.message : "Aprovação recusada pelo servidor.",
      );
    } finally {
      setAvaliando(false);
    }
  }

  // SLICE-02 — persistir a campanha aprovada (hash + snapshot RECONSTRUÍDOS
  // no servidor; o navegador envia apenas conteúdo, decisões e hash local).
  async function persistirCampanha() {
    if (!base || !aprovacao) return;
    setErroEtapa("");
    setPersistindo(true);
    try {
      const fingerprint = base.sha256 === "sintetico-dev" ? await sha256Hex("sintetico-dev") : base.sha256;
      const resposta = await fetchJson<{
        status: string;
        campanhaId: string;
        conteudoHash: string;
      }>("/api/campaigns/persist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fingerprintArquivo: fingerprint,
          templateVersao: templateSelecionada,
          conteudoHash: aprovacao.conteudoHash,
          registros: aptosParaAprovacao.map((registro) => ({
            profissional_id: registro.profissional_id,
            nome: registro.nome,
            email_normalizado: registro.email_normalizado,
            status_validacao: registro.status_validacao,
            ...(registro.source_record_key === undefined
              ? {}
              : { source_record_key: registro.source_record_key }),
            ...(registro.exibicao === undefined ? {} : { exibicao: registro.exibicao }),
          })),
          decisoes: excluidos.map((linha) => {
            const registro = base.registros.find((item) => item.linha === linha);
            return {
              linha,
              profissional_id: registro?.profissional_id ?? "",
              tipo: "EXCLUSAO_HUMANA",
              motivo: registro?.inconsistencias?.[0] ?? "EXCLUSAO_HUMANA_REVISAO",
            } satisfies DecisaoHumana;
          }),
        }),
      });
      const detalhe = await fetchJson<{ campanha: CampanhaPersistida }>(
        `/api/campaigns/persisted?hash=${encodeURIComponent(resposta.conteudoHash)}`,
      );
      setCampanha(detalhe.campanha);
      setEtapa(10);
    } catch (error) {
      setErroEtapa(
        error instanceof ApiCampanhaError ? error.message : "Persistência recusada pelo servidor.",
      );
    } finally {
      setPersistindo(false);
    }
  }

  // SLICE-02 — lote controlado (EXECUTOR): materializa outbox em HOLD; nada
  // é executável e o Gmail não é chamado.
  async function criarLoteCampanha() {
    if (!campanha) return;
    setErroEtapa("");
    setCriandoLote(true);
    try {
      const resposta = await fetchJson<{ lote: CampanhaPersistida["loteId"] extends null ? never : { id: string; estado: string; totalItens: number; outboxTotal: number; outboxNaoExecutavel: number } }>(
        "/api/campaigns/batch",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            campanhaId: campanha.campanhaId,
            conteudoHash: campanha.hashAprovacao,
          }),
        },
      );
      const detalhe = await fetchJson<{ campanha: CampanhaPersistida }>(
        `/api/campaigns/persisted?hash=${encodeURIComponent(campanha.hashAprovacao)}`,
      );
      setCampanha(detalhe.campanha);
      // UX-FLOW-01A (regra 10): lote criado → abrir o acompanhamento.
      setEtapa(10);
      void resposta;
    } catch (error) {
      setErroEtapa(
        error instanceof ApiCampanhaError ? error.message : "Criação de lote recusada pelo servidor.",
      );
    } finally {
      setCriandoLote(false);
    }
  }

  function alternativaSintetica() {
    setErroEtapa("");
    setAvaliando(true);
    // A base sintética já nasce normalizada: o mapeamento é automático por
    // construção (cabeçalhos canônicos) e não precisa de confirmação manual.
    void fetchJson<{ registros: readonly RegistroAvaliado[] }>("/api/campaigns/synthetic-base")
      .then((body) => {
        setBase({
          sha256: "sintetico-dev",
          total_registros: body.registros.length,
          aptos: body.registros.filter((r) => r.status_validacao === "APTO").length,
          bloqueados: body.registros.filter((r) => r.status_validacao === "BLOQUEADO").length,
          inconsistencias_pendentes: body.registros.filter((r) => r.inconsistencias?.length).length,
          duplicidades_email: [],
          registros: body.registros.map((registro, indice) => ({
            ...registro,
            linha: indice + 1,
            normalizacoes_aplicadas: [],
            inconsistencias: registro.motivo_bloqueio.filter((motivo) =>
              ["EMAIL_DUPLICADO", "IDENTIFICADOR_INSTITUCIONAL_DUPLICADO"].includes(motivo),
            ),
          })),
        });
        setExcluidos([]);
        setAprovacao(null);
        setCampanha(null);
        // UX-FLOW-01A: base sintética nasce avaliada → revisão unificada.
        setEtapa(6);
      })
      .catch(() => setErroEtapa("Base sintética indisponível."))
      .finally(() => setAvaliando(false));
  }

  const aptosParaAprovacao = useMemo(
    () =>
      base?.registros.filter(
        (registro) => registro.status_validacao === "APTO" && !excluidos.includes(registro.linha),
      ) ?? [],
    [base, excluidos],
  );

  // GF-2 FINAL — prévia server-side (PREVIEW_RENDERER_EQUALS_SEND_RENDERER).
  // GF-3 CORRECTIVE-02 (F7) — PRÉVIA PRÉ-APROVAÇÃO: o efeito usa
  // POST /api/campaigns/template-preview com o MESMO payload pendente do
  // authorize (templateSelecionada + aptosParaAprovacao) e o índice
  // navegável previaIndice — nada de registro fixo na linha 1 do snapshot.
  // Valores/assunto vêm SEMPRE do servidor (mesmo registry/renderer do
  // provider); o browser NUNCA fornece subject/texto/HTML/remetente/
  // Reply-To. O preview PÓS-persistência (GET /api/campaigns/
  // preview-registro, snapshot congelado) permanece uma rota/fluxo
  // separado. Cleanup `ativo` cancela a resposta stale; erro de prévia é
  // estado próprio (F5).
  useEffect(() => {
    setPreviaMensagemServidor(null);
    setPreviaErro("");
    if (templateSelecionada === "" || aptosParaAprovacao.length === 0) return;
    const indiceSolicitado = Math.min(previaIndice, aptosParaAprovacao.length - 1);
    if (indiceSolicitado < 0) return;
    let ativo = true;
    setPreviaCarregando(true);
    void fetchJson<PreviaRegistro>("/api/campaigns/template-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateVersao: templateSelecionada,
        previaIndice: indiceSolicitado + 1,
        registros: aptosParaAprovacao.map((registro) => ({
          profissional_id: registro.profissional_id,
          nome: registro.nome,
          email_normalizado: registro.email_normalizado,
          status_validacao: registro.status_validacao,
          ...(registro.source_record_key === undefined
            ? {}
            : { source_record_key: registro.source_record_key }),
          ...(registro.exibicao === undefined ? {} : { exibicao: registro.exibicao }),
        })),
      }),
    })
      .then((corpo) => {
        if (ativo) setPreviaMensagemServidor(corpo);
      })
      .catch((error: unknown) => {
        if (!ativo) return;
        setPreviaMensagemServidor(null);
        setPreviaErro(
          error instanceof ApiCampanhaError
            ? error.message
            : "Não foi possível gerar a prévia no servidor.",
        );
      })
      .finally(() => {
        if (ativo) setPreviaCarregando(false);
      });
    return () => {
      ativo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateSelecionada, previaIndice, aptosParaAprovacao]);

  const acoesAtivas = new Set(status?.availableActions ?? []);
  const podeImportar = acoesAtivas.has("IMPORTAR_E_MAPEAR");
  const podeAprovar = acoesAtivas.has("APROVAR_E_CONGELAR");
  const motivosBloqueioImportacao = podeImportar
    ? []
    : ["Seu papel ativo não autoriza importar ou mapear bases (PREPARADOR exigido)."];
  const motivosBloqueioAprovacao = podeAprovar
    ? []
    : ["Seu papel ativo não autoriza aprovar (APROVADOR exigido)."];
  const podePersistir = (status?.campaign.canPersistImport ?? false) && podeAprovar && !!aprovacao;
  // Etapa 08: capacidades separadas — persistir depende da aprovação da
  // sessão; criar lote depende da CAMPANHA PERSISTIDA reconstruída
  // (válido também após reload/logout/login com base=null e aprovacao=null).
  const visaoEtapa = useMemo(
    () =>
      visaoEtapa8({
        basePresente: base !== null,
        aprovacaoPresente: aprovacao !== null,
        canPersistImport: status?.campaign.canPersistImport ?? false,
        canCreateBatch: status?.campaign.canCreateBatch ?? false,
        acaoExecutarLote: acoesAtivas.has("EXECUTAR_LOTE"),
        campanha: campanha
          ? {
              campanhaId: campanha.campanhaId,
              hashAprovacao: campanha.hashAprovacao,
              loteId: campanha.loteId,
            }
          : null,
      }),
    [base, aprovacao, status, campanha],
  );

  // SLICE-03B — readiness segue a campanha aplicada (server-driven; reload
  // reconstrói tudo a partir do PostgreSQL; nenhuma autoridade local).
  useEffect(() => {
    if (!campanha?.campanhaId) {
      setReadiness(null);
      setReadinessErro("");
      return;
    }
    let ativo = true;
    void obterReadinessOperacional(campanha.campanhaId)
      .then((corpo) => {
        if (!ativo) return;
        setReadiness(corpo);
        setReadinessErro("");
      })
      .catch((error: unknown) => {
        if (!ativo) return;
        setReadiness(null);
        setReadinessErro(
          error instanceof ApiCampanhaError
            ? error.message
            : "Readiness operacional indisponível.",
        );
      });
    return () => {
      ativo = false;
    };
  }, [campanha?.campanhaId]);

  // SLICE-03C.1 — handler das ações mutáveis do plano de controle: chama
  // SOMENTE a rota da ação, exige confirmação humana explícita, impede duplo
  // clique, exibe o resultado sanitizado devolvido pelo servidor e recarrega
  // o readiness (fonte única de verdade). Nenhum sucesso é inferido no
  // cliente: sem confirmação do servidor não há mensagem de sucesso.
  async function executarAcaoControle(
    acao: "PREPARAR" | "AUTORIZAR" | "ATIVAR",
  ): Promise<void> {
    if (!campanha?.campanhaId || acaoPendente) return;
    const perguntas: Record<typeof acao, string> = {
      PREPARAR:
        "Preparar o lote? Os itens saem de HOLD para PREPARADO. Nenhum envio é realizado.",
      AUTORIZAR:
        "Autorizar a execução? Um registro auditado da autorização humana será criado. Nenhum envio é realizado.",
      ATIVAR:
        "Ativar o lote? O lote sai de PREPARADO para ATIVO com um canário selecionado pelo servidor. O provider permanece indisponível — nada é enviado.",
    };
    const resposta = window.confirm(perguntas[acao]);
    if (!resposta) {
      setAcaoMensagem("");
      setAcaoErro("");
      return;
    }
    setAcaoPendente(acao);
    setAcaoMensagem("");
    setAcaoErro("");
    try {
      const corpo =
        acao === "PREPARAR"
          ? await prepararLoteOperacional(campanha.campanhaId)
          : acao === "AUTORIZAR"
            ? await autorizarExecucaoOperacional(campanha.campanhaId)
            : await ativarLoteOperacional(campanha.campanhaId);
      // GF4.5 — sincronização SERVER-DRIVEN pós-mutação: recarrega AMBOS os
      // recursos autoritativos (detail + readiness) antes de apresentar o
      // estado. O novo estado NUNCA é inferido da resposta do POST; nenhuma
      // transição local (ex.: PREPARADO → ATIVO) existe.
      const [detalhe, corpoReadiness] = await Promise.all([
        obterCampanhaDetalhe(campanha.campanhaId),
        obterReadinessOperacional(campanha.campanhaId),
      ]);
      setCampanha(detalhe);
      setReadiness(corpoReadiness);
      setReadinessErro("");
      setAcaoMensagem(corpo.status + (corpo.aviso ? " — " + corpo.aviso : ""));
    } catch (error: unknown) {
      // GF4.5 — falha na mutação OU na leitura autoritativa: nenhum estado
      // de sucesso é inventado; o operador é orientado a reler o estado
      // persistido; o POST NUNCA é repetido automaticamente.
      setAcaoMensagem("");
      setAcaoErro(
        (error instanceof ApiCampanhaError
          ? error.message
          : "Ação operacional indisponível.") +
          " Estado não sincronizado — recarregue/consulte o estado persistido antes de repetir qualquer ação.",
      );
    } finally {
      setAcaoPendente(null);
    }
  }

  // GF4.5 — execução controlada do canário: elegibilidade vem EXCLUSIVAMENTE
  // do readiness server-driven (acoes.EXECUTAR_CANARIO.permitida); o cliente
  // NUNCA deriva permissão de canExecute/realSendEnabled/canarySendEnabled/
  // lote.estado/OAuth/canarySelected ou qualquer combinação local deles.
  // Confirmação humana explícita ⇒ exatamente UM POST; cancelar ⇒ ZERO POST;
  // nenhuma repetição automática (ambiguidade exige adjudicação do owner).
  // GF4.5C.1 (FINDING 2) — domínios de erro DISTINTOS: o resultado da
  // MUTAÇÃO é adjudicado independentemente da sincronização read-only
  // posterior; uma falha de refresh NUNCA reescreve um resultado definitivo
  // do servidor como "não conclusivo"; 4xx é rejeição DEFINITIVA; rede/5xx
  // é conservador; readiness inválido não rearma o botão sozinho.
  async function executarCanarioOperacionalUI(): Promise<void> {
    if (!campanha?.campanhaId || acaoPendente !== null || canarioPendente) return;
    const confirmado = window.confirm(
      "Executar o canário real controlado?\n" +
        "Esta ação poderá realizar exatamente um envio real pelo Gmail para o destinatário canário configurado no servidor.\n" +
        "Não haverá lote completo nem retry automático.\n" +
        "Confirme somente se o gate de canário foi explicitamente autorizado.",
    );
    if (!confirmado) {
      setAcaoMensagem("");
      setAcaoErro("");
      return;
    }
    setCanarioPendente(true);
    setAcaoMensagem("");
    setAcaoErro("");
    // (A) FAIL-CLOSED antes do despacho: o readiness antigo é invalidado
    // para que um permitida=true obsoleto não reabilite o botão após a
    // conclusão. Somente uma leitura NOVA do servidor reabilita a ação.
    setReadiness(null);
    setReadinessErro("");
    try {
      // (B) MUTAÇÃO adjudicada primeiro: resultado/receipt/motivo do POST
      // são preservados mesmo se a sincronização posterior falhar.
      const corpo = await executarCanarioOperacional(campanha.campanhaId);
      if (corpo.resultado === "AMBIGUO") {
        // (C) ambiguidade EXPLÍCITA do servidor: permanece não conclusiva,
        // sem repetição automática, verificação manual obrigatória.
        setAcaoMensagem("");
        setAcaoErro(
          "Canário: AMBIGUO — Resultado do canário não conclusivo. Não repetir automaticamente. Verifique o estado persistido antes de qualquer nova tentativa.",
        );
      } else {
        // Resultado DEFINITIVO do servidor (ENVIADO/NAO_CLAIMADO/
        // FALHA_PRE_PROVIDER/FALHA_DEFINITIVA/...): preservado inclusive o
        // recibo quando presente; nunca reclassificado como ambíguo.
        setAcaoMensagem(
          "Canário: " +
            corpo.resultado +
            (corpo.receipt?.messageId ? " — recibo " + corpo.receipt.messageId : corpo.motivo ? " — " + corpo.motivo : ""),
        );
      }
      // Sincronização READ-ONLY com domínio de erro PRÓPRIO (não compartilha
      // o catch da mutação): nada aqui pode reescrever a mensagem acima.
      try {
        const [detalhe, corpoReadiness] = await Promise.all([
          obterCampanhaDetalhe(campanha.campanhaId),
          obterReadinessOperacional(campanha.campanhaId),
        ]);
        setCampanha(detalhe);
        setReadiness(corpoReadiness);
        setReadinessErro("");
      } catch {
        // (F) falha de sincronização: o resultado do POST permanece exibido;
        // readiness fica inválido e o operador deve reler o estado
        // autoritativo antes de qualquer nova ação. ZERO segundo POST.
        setReadiness(null);
        setReadinessErro(
          "Falha na sincronização do estado pós-envio — recarregue/consulte o estado persistido antes de nova ação.",
        );
      }
    } catch (error: unknown) {
      setAcaoMensagem("");
      if (error instanceof ApiCampanhaError && error.status >= 400 && error.status < 500) {
        // (E) rejeição DEFINITIVA do servidor (4xx): exibida como é — sem
        // "não conclusivo", sem inventar envio, sem repetição automática.
        setAcaoErro(
          error.message +
            " — Rejeição definitiva do servidor. Consulte o estado persistido antes de qualquer nova tentativa.",
        );
      } else {
        // (D) rede/transporte/5xx: potencialmente NÃO CONCLUSIVO —
        // comportamento conservador; ZERO repetição automática.
        setAcaoErro(
          (error instanceof ApiCampanhaError ? error.message : "Canário indisponível.") +
            " Resultado do canário potencialmente não conclusivo (falha de rede/servidor). Não repetir automaticamente. Verifique o estado persistido antes de qualquer nova tentativa.",
        );
      }
      // Sem readiness fresco o botão não rearma: estado fail-closed.
      setReadiness(null);
    } finally {
      setCanarioPendente(false);
    }
  }

  // GF5.3 — execução limitada do lote: elegibilidade vem EXCLUSIVAMENTE do
  // readiness server-driven (acoes.EXECUTAR_LOTE.permitida); o cliente NUNCA
  // deriva permissão de batchSendEnabled/canExecute/realSendEnabled/lote.estado/
  // OAuth/estado do canário/contagens ou qualquer combinação local deles.
  // Confirmação humana explícita ⇒ exatamente UM POST; cancelar ⇒ ZERO POST;
  // PARCIAL aguarda NOVA ação humana (AUTO_CONTINUE=false); nenhuma repetição
  // automática (sem timer, sem loop, sem fila, sem fetch a si mesmo).
  async function executarLoteOperacionalUI(): Promise<void> {
    if (!campanha?.campanhaId || acaoPendente !== null || lotePendente || canarioPendente) return;
    const confirmado = window.confirm(
      "Executar a janela do lote controlado?\n" +
        "Com os gates de produção armados, mensagens reais podem ser enviadas pelo Gmail.\n" +
        "Esta invocação processa no máximo 10 itens elegíveis (janela definida pelo servidor), em ordem crescente, uma a uma.\n" +
        "Não há retry automático. Se restarem itens PREPARADO, uma nova ação humana explícita será necessária para continuar.",
    );
    if (!confirmado) {
      setAcaoMensagem("");
      setAcaoErro("");
      return;
    }
    setLotePendente(true);
    setAcaoMensagem("");
    setAcaoErro("");
    // (A) FAIL-CLOSED antes do despacho: o readiness antigo é invalidado para
    // que um EXECUTAR_LOTE.permitida=true obsoleto não reabilite o botão após
    // a conclusão. Somente uma leitura NOVA do servidor reabilita a ação.
    setReadiness(null);
    setReadinessErro("");
    const contagens = (corpo: ResultadoLoteOperacional): string =>
      " (" +
      "processados " + String(corpo.processadosNestaExecucao ?? 0) +
      " · enviados " + String(corpo.enviadosNestaExecucao ?? 0) +
      " · falhas " + String(corpo.falhasNestaExecucao ?? 0) +
      " · restantes PREPARADO " + String(corpo.restantesPreparados ?? 0) +
      ")";
    try {
      // (B) MUTAÇÃO adjudicada primeiro: o resultado do POST é preservado
      // mesmo que a sincronização read-only posterior falhe.
      const corpo = await executarLoteOperacional(campanha.campanhaId);
      if (corpo.resultado === "PARCIAL") {
        setAcaoMensagem(
          "Lote: PARCIAL — janela do servidor consumida" + contagens(corpo) +
            ". Continuação somente com nova ação humana explícita (sem continuação automática).",
        );
      } else if (corpo.resultado === "INTERROMPIDO") {
        setAcaoMensagem(
          "Lote: INTERROMPIDO — " + (corpo.motivoInterrupcao ?? "motivo não informado") +
            contagens(corpo) +
            ". Adjudicação humana necessária; não repetir automaticamente.",
        );
      } else {
        setAcaoMensagem("Lote: " + corpo.resultado + contagens(corpo));
      }
      // Sincronização READ-ONLY com domínio de erro PRÓPRIO (não compartilha
      // o catch da mutação): nada aqui pode reescrever a mensagem acima.
      try {
        const [detalhe, corpoReadiness] = await Promise.all([
          obterCampanhaDetalhe(campanha.campanhaId),
          obterReadinessOperacional(campanha.campanhaId),
        ]);
        setCampanha(detalhe);
        setReadiness(corpoReadiness);
        setReadinessErro("");
      } catch {
        // (F) falha de sincronização: o resultado do POST permanece exibido;
        // readiness fica inválido e o operador deve reler o estado
        // autoritativo antes de qualquer nova ação. ZERO segundo POST.
        setReadiness(null);
        setReadinessErro(
          "Falha na sincronização do estado pós-execução — recarregue/consulte o estado persistido antes de nova ação.",
        );
      }
    } catch (error: unknown) {
      setAcaoMensagem("");
      if (error instanceof ApiCampanhaError && error.status >= 400 && error.status < 500) {
        // (E) rejeição DEFINITIVA do servidor (4xx): exibida como é — sem
        // "não conclusivo", sem inventar envio, sem repetição automática.
        setAcaoErro(
          error.message +
            " — Rejeição definitiva do servidor. Consulte o estado persistido antes de qualquer nova tentativa.",
        );
      } else {
        // (D) rede/transporte/5xx: POTENCIALMENTE NÃO CONCLUSIVO — um ou mais
        // itens podem já ter sido settlementados antes da falha do HTTP;
        // comportamento conservador; ZERO repetição automática.
        setAcaoErro(
          (error instanceof ApiCampanhaError ? error.message : "Execução do lote indisponível.") +
            " Resultado potencialmente NÃO CONCLUSIVO (falha de rede/servidor): itens podem já ter sido processados. Não repetir automaticamente; recarregue/verifique o estado persistido — somente um readiness novo do servidor autoriza continuação.",
        );
      }
      // Sem readiness fresco o botão não rearma: estado fail-closed.
      setReadiness(null);
    } finally {
      setLotePendente(false);
    }
  }

  // UX-FLOW-01A — a macroetapa visível é DERIVADA do estado operacional
  // (sessão, base, aprovação, campanha/lote). A navegação representa o
  // estado existente; nunca produz mutação apenas para avançar.
  const visaoMacro = useMemo(
    () =>
      macroEtapaAtual({
        sessaoAtiva: me !== null,
        baseAvaliada: base !== null,
        decisoesPendentes: pendenciasMapeamento(mapeamento, CAMPOS_OBRIGATORIOS).length > 0,
        aprovacaoPresente: aprovacao !== null,
        campanha: campanha
          ? { estado: campanha.estado, loteId: campanha.loteId, loteEstado: campanha.loteEstado }
          : null,
      }),
    [me, base, mapeamento, aprovacao, campanha],
  );
  const macroAtiva = visaoMacro.macro;
  const mostrarImportacao = macroAtiva === 2 && !base && !avaliacaoArquivo;
  const mostrarMapeamento = macroAtiva === 2 && !base && avaliacaoArquivo !== null;
  const mostrarRevisao = macroAtiva === 3 && base !== null;
  const mostrarOperacao = macroAtiva === 4;
  const mostrarPendenciasRevisao = mostrarRevisao && (base?.inconsistencias_pendentes ?? 0) > 0;

  function alternarExclusao(linha: number) {
    setExcluidos((atual) =>
      atual.includes(linha) ? atual.filter((item) => item !== linha) : [...atual, linha],
    );
    setAprovacao(null);
    setCampanha(null);
  }

  if (!me) {
    return (
      <div className="app-shell campaign-shell">
        <AppHeader />
        <main className="campaign-login">
          <section className="campaign-login-card" aria-labelledby="campaign-login-title">
            <span className="eyebrow">Campanha de Atualização Cadastral PF</span>
            <h1 id="campaign-login-title">Identificação individual do operador</h1>
            <p>
              Entre com sua credencial individual. Ela é validada no servidor e não é armazenada
              pelo navegador.
            </p>
            <form onSubmit={login}>
              <label>
                Credencial individual
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  disabled={loading}
                  required
                />
              </label>
              <button type="submit" disabled={loading || token.length < 43}>
                {loading ? "Validando…" : "Entrar na operação"}
              </button>
            </form>
            <p className="campaign-login-feedback" role="status">{feedback}</p>
            <small>O acesso compartilhado do piloto técnico não é aceito nesta interface.</small>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell campaign-shell">
      <AppHeader />
      <main className="campaign-workspace">
        <header className="campaign-hero">
          <div>
            <span className="eyebrow">Campanha de Atualização Cadastral PF</span>
            <h1>Operação diária de atualização cadastral</h1>
            <p>
              Fluxo independente do piloto Gmail controlado. Importação e avaliação permanecem em
              memória nesta fase; aprovação congela o conteúdo por hash no servidor.
            </p>
          </div>
          <aside className="campaign-lock" aria-label="Estado da campanha">
            <strong>Execução bloqueada nesta fase</strong>
            <span>Identidade individual ativa · aprovação com congelamento por hash</span>
          </aside>
        </header>

        <section className="campaign-operator-card" aria-label="Identidade do operador">
          <div>
            <span>Operador identificado</span>
            <strong>{me.displayName}</strong>
            <small>{me.code} · {me.roles.join(" · ")}</small>
          </div>
          <div className="campaign-session-actions">
            <span>Sessão até {new Date(me.sessionExpiresAt).toLocaleString("pt-BR")}</span>
            <button type="button" onClick={logout} disabled={loading}>Sair</button>
            {souAdminTecnico ? (
              <button type="button" onClick={abrirPainelAdmin} disabled={loading}>
                {painelAdmin ? "Fechar administração" : "Administração"}
              </button>
            ) : null}
            {feedback ? <span className="campaign-session-error" role="status">{feedback}</span> : null}
          </div>
        </section>

        {retomada.status === "multipla" ? (
          <section className="campaign-resume-panel" aria-labelledby="retomada-multiple-title">
            <h2 id="retomada-multiple-title">Campanhas retomáveis deste operador</h2>
            <p>
              Existem {retomada.campanhas.length} campanhas persistidas. Escolha explicitamente qual
              retomar — nada é selecionado automaticamente. As demais continuam listadas aqui.
            </p>
            {retomadaErro ? <p role="alert" className="campaign-session-error">{retomadaErro}</p> : null}
            <ul className="campaign-resume-list">
              {retomada.campanhas.map((resumo) => (
                <li key={resumo.campanhaId}>
                  <div>
                    <code>{resumo.campanhaId}</code>
                    <small>
                      {disposicaoRetomada([resumo]).tipo === "ACOMPANHAMENTO"
                        ? "Operação e acompanhamento"
                        : "Campanha pronta para preparar lote"}{" "}
                      · Estado {resumo.estado} ·{" "}
                      {resumo.loteId
                        ? `lote ${resumo.loteCodigo ?? ""} ${resumo.loteEstado ?? ""}`.trim()
                        : "sem lote"}{" "}
                      · {resumo.totalAprovados} aprovados · {new Date(resumo.criadaEm).toLocaleString("pt-BR")}
                    </small>
                  </div>
                  <button type="button" onClick={() => { void retomarCampanhaSelecionada(resumo.campanhaId); }} disabled={retomando}>
                    {retomando ? "Retomando…" : "Retomar esta campanha"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {painelAdmin && souAdminTecnico ? (
          <section className="campaign-panel admin-panel" aria-labelledby="admin-panel-title">
            <h2 id="admin-panel-title">Administração de operadores</h2>
            <p className="campaign-actions-note">
              Área exclusiva de ADMIN_TECNICO. Credenciais aparecem uma única vez e não são
              armazenadas: enviamos apenas o SHA-256. Operadores não recebem segredo, hash ou
              cookie nesta tela.
            </p>
            {adminMensagem ? <p role="status" className="campaign-actions-note">{adminMensagem}</p> : null}
            {adminErro ? (
              <p role="alert" className="campaign-session-error">
                {adminErro}
              </p>
            ) : null}

            <form onSubmit={(e) => { void provisionarOperador(e); }} className="admin-form">
              <label>
                Código
                <input
                  value={novoCodigo}
                  onChange={(e) => setNovoCodigo(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="ui-preparador"
                />
              </label>
              <label>
                Nome de exibição
                <input
                  value={novoNome}
                  onChange={(e) => setNovoNome(e.target.value)}
                  required
                  maxLength={160}
                  placeholder="Operador de Homologação"
                />
              </label>
              <fieldset className="admin-roles">
                <legend>Papéis permitidos</legend>
                {(["PREPARADOR", "REVISOR", "APROVADOR", "EXECUTOR", "SUPERVISOR"] as const).map(
                  (papel) => (
                    <label key={papel} className="admin-role-option">
                      <input
                        type="checkbox"
                        checked={novosPapeis.includes(papel)}
                        onChange={(e) =>
                          setNovosPapeis(
                            e.target.checked
                              ? [...novosPapeis, papel]
                              : novosPapeis.filter((p) => p !== papel),
                          )
                        }
                      />
                      {papel}
                    </label>
                  ),
                )}
              </fieldset>
              <label>
                Expiração da credencial (dias)
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={credencialExpiracaoDias}
                  onChange={(e) => setCredencialExpiracaoDias(Number(e.target.value) || 90)}
                />
              </label>
              <button type="submit" disabled={loading}>Provisionar operador</button>
            </form>

            <div className="campaign-table-wrap">
              <table className="campaign-table admin-table">
                <thead>
                  <tr>
                    <th>Código</th><th>Nome</th><th>Estado</th><th>Papéis</th>
                    <th>Credencial</th><th>Expira em</th><th>Sessões ativas</th><th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {operadores.length === 0 ? (
                    <tr><td colSpan={8}>Nenhum operador listado.</td></tr>
                  ) : (
                    operadores.map((entry) => (
                      <tr key={entry.operatorId}>
                        <td>{entry.code}</td>
                        <td>{entry.displayName}</td>
                        <td>{entry.status}</td>
                        <td>{entry.roles.join(", ") || "—"}</td>
                        <td>{entry.credentialState}</td>
                        <td>
                          {entry.credentialExpiresAt
                            ? new Date(entry.credentialExpiresAt).toLocaleDateString("pt-BR")
                            : "—"}
                        </td>
                        <td>{entry.activeSessions}</td>
                        <td className="admin-actions">
                          <button
                            type="button"
                            onClick={() => { void suspender(entry); }}
                            disabled={loading || entry.status !== "ATIVO" || entry.operatorId === me.operatorId}
                          >
                            Suspender
                          </button>
                          <button
                            type="button"
                            onClick={() => { void rotacionarCredencial(entry, "ROTACAO"); }}
                            disabled={loading}
                          >
                            Rotacionar credencial
                          </button>
                          <button
                            type="button"
                            onClick={() => { void rotacionarCredencial(entry, "RECUPERACAO"); }}
                            disabled={loading}
                          >
                            Emitir recuperação
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {credencialUnica ? (
              <div
                className="admin-credential-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="admin-credential-title"
              >
                <h3 id="admin-credential-title">Credencial de {credencialUnica.operator} — exibição única</h3>
                <p>
                  Copie e entregue por canal seguro. Ela não será exibida novamente e o servidor
                  recebeu apenas o SHA-256.
                </p>
                <output className="admin-credential-value">{credencialUnica.credencial}</output>
                <div className="admin-credential-actions">
                  <button
                    type="button"
                    onClick={() => { void navigator.clipboard.writeText(credencialUnica.credencial); }}
                  >
                    Copiar
                  </button>
                  <a
                    className="admin-credential-download"
                    download={`credencial-${credencialUnica.operator}.txt`}
                    href={credencialBlobUrl ?? undefined}
                  >
                    Baixar
                  </a>
                  <label className="admin-credential-confirm">
                    <input
                      type="checkbox"
                      checked={credencialSalvaConfirmada}
                      onChange={(e) => setCredencialSalvaConfirmada(e.target.checked)}
                    />
                    Confirmo que salvei esta credencial em local seguro
                  </label>
                  <button
                    type="button"
                    disabled={!credencialSalvaConfirmada}
                    onClick={() => {
                      setCredencialUnica(null);
                      setCredencialSalvaConfirmada(false);
                    }}
                  >
                    Encerrar
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <nav className="campaign-journey" aria-label="Macroetapas da jornada operacional">
          <ol>
            {MACROETAPAS_UI.map((macro) => (
              <li key={macro.numero} className={macroAtiva === macro.numero ? "is-active" : undefined}>
                <span className="campaign-macro-pill" title={macro.descricao}>
                  <span>{String(macro.numero).padStart(2, "0")}</span>
                  <strong>{ROTULO_MACROETAPA[macro.numero]}</strong>
                </span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="campaign-activity-toggle"
            onClick={() => setPainelAtividade((atual) => !atual)}
            aria-expanded={painelAtividade}
          >
            {painelAtividade ? "Ocultar histórico de etapas" : "Consultar histórico das 10 etapas"}
          </button>
          {painelAtividade ? (
            <div className="campaign-activity" aria-label="Histórico das etapas da jornada">
              <ol>
                {ETAPAS.map((item) => (
                  <li key={item.numero}>
                    <button
                      type="button"
                      onClick={() => setEtapaConsulta(item.numero)}
                      aria-current={etapaConsulta === item.numero ? "true" : undefined}
                    >
                      <span>{String(item.numero).padStart(2, "0")}</span>
                      <strong>{ROTULOS_ETAPA[item.numero]}</strong>
                    </button>
                  </li>
                ))}
              </ol>
              <p className="campaign-actions-note">
                {String(etapaConsulta).padStart(2, "0")} · {ROTULOS_ETAPA[etapaConsulta]} —{" "}
                {ETAPAS.find((item) => item.numero === etapaConsulta)?.descricao ?? ""}
              </p>
            </div>
          ) : null}
        </nav>

        <section className="campaign-counters" aria-label="Contadores da campanha">
          <article><span>Operador</span><strong>{me.code}</strong><small>Papéis: {me.roles.join(", ") || "—"}</small></article>
          <article><span>Campanha</span><strong>{status ? (status.campaign.enabled ? "ATIVA" : "AGUARDANDO GATE") : "—"}</strong><small>{statusErro || "Fase FOUNDATION · persistência de importação desligada"}</small></article>
          <article><span>Total</span><strong>{base?.total_registros ?? 0}</strong><small>Linhas classificadas no servidor</small></article>
          <article><span>Aptos</span><strong>{aptosParaAprovacao.length}</strong><small>Após exclusões humanas</small></article>
          <article><span>Bloqueados</span><strong>{base?.bloqueados ?? 0}</strong><small>Regra do importador canônico</small></article>
          <article><span>Excluídos</span><strong>{excluidos.length}</strong><small>Decisão humana registrada nesta sessão</small></article>
          <article><span>Aprovadas</span><strong>{aprovacao ? aprovacao.totalItens : 0}</strong><small>{aprovacao ? `Hash ${aprovacao.conteudoHash.slice(0, 12)}…` : "Nenhuma aprovação vigente"}</small></article>
          <article><span>Pendentes</span><strong>{base?.inconsistencias_pendentes ?? 0}</strong><small>Aguardando decisão do REVISOR</small></article>
          <article><span>Enviados</span><strong>0</strong><small>canExecute=false nesta fase</small></article>
          <article><span>Falhas</span><strong>0</strong><small>Nenhum envio autorizado</small></article>
        </section>

        <p className="campaign-actions-note">
          Macroetapa: {macroAtiva} · {ROTULO_MACROETAPA[macroAtiva]} · Foco: {visaoMacro.foco} ·
          Ações disponíveis: {status?.availableActions.join(", ") || "—"}
        </p>
        <p className="campaign-actions-note">
          Bloqueadas: EXECUTAR_LOTE (canExecute=false nesta fase) · ACOMPANHAR_PAUSAR_CANCELAR
          (nenhum lote em execução — canCreateBatch=false) · ADMIN_TECNICO não recebe poder
          operacional implícito.
        </p>

        {erroEtapa ? (
          <p className="campaign-feedback campaign-feedback-error" role="alert">{erroEtapa}</p>
        ) : null}

        {/* Macroetapa 2 — Importação */}
        {mostrarImportacao && (
          <section className="campaign-panel" aria-labelledby="etapa-importacao">
            <h2 id="etapa-importacao">3 · Importação da base</h2>
            <p>
              Envie o XLSX da base institucional. O servidor faz o pré-voo seguro (extensão,
              tamanho, macros, fórmulas), calcula o SHA-256 e devolve cabeçalhos e folhas — nada é
              assumido e nada é persistido.
            </p>
            <input
              type="file"
              accept=".xlsx"
              onChange={(event) => {
                setArquivo(event.target.files?.[0] ?? null);
                setAvaliacaoArquivo(null);
                setBase(null);
                setAprovacao(null);
                setCampanha(null);
                setErroEtapa("");
              }}
              disabled={avaliando}
            />
            <div className="campaign-panel-actions">
              <button type="button" onClick={analisarArquivo} disabled={!arquivo || avaliando || !podeImportar}>
                {avaliando ? "Analisando…" : "Analisar arquivo"}
              </button>
              <button type="button" onClick={alternativaSintetica} disabled={avaliando || !podeImportar}>
                Usar base sintética de desenvolvimento
              </button>
              {motivosBloqueioImportacao.map((motivo) => (
                <small key={motivo} role="status">Bloqueado: {motivo}</small>
              ))}
            </div>
          </section>
        )}

        {/* Macroetapa 2 — Mapeamento (somente campos pendentes de decisão) */}
        {mostrarMapeamento && avaliacaoArquivo && (
          <section className="campaign-panel" aria-labelledby="etapa-mapeamento">
            <h2 id="etapa-mapeamento">4 · Mapeamento de colunas</h2>
            {avaliacaoArquivo ? (
              <p className="campaign-flow-stats">
                SHA-256: <code>{avaliacaoArquivo.sha256}</code> · Folhas:{" "}
                {avaliacaoArquivo.folhas_disponiveis.join(", ")} · Linhas:{" "}
                {avaliacaoArquivo.total_linhas} · Cabeçalhos:{" "}
                {avaliacaoArquivo.cabecalhos.join(" · ") || "—"}
              </p>
            ) : null}
            {avaliacaoArquivo && pendenciasMapeamento(mapeamento, CAMPOS_OBRIGATORIOS).length > 0 ? (
              <p className="campaign-actions-note" role="status">
                Mapeamento ambíguo: apenas os campos obrigatórios pendentes exigem decisão humana —
                o restante já foi sugerido pelas regras homologadas.
              </p>
            ) : null}
            <p>
              Confirme campo a campo a coluna de origem. Campos obrigatórios precisam estar
              mapeados; cada coluna origina no máximo um campo. Campos derivados permanecem sem
              coluna — o servidor calcula.
            </p>
            <table className="campaign-table">
              <thead>
                <tr>
                  <th>Campo do contrato</th>
                  <th>Coluna original</th>
                  <th>Seleção</th>
                </tr>
              </thead>
              <tbody>
                {CAMPOS_MAPEAMENTO.map((campo) => (
                  <tr key={campo}>
                    <td>
                      <strong>{ROTULOS_CAMPO[campo] ?? campo}</strong>
                      <small> {campo}</small>
                      {CAMPOS_OBRIGATORIOS.includes(campo as (typeof CAMPOS_OBRIGATORIOS)[number]) ? (
                        <em className="campaign-required"> obrigatório</em>
                      ) : null}
                    </td>
                    <td>
                      {typeof mapeamento[campo] === "number"
                        ? avaliacaoArquivo.cabecalhos[mapeamento[campo]] ?? `Coluna ${mapeamento[campo] + 1}`
                        : "— derivado no servidor —"}
                    </td>
                    <td>
                      <select
                        value={typeof mapeamento[campo] === "number" ? String(mapeamento[campo]) : ""}
                        onChange={(event) => {
                          const valor = event.target.value;
                          const proximo = { ...mapeamento };
                          if (valor === "") {
                            delete proximo[campo];
                          } else {
                            const coluna = Number(valor);
                            if (Number.isInteger(coluna) && coluna >= 0) proximo[campo] = coluna;
                          }
                          setMapeamento(proximo);
                        }}
                        disabled={avaliando}
                      >
                        <option value="">— não mapeado —</option>
                        {avaliacaoArquivo.cabecalhos.map((cabecalho, indice) => (
                          <option
                            key={`${indice}-${cabecalho}`}
                            value={String(indice)}
                          >
                            {indice + 1} · {cabecalho}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="campaign-panel-actions">
              <button
                type="button"
                onClick={() => {
                  if (!arquivo || !avaliacaoArquivo) return;
                  const pendentes = pendenciasMapeamento(mapeamento, CAMPOS_OBRIGATORIOS);
                  if (pendentes.length > 0) {
                    setErroEtapa(`Mapeamento incompleto: ${pendentes.join(", ")}.`);
                    return;
                  }
                  setErroEtapa("");
                  void avaliarArquivoSubmetido(arquivo, mapeamento);
                }}
                disabled={avaliando || !podeImportar}
              >
                {avaliando ? "Avaliando…" : "Confirmar mapeamento e classificar"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAvaliacaoArquivo(null);
                  setMapeamento({});
                  setArquivo(null);
                  setErroEtapa("");
                  setEtapa(3);
                }}
                disabled={avaliando}
              >
                Trocar arquivo
              </button>
              {motivosBloqueioImportacao.map((motivo) => (
                <small key={motivo} role="status">Bloqueado: {motivo}</small>
              ))}
            </div>
          </section>
        )}
        {mostrarMapeamento && !avaliacaoArquivo ? (
          <section className="campaign-panel">
            <h2>4 · Mapeamento de colunas</h2>
            <p>Nenhum arquivo analisado nesta sessão. Volte à etapa 3 para importar.</p>
            <button type="button" onClick={() => setEtapa(3)}>Ir para a importação</button>
          </section>
        ) : null}

        {/* Macroetapa 3 — Revisão + prévia UNIFICADAS (UX-FLOW-01A regra 7) */}
        {mostrarRevisao && base && (
          <section className="campaign-panel" aria-labelledby="etapa-revisao">
            <h2 id="etapa-revisao">Revisão dos profissionais e aprovação</h2>
            <p>
              Base final por identificador institucional. Marque exclusões apenas quando a decisão
              humana justificar (EXCLUIR_DO_LOTE); a marcação invalida qualquer aprovação vigente.
            </p>
            {base.sha256 === "sintetico-dev" ? (
              <p className="campaign-actions-note" role="status">
                Base sintética: o mapeamento é automático por construção (cabeçalhos canônicos) —
                não há etapa manual de mapeamento para esta base.
              </p>
            ) : null}
            {mostrarPendenciasRevisao ? (
              <div className="campaign-exceptions">
                <h3>Exceções aguardando decisão humana</h3>
                <p>
                  Duplicidades e divergências de normalização exigem decisão do papel REVISOR.
                  Decida na tabela de revisão abaixo (EXCLUIR_DO_LOTE); nada é corrigido
                  automaticamente e o arquivo original nunca é alterado.
                </p>
                <table className="campaign-table">
                  <thead>
                    <tr>
                      <th>Linha</th>
                      <th>Identificador</th>
                      <th>E-mail normalizado</th>
                      <th>Inconsistências</th>
                      <th>Motivos de bloqueio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {base.registros
                      .filter((registro) => registro.inconsistencias.length > 0)
                      .map((registro) => (
                        <tr key={registro.linha}>
                          <td>{registro.linha}</td>
                          <td><code>{registro.profissional_id || "—"}</code></td>
                          <td>{mascararEmail(registro.email_normalizado) || "—"}</td>
                          <td>{registro.inconsistencias.join(", ")}</td>
                          <td>{registro.motivo_bloqueio.join(", ") || "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {base.duplicidades_email.length > 0 ? (
                  <div className="campaign-flow-stats">
                    <p>Grupos de e-mail duplicado:</p>
                    <ul>
                      {base.duplicidades_email.map((grupo) => (
                        <li key={grupo.email_normalizado}>
                          {mascararEmail(grupo.email_normalizado)} · linhas {grupo.linhas.join(", ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
            <table className="campaign-table">
              <thead>
                <tr>
                  <th>Linha</th>
                  <th>Identificador</th>
                  <th>Nome</th>
                  <th>E-mail (mascarado)</th>
                  <th>Status</th>
                  <th>Motivos</th>
                  <th>Decisão</th>
                </tr>
              </thead>
              <tbody>
                {base.registros.map((registro) => {
                  const excluido = excluidos.includes(registro.linha);
                  return (
                    <tr key={registro.linha} className={excluido ? "is-excluded" : undefined}>
                      <td>{registro.linha}</td>
                      <td><code>{registro.profissional_id || "—"}</code></td>
                      <td>{registro.nome || "—"}</td>
                      <td>{mascararEmail(registro.email_original) || "—"}</td>
                      <td>
                        {excluido ? "EXCLUIDO_DO_LOTE" : registro.status_validacao}
                      </td>
                      <td>{registro.motivo_bloqueio.join(", ") || "—"}</td>
                      <td>
                        <label className="campaign-decision">
                          <input
                            type="checkbox"
                            checked={excluido}
                            onChange={() => alternarExclusao(registro.linha)}
                          />
                          Excluir do lote
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="campaign-panel-actions">
              <a
                className="campaign-anchor-link"
                href="#etapa-previa"
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById("etapa-previa")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                Ver prévia da comunicação ({aptosParaAprovacao.length} aptos)
              </a>
              <button
                type="button"
                onClick={() => {
                  setArquivo(null);
                  setAvaliacaoArquivo(null);
                  setMapeamento({});
                  setBase(null);
                  setAprovacao(null);
                  setExcluidos([]);
                  setErroEtapa("");
                  setEtapa(3);
                }}
                disabled={avaliando || persistindo || criandoLote}
              >
                Importar outra base
              </button>
              {aptosParaAprovacao.length === 0 ? (
                <small role="status">Bloqueado: nenhum profissional apto após exclusões.</small>
              ) : null}
            </div>
          </section>
        )}
        {etapa === 6 && !base ? (
          <section className="campaign-panel">
            <h2>6 · Revisão dos profissionais</h2>
            <p>Nenhuma base avaliada nesta sessão.</p>
            <button type="button" onClick={() => setEtapa(3)}>Ir para a importação</button>
          </section>
        ) : null}

        {/* Macroetapa 3 — Prévia da comunicação (mesma superfície da revisão) */}
        {mostrarRevisao && base && (
          <section className="campaign-panel" aria-labelledby="etapa-previa">
            <h2 id="etapa-previa">Prévia da comunicação</h2>
            <p>
              Prévia gerada pelo SERVIDOR com o mesmo registry/renderer do envio
              (PREFILLED_CONFIRMATION). Nada é enviado nesta fase; destinatários permanecem
              mascarados na interface.
            </p>
            <div className="campaign-preview-nav">
              <button
                type="button"
                onClick={() => setPreviaIndice((atual) => Math.max(atual - 1, 0))}
                disabled={previaIndice === 0}
              >
                ← Anterior
              </button>
              <span>
                Mensagem {Math.min(previaIndice + 1, aptosParaAprovacao.length)} de{" "}
                {aptosParaAprovacao.length}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPreviaIndice((atual) => Math.min(atual + 1, Math.max(aptosParaAprovacao.length - 1, 0)))
                }
                disabled={previaIndice >= aptosParaAprovacao.length - 1}
              >
                Próxima →
              </button>
            </div>
            {previaMensagemServidor ? (
              <pre className="campaign-preview">
                {`Assunto: ${previaMensagemServidor.assunto}\n\n${previaMensagemServidor.mensagem.textBody}`}
              </pre>
            ) : previaCarregando ? (
              <p role="status">Carregando prévia do servidor…</p>
            ) : previaErro !== "" ? (
              <p role="alert">{previaErro}</p>
            ) : templateSelecionada === "" ? (
              <p>Selecione um template registrado (APPROVED) para visualizar a prévia.</p>
            ) : (
              <p>Nenhuma mensagem elegível para prévia.</p>
            )}
            <div className="campaign-panel-actions">
              <a
                className="campaign-anchor-link"
                href="#etapa-aprovacao"
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById("etapa-aprovacao")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                Ir para a aprovação
              </a>
            </div>
          </section>
        )}

        {/* Macroetapa 3 — Aprovação e congelamento (ações humanas explícitas) */}
        {mostrarRevisao && base && (
          <section className="campaign-panel" aria-labelledby="etapa-aprovacao">
            <h2 id="etapa-aprovacao">8 · Aprovação e congelamento</h2>
            <p>
              A aprovação é calculada no servidor a partir do conteúdo submetido: versão do
              template + registros aptos. Qualquer alteração posterior de destinatário, template ou
              conteúdo invalida a aprovação — o hash deixa de corresponder.
            </p>
            <div className="campaign-field" style={{ margin: "0.75rem 0" }}>
              <label htmlFor="template-selecionada">
                Template (registrada · APPROVED · escopo PF_CAMPAIGN):
              </label>{" "}
              <select
                id="template-selecionada"
                value={templateSelecionada}
                onChange={(event) => {
                  setTemplateSelecionada(event.target.value);
                  setAprovacao(null);
                  setPreviaMensagemServidor(null);
                  setPreviaErro("");
                }}
              >
                <option value="">— selecione explicitamente —</option>
                {templatesSelecionaveis.map((t) => (
                  <option key={t.templateVersao} value={t.templateVersao}>
                    {t.templateVersao} · {t.dataMode}
                  </option>
                ))}
              </select>
              {templatesSelecionaveis.length === 0 ? (
                <small role="status"> Catálogo indisponível — aprovação bloqueada.</small>
              ) : null}
            </div>
            <ul className="campaign-flow-stats">
              <li>Itens elegíveis: {aptosParaAprovacao.length}</li>
              <li>Excluídos por decisão humana: {excluidos.length}</li>
              <li>Aprovadas: {aprovacao ? aprovacao.totalItens : 0}</li>
              <li>Pendentes de aprovação: {aprovacao ? 0 : aptosParaAprovacao.length}</li>
              <li>Enviados: 0 · Falhas: 0 (canExecute=false)</li>
            </ul>
            {aprovacao ? (
              <div className="campaign-flow-stats">
                <p>
                  Aprovação congelada · SHA-256 <code>{aprovacao.conteudoHash}</code> ·{" "}
                  {aprovacao.totalItens} itens · persistida: {String(aprovacao.persistida)}.
                </p>
                <p>{aprovacao.aviso}</p>
              </div>
            ) : null}
            {visaoEtapa.mostrarCtaPersistencia ? (
              <div className="campaign-persist-cta">
                <p>
                  Aprovação congelada. Próxima ação: <strong>persistir a campanha</strong> no
                  PostgreSQL e criar o lote controlado (outbox em HOLD — não executável, Gmail não
                  é chamado).
                </p>
                <div className="campaign-panel-actions">
                  <button
                    type="button"
                    onClick={persistirCampanha}
                    disabled={persistindo || !podePersistir}
                  >
                    {persistindo
                      ? "Persistindo…"
                      : campanha
                        ? "Campanha persistida ✓"
                        : "Persistir campanha"}
                  </button>
                  <button
                    type="button"
                    onClick={criarLoteCampanha}
                    disabled={criandoLote || !visaoEtapa.mostrarCtaCriarLote}
                  >
                    {criandoLote
                      ? "Criando lote…"
                      : campanha?.loteId
                        ? "Lote criado ✓"
                        : "Criar lote controlado (HOLD)"}
                  </button>
                </div>
                {campanha && !campanha.loteId && !visaoEtapa.mostrarCtaCriarLote ? (
                  <small role="status">
                    Criação de lote exige papel EXECUTOR ativo e o gate canCreateBatch habilitado.
                  </small>
                ) : null}
              </div>
            ) : null}
            <label className="campaign-decision">
              <input
                type="checkbox"
                checked={confirmacaoAprovacao === "APROVAR"}
                onChange={(event) => setConfirmacaoAprovacao(event.target.checked ? "APROVAR" : "")}
              />
              Confirmo a aprovação formal do conteúdo revisado (APROVADOR).
            </label>
            <div className="campaign-panel-actions">
              <button
                type="button"
                onClick={aprovar}
                disabled={avaliando || confirmacaoAprovacao !== "APROVAR" || !podeAprovar || aptosParaAprovacao.length === 0}
              >
                {avaliando ? "Aprovando…" : "Aprovar e congelar conteúdo"}
              </button>
              {motivosBloqueioAprovacao.map((motivo) => (
                <small key={motivo} role="status">Bloqueado: {motivo}</small>
              ))}
              {podeAprovar && aptosParaAprovacao.length === 0 ? (
                <small role="status">Bloqueado: nenhum item elegível após decisões humanas.</small>
              ) : null}
            </div>
          </section>
        )}

        {/* Macroetapa 4 — Campanha persistida reconstruída do PostgreSQL:
            painel próprio, independe de base/aprovacao da sessão. */}
        {mostrarOperacao && campanha ? (
          <section className="campaign-panel" aria-labelledby="etapa-campanha-reconstruida">
            <h2 id="etapa-campanha-reconstruida">8 · Campanha reconstruída do PostgreSQL</h2>
            <ul className="campaign-flow-stats">
              <li>Campanha: <code>{campanha.campanhaId}</code></li>
              <li>Estado: {campanha.estado}</li>
              <li>Hash congelado: <code>{campanha.hashAprovacao}</code></li>
              <li>Itens aprovados: {campanha.totalAprovados}</li>
              <li>
                Lote:{" "}
                {campanha.loteId
                  ? `${campanha.loteCodigo ?? ""} · ${campanha.loteEstado ?? ""}`.trim()
                  : "não criado"}
              </li>
              <li>
                Outbox: {campanha.outboxTotal} item(ns) · não executáveis:{" "}
                {campanha.outboxNaoExecutavel}
              </li>
            </ul>
            {visaoEtapa.mostrarCtaCriarLote ? (
              <div className="campaign-persist-cta">
                <p>
                  Lote ainda não criado para esta campanha. Próxima ação:{" "}
                  <strong>criar o lote controlado</strong> (outbox em HOLD — não
                  executável, Gmail não é chamado).
                </p>
                <div className="campaign-panel-actions">
                  <button
                    type="button"
                    onClick={criarLoteCampanha}
                    disabled={criandoLote || !visaoEtapa.mostrarCtaCriarLote}
                  >
                    {criandoLote ? "Criando lote…" : "Criar lote controlado (HOLD)"}
                  </button>
                </div>
              </div>
            ) : null}
            {!campanha.loteId && !visaoEtapa.mostrarCtaCriarLote ? (
              <small role="status">
                Criação de lote exige papel EXECUTOR ativo e o gate canCreateBatch habilitado.
              </small>
            ) : null}
            {visaoEtapa.mostrarLoteExistente ? (
              <p>Lote já criado — nenhuma segunda ação de criação é oferecida.</p>
            ) : null}
          </section>
        ) : null}


        {/* SLICE-03B — Plano de controle operacional (Macroetapa 4):
            readiness read-only, bloqueios objetivos e ações que refletem
            EXCLUSIVAMENTE a capacidade retornada pelo servidor. Nenhuma
            ação envia, nenhuma deriva autorização no cliente. */}
        {mostrarOperacao && campanha ? (
          <section className="campaign-panel" aria-labelledby="controle-operacional">
            <h2 id="controle-operacional">Controle operacional (readiness)</h2>
            {readinessErro ? (
              <p role="alert" className="campaign-session-error">{readinessErro}</p>
            ) : null}
            {!readiness && !readinessErro ? (
              <p role="status">Carregando readiness operacional…</p>
            ) : null}
            {/* GF4.5C.1 — resultado/erro do canário visíveis INDEPENDENTES do
                readiness: um resultado definitivo do POST permanece exibido
                mesmo com o readiness invalidado (null) aguardando nova
                leitura autoritativa. */}
            {acaoMensagem ? (
              <p role="status" className="campaign-actions-note">{acaoMensagem}</p>
            ) : null}
            {acaoErro ? (
              <p role="alert" className="campaign-session-error">{acaoErro}</p>
            ) : null}
            {readiness ? (
              <>
                <ul className="campaign-flow-stats">
                  <li>
                    Lote: <code>{readiness.lote.codigo}</code> · estado{" "}
                    <strong>{readiness.lote.estado}</strong> · {readiness.lote.totalItens}{" "}
                    item(ns)
                  </li>
                  <li>
                    Itens por estado:{" "}
                    {Object.entries(readiness.lote.contagemPorEstado).length === 0
                      ? "—"
                      : Object.entries(readiness.lote.contagemPorEstado)
                          .map(([estado, total]) => `${estado}=${total}`)
                          .join(" · ")}
                  </li>
                  <li>
                    Políticas: canPrepareBatch={String(readiness.politicas.canPrepareBatch)} ·
                    canExecute={String(readiness.politicas.canExecute)} ·
                    realSendEnabled={String(readiness.politicas.realSendEnabled)} ·
                    canarySendEnabled={String(readiness.politicas.canarySendEnabled)} ·{" "}
                    batchSendEnabled={String(readiness.politicas.batchSendEnabled)} (somente
                    diagnóstico; a autoridade é a ação EXECUTAR_LOTE)
                  </li>
                  <li>
                    OAuth: configuração={String(readiness.oauth.configurationReady)} · conexão
                    persistida={String(readiness.oauth.connectionStored)} · conta esperada
                    correspondente={String(readiness.oauth.storedAccountMatchesExpected)} ·
                    estado={readiness.oauth.executionReady ? "CONNECTED" : "NÃO_CONECTADO"} (sem
                    teste ao vivo de token)
                  </li>
                  <li>
                    Autorização humana:{" "}
                    {readiness.autorizacaoHumana.concedida
                      ? "vigente (registro auditado)"
                      : "ausente"}
                  </li>
                  <li>
                    Ativação: proofKeyReady=
                    {String(readiness.ativacao.proofKeyReady)} ·
                    canaryRecipientConfigured=
                    {String(readiness.ativacao.canaryRecipientConfigured)} ·
                    canarySelected={String(readiness.ativacao.canarySelected)} ·
                    providerReady={String(readiness.ativacao.providerReady)}
                  </li>
                  <li>
                    Provider: indisponível nesta fase · envio real desabilitado:{" "}
                    {String(readiness.envioRealDesabilitado)}
                  </li>
                  <li>
                    Canário: armado={String(readiness.envioCanario.armado)} · wiring do
                    provider={String(readiness.envioCanario.providerWiringReady)} · gate
                    operacional: {readiness.envioCanario.gateOperacional}
                  </li>
                  <li>Próxima ação necessária: {readiness.proximaAcao}</li>
                </ul>
                {readiness.lote.estado === "HOLD" || readiness.lote.estado === "PREPARADO" ? (
                  <p className="campaign-actions-note">
                    <strong>
                      LOTE_{readiness.lote.estado === "HOLD" ? "CRIADO" : "PREPARADO"} /{" "}
                      {readiness.lote.estado}
                    </strong>{" "}
                    — {readiness.lote.totalItens} itens · execução indisponível · motivo:{" "}
                    {readiness.acoes.EXECUTAR_ITEM.bloqueios.join(", ") || "políticas fechadas"} ·
                    próxima ação: {readiness.proximaAcao}
                  </p>
                ) : null}
                <div className="campaign-panel-actions">
                  <button
                    type="button"
                    disabled={
                      !readiness.acoes.PREPARAR_LOTE.permitida ||
                      acaoPendente !== null
                    }
                    onClick={() => void executarAcaoControle("PREPARAR")}
                  >
                    {acaoPendente === "PREPARAR" ? "Preparando…" : "Preparar lote"}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !readiness.acoes.AUTORIZAR_EXECUCAO.permitida ||
                      acaoPendente !== null
                    }
                    onClick={() => void executarAcaoControle("AUTORIZAR")}
                  >
                    {acaoPendente === "AUTORIZAR" ? "Autorizando…" : "Autorizar execução"}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !readiness.acoes.ATIVAR_LOTE.permitida ||
                      acaoPendente !== null
                    }
                    onClick={() => void executarAcaoControle("ATIVAR")}
                  >
                    {acaoPendente === "ATIVAR" ? "Ativando…" : "Ativar lote"}
                  </button>
                  {/* SLICE-03C.1 — Executar (genérico) permanece SEMPRE
                      disabled e SEM onClick: nenhum handler chama
                      execute-attempt no cliente. GF4.5 — Executar canário é
                      o ÚNICO caminho de envio exposto, governado
                      EXCLUSIVAMENTE pelo readiness server-driven
                      (EXECUTAR_CANARIO.permitida) + guarda de duplo clique;
                      com as políticas fechadas ele permanece desabilitado. */}
                  <button type="button" disabled>
                    Executar (provider indisponível — envio não autorizado)
                  </button>
                  <button
                    type="button"
                    disabled={
                      !readiness.acoes.EXECUTAR_CANARIO.permitida ||
                      acaoPendente !== null ||
                      canarioPendente
                    }
                    onClick={() => void executarCanarioOperacionalUI()}
                  >
                    {canarioPendente
                      ? "Executando canário…"
                      : "Executar canário controlado"}
                  </button>

                  {/* GF5.3 — Executar lote: ÚNICA superfície de execução do
                      lote, governada EXCLUSIVAMENTE pelo readiness
                      server-driven (EXECUTAR_LOTE.permitida) + guarda de
                      duplo clique (lotePendente). Janela limitada do
                      servidor (máx 10 itens); PARCIAL/INTERROMPIDO aguardam
                      nova ação humana explícita. O rótulo Continuar lote é
                      derivado SOMENTE do estado sanitizado do servidor e não
                      altera a autoridade. */}
                  <button
                    type="button"
                    disabled={
                      !readiness.acoes.EXECUTAR_LOTE.permitida ||
                      acaoPendente !== null ||
                      canarioPendente ||
                      lotePendente
                    }
                    onClick={() => void executarLoteOperacionalUI()}
                  >
                    {lotePendente
                      ? "Executando lote…"
                      : (readiness.lote.contagemPorEstado.PREPARADO ?? 0) > 10
                        ? "Continuar lote"
                        : "Executar lote"}
                  </button>
                </div>
                <small role="status">
                  Ações refletem a capacidade retornada pelo servidor; cada uma chama somente a
                  sua rota e recarrega o readiness. Executar permanece indisponível — nenhum
                  provider está montado nesta fatia e nada é enviado.
                </small>
              </>
            ) : null}
          </section>
        ) : null}

        {/* Macroetapa 4 — Acompanhamento (estado persistido + sessão) */}
        {mostrarOperacao && (
          <section className="campaign-panel" aria-labelledby="etapa-acompanhamento">
            <h2 id="etapa-acompanhamento">10 · Acompanhamento</h2>
            {campanha ? (
              <p>
                Estado reconstruído do PostgreSQL — recarregar a página, sair e entrar novamente
                não apaga a campanha persistida.
              </p>
            ) : (
              <p>
                Contadores operacionais consolidados da sessão. Nenhum envio foi realizado; os
                contadores de envio permanecem zerados por construção.
              </p>
            )}
            {campanha ? (
              <table className="campaign-table">
                <thead>
                  <tr><th>Estado persistido</th><th>Valor</th></tr>
                </thead>
                <tbody>
                  <tr><td>Campanha</td><td><code>{campanha.campanhaId}</code></td></tr>
                  <tr><td>Operador responsável</td><td><code>{campanha.operatorId}</code></td></tr>
                  <tr><td>Hash de aprovação</td><td><code>{campanha.hashAprovacao.slice(0, 16)}…</code></td></tr>
                  <tr><td>Estado</td><td>{campanha.estado}</td></tr>
                  <tr><td>Registros</td><td>{campanha.totalRegistros}</td></tr>
                  <tr><td>Aptos · Bloqueados</td><td>{campanha.totalAptos} · {campanha.totalBloqueados}</td></tr>
                  <tr><td>Aprovados</td><td>{campanha.totalAprovados}</td></tr>
                  <tr><td>Lote</td><td>{campanha.loteId ? `${campanha.loteCodigo ?? ""} · ${campanha.loteEstado}` : "não criado"}</td></tr>
                  <tr><td>Outbox (HOLD · não executável)</td><td>{campanha.outboxNaoExecutavel} de {campanha.outboxTotal}</td></tr>
                  <tr><td>Executável pelo worker</td><td>0 — Gmail não foi chamado</td></tr>
                </tbody>
              </table>
            ) : null}
            <table className="campaign-table">
              <thead>
                <tr><th>Indicador da sessão</th><th>Valor</th></tr>
              </thead>
              <tbody>
                <tr><td>Total classificado</td><td>{base?.total_registros ?? 0}</td></tr>
                <tr><td>Aptos (após exclusões)</td><td>{aptosParaAprovacao.length}</td></tr>
                <tr><td>Bloqueados</td><td>{base?.bloqueados ?? 0}</td></tr>
                <tr><td>Excluídos por decisão humana</td><td>{excluidos.length}</td></tr>
                <tr><td>Mensagens aprovadas</td><td>{aprovacao ? aprovacao.totalItens : 0}</td></tr>
                <tr><td>Mensagens pendentes</td><td>{base?.inconsistencias_pendentes ?? 0}</td></tr>
                <tr><td>Enviados</td><td>0</td></tr>
                <tr><td>Falhas</td><td>0</td></tr>
              </tbody>
            </table>
            <ul className="campaign-flow-stats">
              <li>canPersistImport: {String(status?.campaign.canPersistImport ?? false)}</li>
              <li>canCreateBatch: {String(status?.campaign.canCreateBatch ?? false)}</li>
              <li>canExecute: false · envio real bloqueado · Gmail não chamado</li>
            </ul>
          </section>
        )}

        <section className="campaign-guardrail" aria-label="Regras de segurança">
          <strong>Execução continua bloqueada: nada é enviado nesta fase.</strong>
          <p>
            A identidade individual e os papéis são verificados no servidor em cada mutação.
            Persistência e criação de lote dependem de flags server-side explícitas (default
            fechado); a outbox nasce em HOLD, não capturável pelo worker. CONTROLLED_GMAIL_TEST
            permanece exclusivo do piloto técnico.
          </p>
        </section>
      </main>
    </div>
  );
}
