import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { AppHeader } from "../components/AppHeader";
import { campaignLogoutDisposition } from "./campaign-logout-state";
import { visaoEtapa8 } from "./campaign-step8-presentation";
import {
  CHAVE_HASH_SESSAO,
  disposicaoRetomada,
  LIMPEZA_RETOMADA,
  recuperacaoPorHashPermitida,
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
  realSendEnabled: boolean;
};

type RegistroAprovacao = {
  profissional_id: string;
  nome: string;
  email_normalizado: string;
  status_validacao: string;
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
  readonly profissional_id: string;
  readonly nome: string;
  readonly nome_exibicao: string;
  readonly email_original: string;
  readonly email_normalizado: string;
  readonly status_validacao: "APTO" | "BLOQUEADO" | "EXCLUIDO_DO_LOTE";
  readonly motivo_bloqueio: readonly string[];
  readonly normalizacoes_aplicadas: readonly string[];
  readonly inconsistencias: readonly string[];
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

const TEMPLATE_VERSAO_PADRAO = "pf-atualizacao-cadastral-2026-v1";

/** Prévia textual determinística da mensagem (etapa 7) — destinatário mascarado. */
function previaMensagem(registro: RegistroAvaliado): string {
  const primeiroNome = registro.nome.split(/\s+/)[0] ?? registro.nome;
  return `Assunto: Atualização cadastral — Confira seus dados\nPara: ${mascararEmail(registro.email_normalizado)}\n\nOlá, ${primeiroNome}.\n\nIdentificamos que seus dados cadastrais precisam de revisão. Confira as informações no link seguro enviado pela equipe.\n\nTemplate ${TEMPLATE_VERSAO_PADRAO} · mensagem sujeita a aprovação formal.`;
}

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
  const [hashSessao, setHashSessao] = useState(sessionStorage.getItem(CHAVE_HASH_SESSAO) ?? "");
  // UX-FLOW-01A — detalhamento das dez etapas: consulta (painel), não wizard.
  const [painelAtividade, setPainelAtividade] = useState(false);
  const [etapaConsulta, setEtapaConsulta] = useState<Etapa>(1);
  // UX-FLOW-01B — retomada server-driven (descoberta por operator_id).
  const [retomada, setRetomada] = useState<RetomadaEstado>({ status: "indefinida" });
  const [retomando, setRetomando] = useState(false);
  const [retomadaErro, setRetomadaErro] = useState("");
  // Corretivo MULTIPLE/HASH RACE — modo definido EXCLUSIVAMENTE pela
  // descoberta server-driven (resumable): EMPTY/SINGLE/MULTIPLE decide antes
  // e coordena a recuperação legado por hash (que nunca é mecanismo
  // paralelo de seleção).
  const [modoRetomada, setModoRetomada] = useState<ModoDescobertaRetomada>("INDEFINIDO");

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

  // SLICE-02 / corretivo MULTIPLE-HASH-RACE — Recuperação por hash CONGELADO
  // é CONVENIÊNCIA de precisão, NUNCA mecanismo paralelo de seleção. A
  // descoberta server-driven (resumable) é a autoridade e coordena este
  // efeito de forma determinística (módulo puro `recuperacaoPorHashPermitida`):
  // · INDEFINIDO (descoberta em voo) → hash NEM inicia (/persisted "mais
  //   rápido" que a descoberta não existe: gate fechado antes da request);
  // · MULTIPLE sem seleção explícita → hash NÃO seleciona (gate bloqueia);
  // · EMPTY → nenhuma campanha é reativada;
  // · SINGLE → hash converge para a MESMA campanha autorizada;
  // · MULTIPLE pós-seleção explícita → converge para a selecionada.
  // O efeito re-executa quando o modo muda: o cleanup (`ativo`) cancela o
  // /persisted em voo — uma resposta atrasada NÃO reativa campanha depois de
  // a descoberta ter determinado o modo.
  useEffect(() => {
    if (!me || !hashSessao) {
      if (!hashSessao) setCampanha(null);
      return;
    }
    if (
      !recuperacaoPorHashPermitida({
        modo: modoRetomada,
        campanhaAplicada: retomada.status === "aplicada",
      })
    ) {
      return;
    }
    let ativo = true;
    void (async () => {
      try {
        const resposta = await fetchJson<{ campanha: CampanhaPersistida }>(
          `/api/campaigns/persisted?hash=${encodeURIComponent(hashSessao)}`,
        );
        if (ativo) setCampanha(resposta.campanha);
      } catch {
        if (ativo) setCampanha(null);
      }
    })();
    return () => {
      ativo = false;
    };
  }, [me, hashSessao, modoRetomada, retomada]);

  // UX-FLOW-01B — Retomada SERVER-DRIVEN: a descoberta usa exclusivamente o
  // operator_id da sessão autenticada (GET /api/campaigns/resumable). Session
  // Storage vazio ou outro navegador NÃO impede a reconstrução — o débito
  // CROSS_BROWSER_RESUME_DEPENDS_ON_SESSION_CONTEXT é encerrado. SINGLE é
  // retomado automaticamente (contrato server-driven): o detalhe é APLICADO
  // ao estado operacional (setCampanha) — mesmo estado da recuperação
  // normal; o Session Storage é preenchido só como conveniência. MULTIPLE
  // exige seleção EXPLÍCITA do operador — nenhuma escolha silenciosa.
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
          setHashSessao(detalhe.hashAprovacao);
          sessionStorage.setItem(CHAVE_HASH_SESSAO, detalhe.hashAprovacao);
          setRetomada({ status: "aplicada", campanha: detalhe });
          return;
        }
        if (resposta.mode === "MULTIPLE" && resposta.campaigns) {
          // Corretivo MULTIPLE/HASH RACE: a descoberta é a AUTORIDADE —
          // nenhuma campanha permanece ativa; a recuperação por hash passa a
          // ser BLOQUEADA (recuperacaoPorHashPermitida) e um /persisted já
          // em voo é cancelado pela re-execução do efeito (cleanup `ativo`):
          // uma resposta atrasada NÃO pode reativar campanha. Só o clique em
          // "Retomar esta campanha" chama detail e aplica setCampanha.
          setModoRetomada("MULTIPLE");
          setCampanha(null);
          setRetomada({ status: "multipla", campanhas: resposta.campaigns });
          return;
        }
        // EMPTY: nenhuma campanha ativa (gate EMPTY impede reativação por hash).
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
      setHashSessao(detalhe.hashAprovacao);
      sessionStorage.setItem(CHAVE_HASH_SESSAO, detalhe.hashAprovacao);
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
        // Corretivo R1: NENHUM estado operacional do operador anterior
        // sobrevive localmente (hash em memória/Session Storage, campanha,
        // retomada e modo de descoberta).
        setHashSessao(LIMPEZA_RETOMADA.hashSessao);
        sessionStorage.removeItem(LIMPEZA_RETOMADA.chaveHashSessao);
        setCampanha(null);
        setRetomada(LIMPEZA_RETOMADA.retomada);
        setModoRetomada(LIMPEZA_RETOMADA.modo);
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
      setHashSessao("");
      sessionStorage.removeItem(CHAVE_HASH_SESSAO);
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
    setErroEtapa("");
    setAvaliando(true);
    try {
      const resultado = await fetchJson<Aprovacao>("/api/campaigns/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateVersao: TEMPLATE_VERSAO_PADRAO,
          registros: aptos.map((registro) => ({
            profissional_id: registro.profissional_id,
            nome: registro.nome,
            email_normalizado: registro.email_normalizado,
            status_validacao: registro.status_validacao,
          })),
        }),
      });
      setAprovacao(resultado);
      setHashSessao(resultado.conteudoHash);
      sessionStorage.setItem(CHAVE_HASH_SESSAO, resultado.conteudoHash);
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
          templateVersao: TEMPLATE_VERSAO_PADRAO,
          conteudoHash: aprovacao.conteudoHash,
          registros: aptosParaAprovacao.map((registro) => ({
            profissional_id: registro.profissional_id,
            nome: registro.nome,
            email_normalizado: registro.email_normalizado,
            status_validacao: registro.status_validacao,
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
      setHashSessao(resposta.conteudoHash);
      sessionStorage.setItem(CHAVE_HASH_SESSAO, resposta.conteudoHash);
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
                    href={URL.createObjectURL(new Blob([credencialUnica.credencial], { type: "text/plain" }))}
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
              Prévia textual determinística do template {TEMPLATE_VERSAO_PADRAO}. Destinatários
              permanecem mascarados na interface; nada é enviado nesta fase.
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
            {aptosParaAprovacao[previaIndice] ? (
              <pre className="campaign-preview">
                {previaMensagem(aptosParaAprovacao[previaIndice])}
              </pre>
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
            <ul className="campaign-flow-stats">
              <li>Template: <code>{TEMPLATE_VERSAO_PADRAO}</code></li>
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
