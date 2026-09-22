import { useCallback, useEffect, useRef, useState } from "react";
import { atualizarSelecaoMapeamento } from "../mapping-state.js";
import { mensagemErroApi, type ApiErrorBody } from "../api-error.js";

/**
 * Fluxo operacional do operador (Fase B):
 * IMPORTAR XLSX → REVISAR MAPPING → VALIDAR (preflight) → CONFIRMAR
 * → PROFISSIONAIS → SELECIONAR ATÉ 5 → PREVIEW → PREPARAR LOTE → ACOMPANHAR.
 *
 * HARD GATES na UI (espelham o backend):
 *  - Preview NUNCA envia;
 *  - Seleção > 5 é bloqueada no servidor (e aqui só como feedback);
 *  - REAL_SEND_ENABLED=false — nenhum botão de envio real existe.
 */

// F1: mesma origem no Preview (o adapter serverless publica /api);
// localhost permanece apenas para dev local com o servidor Node da apps/api.
const API_BASE =
  (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ??
  (typeof window !== "undefined" && !window.location.origin.startsWith("http://localhost")
    ? ""
    : "http://localhost:8787");
const PILOT_MAX = 5;

/**
 * F12 — Sessão operacional do browser: o OPERATOR_TOKEN é informado UMA vez,
 * validado por POST /api/operator/session e trocado por um cookie HttpOnly
 * de sessão de curta duração. O token nunca é persistido (nem storage, nem
 * URL, nem bundle): vive apenas no estado do formulário de login.
 */
interface EstadoSessao {
  status: "DESCONHECIDO" | "AUTENTICADO" | "NAO_AUTENTICADO";
  expiraEm?: string;
}

async function consultarSessao(): Promise<EstadoSessao> {
  const resposta = await fetch(`${API_BASE}/api/operator/session`, { credentials: "same-origin" });
  if (resposta.status === 200) {
    const corpo = (await resposta.json().catch(() => ({}))) as { expiraEm?: string };
    return { status: "AUTENTICADO", ...(corpo.expiraEm ? { expiraEm: corpo.expiraEm } : {}) };
  }
  return { status: "NAO_AUTENTICADO" };
}

interface Sugestao {
  campo: string;
  cabecalho: string | null;
  coluna: number | null;
}

interface Analise {
  sha256: string;
  nomeArquivo: string;
  folhasDisponiveis: string[];
  folha: string;
  cabecalhos: string[];
  cabecalhosDuplicados: string[];
  totalLinhas: number;
  sugestao: Sugestao[];
  preview: { numero: number; valores: string[] }[];
}

interface Registro {
  numeroLinha: number;
  codigo: string;
  nome: string;
  emailValido: boolean;
  cpfValido: boolean;
  endereco: { classificacao: string; issues: string[] };
  issues: string[];
  aptoContato: boolean;
}

interface ResumoPreflight {
  sha256: string;
  total: number;
  validos: number;
  invalidos: number;
  cpfInvalido: number;
  emailInvalido: number;
  enderecoRequerRevisao: number;
  enderecoInvalido: number;
  duplicados: number;
  aptosContato: number;
  registros: Registro[];
}

interface Profissional {
  id: string;
  codigo: string;
  nome: string;
  emailMascarado: string;
  telefoneMascarado: string;
  enderecoClassificacao: string;
  enderecoResumo: string;
  status: string;
  issues: string[];
  elegivelComunicacao: boolean;
}

interface Preview {
  professionalId: string;
  codigo: string;
  destinatarioMascarado: string;
  remetente: string;
  assunto: string;
  templateVersion: string;
  corpoTexto: string;
}

interface OutboxItem {
  outboxId: string;
  codigo: string | null;
  status: string;
  tentativas: number;
  erroCodigo: string | null;
}

interface ReadinessItem {
  name: string;
  status: string;
  detail: string;
  requiredAction?: string;
}

interface ReadinessReport {
  database: ReadinessItem;
  cryptography: ReadinessItem;
  intake: ReadinessItem;
  persistence: ReadinessItem;
  outbox: ReadinessItem;
  worker: ReadinessItem;
  gmailTransport: ReadinessItem;
  gmailOauth: ReadinessItem;
  realSend: ReadinessItem;
  ppn: ReadinessItem;
  executionMode: string;
}

interface EstadoLoteControladoItem {
  loteId: string;
  status: "PREPARACAO" | "ATIVO" | "CONCLUIDO" | "CANCELADO";
  modo: string;
  totalItens: number;
  fonteRegistro: string | null;
  receiptAnterior: boolean;
  liberacaoHumanaAuditada: boolean;
  destinatarioCorresponde: boolean | null;
}

interface EstadoLoteControlado {
  codigo: string;
  outboxPendenteForaDoTeste: number;
  outboxProcessamento: number;
  lotesAtivosForaDoTeste: number;
  lote: EstadoLoteControladoItem | null;
}

interface GmailIntegracao {
  status: string;
  escopo: string;
  contaEsperadaConfigurada: boolean;
  hdOrganizacionalConfigurado: boolean;
  realSendEnabled: boolean;
  controlledMode: boolean;
  mensagem: string;
}

interface WorkerRun {
  modo?: string;
  resultado?: {
    processados: number;
    enviados: number;
    falhas: number;
    codigosErro: string[];
    modo: string;
  };
  motivo?: string;
  aviso?: string;
  erro?: string;
}

type Etapa =
  | "UPLOAD"
  | "MAPPING"
  | "PREFLIGHT"
  | "PERSISTIDO"
  | "COCKPIT"
  | "LOTE"
  | "OUTBOX";

const ETAPAS: readonly { id: Etapa; rotulo: string }[] = [
  { id: "UPLOAD", rotulo: "1. Importar arquivo" },
  { id: "MAPPING", rotulo: "2. Conferir colunas" },
  { id: "PREFLIGHT", rotulo: "3. Revisar dados" },
  { id: "PERSISTIDO", rotulo: "4. Salvar profissionais" },
  { id: "COCKPIT", rotulo: "5. Selecionar contatos" },
  { id: "LOTE", rotulo: "6. Revisar comunicação" },
  { id: "OUTBOX", rotulo: "7. Acompanhar processamento" },
];

const ROTULOS_FILTRO: Readonly<Record<string, string>> = {
  TODOS: "Todos",
  APTOS_CONTATO: "Prontos para contato",
  PENDENCIA_CADASTRAL: "Revisão cadastral",
  EMAIL_INVALIDO: "E-mail para revisar",
  ENDERECO_PENDENTE: "Endereço para revisar",
};

function rotuloStatus(status: string): string {
  const rotulos: Readonly<Record<string, string>> = {
    APTO_CONTATO: "Pronto para contato",
    PENDENCIA_CADASTRAL: "Revisão cadastral",
    PENDENCIA_TRIAGEM: "Revisão necessária",
    PENDING: "Aguardando processamento",
    PROCESSING: "Em processamento",
    SENT: "Processado",
    FAILED: "Falha — revisar",
    PREPARACAO: "Preparado",
    ATIVO: "Autorizado",
    CONCLUIDO: "Concluído",
  };
  return rotulos[status] ?? status.replaceAll("_", " ").toLowerCase();
}

export function OperationalFlow() {
  const [etapa, setEtapa] = useState<Etapa>("UPLOAD");
  const [erro, setErro] = useState<string>();
  const [ocupado, setOcupado] = useState(false);

  const [arquivo, setArquivo] = useState<File | null>(null);
  const [analise, setAnalise] = useState<Analise | null>(null);
  const [mapeamento, setMapeamento] = useState<Record<string, number>>({});
  const [resumo, setResumo] = useState<ResumoPreflight | null>(null);
  const [resultadoImportacao, setResultadoImportacao] = useState<{
    profissionaisCriados: number;
    linhasPendentes: number;
    linhasInvalidas: number;
  } | null>(null);

  const [profissionais, setProfissionais] = useState<Profissional[]>([]);
  const [filtro, setFiltro] = useState("TODOS");
  const [selecao, setSelecao] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<{
    previews: Preview[];
    remetente: string;
    quantidade: number;
    maximo: number;
    aviso: string;
  } | null>(null);
  const [lote, setLote] = useState<{
    loteId: string;
    codigo: string;
    totalItens: number;
    status: "PREPARACAO" | "ATIVO" | "CANCELADO";
  } | null>(null);
  const [cancelamentoHistorico, setCancelamentoHistorico] = useState<{
    aberto: boolean;
    confirmacao: string;
    resultado: string | null;
  }>({ aberto: false, confirmacao: "", resultado: null });
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [gmail, setGmail] = useState<GmailIntegracao | null>(null);
  const [estadoControlado, setEstadoControlado] = useState<EstadoLoteControlado | null>(null);
  const [workerRun, setWorkerRun] = useState<WorkerRun | null>(null);
  const [ativacao, setAtivacao] = useState<string | null>(null);
  const [sessao, setSessao] = useState<EstadoSessao>({ status: "DESCONHECIDO" });
  const [tokenOperador, setTokenOperador] = useState("");
  const [entrando, setEntrando] = useState(false);
  const [workerExecutando, setWorkerExecutando] = useState(false);
  const [chaveUpload, setChaveUpload] = useState(0);
  const arquivoRef = useRef<FormData | null>(null);

  // Continuidade de UX: reinicia SOMENTE o estado efêmero do fluxo de validação.
  // O processamento existente (lote/outbox) permanece carregado e acessível em
  // "Acompanhamento". Nenhuma mutação no PostgreSQL.
  function iniciarNovaValidacao() {
    arquivoRef.current = null;
    setArquivo(null);
    setAnalise(null);
    setMapeamento({});
    setResumo(null);
    setResultadoImportacao(null);
    setSelecao(new Set());
    setPreviews(null);
    setErro(undefined);
    setChaveUpload((k) => k + 1);
    setEtapa("UPLOAD");
  }

  // F12: estado de sessão claro antes de liberar qualquer operação.
  useEffect(() => {
    void consultarSessao().then(setSessao);
  }, []);

  const autenticar = useCallback(async () => {
    if (!tokenOperador) return;
    setEntrando(true);
    setErro(undefined);
    try {
      const resposta = await fetch(`${API_BASE}/api/operator/session`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tokenOperador }),
      });
      const corpo = (await resposta.json().catch(() => ({}))) as { erro?: string; expiraEm?: string };
      if (resposta.status === 503) {
        setSessao({ status: "NAO_AUTENTICADO" });
        setErro("Autenticação operacional indisponível (OPERATOR_TOKEN ausente no servidor). Fail-closed.");
        return;
      }
      if (!resposta.ok) {
        setSessao({ status: "NAO_AUTENTICADO" });
        setErro(corpo.erro ?? "Token operacional inválido.");
        return;
      }
      setSessao({ status: "AUTENTICADO", ...(corpo.expiraEm ? { expiraEm: corpo.expiraEm } : {}) });
      setTokenOperador("");
    } catch {
      setSessao({ status: "NAO_AUTENTICADO" });
      setErro("Não foi possível autenticar a sessão operacional.");
    } finally {
      setEntrando(false);
    }
  }, [tokenOperador]);

  const sair = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/operator/session`, { method: "DELETE", credentials: "same-origin" });
    } finally {
      setSessao({ status: "NAO_AUTENTICADO" });
    }
  }, []);

  const guardarArquivo = useCallback((form: FormData) => {
    arquivoRef.current = form;
  }, []);

  async function chamar(caminho: string, init?: RequestInit): Promise<unknown> {
    const resposta = await fetch(`${API_BASE}${caminho}`, init);
    const corpo = (await resposta.json().catch(() => ({}))) as ApiErrorBody & Record<string, unknown>;
    if (!resposta.ok) {
      throw new Error(mensagemErroApi(corpo, resposta.status));
    }
    return corpo;
  }

  function formComArquivo(): FormData | null {
    return arquivoRef.current;
  }

  async function enviarArquivo() {
    if (!arquivo) return;
    setOcupado(true);
    setErro(undefined);
    try {
      const form = new FormData();
      form.set("arquivo", arquivo);
      guardarArquivo(form);
      const bytes = await arquivo.arrayBuffer();
      const resposta = (await chamar("/api/intake/analyze", {
        method: "POST",
        headers: {
          "x-file-name": encodeURIComponent(arquivo.name),
          "content-type": "application/octet-stream",
        },
        body: bytes,
      })) as Analise;
      setAnalise(resposta);
      const sugerido: Record<string, number> = {};
      for (const s of resposta.sugestao) {
        if (s.coluna !== null) sugerido[s.campo] = s.coluna;
      }
      setMapeamento(sugerido);
      setEtapa("MAPPING");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha no upload.");
    } finally {
      setOcupado(false);
    }
  }

  async function rodarPreflight() {
    if (!arquivo || !analise) return;
    setOcupado(true);
    setErro(undefined);
    try {
      const bytes = await arquivo.arrayBuffer();
      const resposta = (await chamar("/api/intake/preflight", {
        method: "POST",
        headers: {
          "x-file-name": encodeURIComponent(arquivo.name),
          "x-mapping": encodeURIComponent(
            JSON.stringify(
              Object.entries(mapeamento).map(([campo, coluna]) => ({ campo, coluna })),
            ),
          ),
          "content-type": "application/octet-stream",
        },
        body: bytes,
      })) as ResumoPreflight;
      setResumo(resposta);
      setEtapa("PREFLIGHT");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha no preflight.");
    } finally {
      setOcupado(false);
    }
  }

  async function confirmarImportacao() {
    if (!arquivo) return;
    setOcupado(true);
    setErro(undefined);
    try {
      const bytes = await arquivo.arrayBuffer();
      const resposta = (await chamar("/api/intake/confirm", {
        method: "POST",
        headers: {
          "x-file-name": encodeURIComponent(arquivo.name),
          "x-mapping": encodeURIComponent(
            JSON.stringify(
              Object.entries(mapeamento).map(([campo, coluna]) => ({ campo, coluna })),
            ),
          ),
          "content-type": "application/octet-stream",
        },
        body: bytes,
      })) as { profissionaisCriados: number; linhasPendentes: number; linhasInvalidas: number };
      setResultadoImportacao(resposta);
      setEtapa("PERSISTIDO");
      await carregarProfissionais();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao confirmar importação.");
    } finally {
      setOcupado(false);
    }
  }

  const carregarProfissionais = useCallback(async () => {
    setOcupado(true);
    try {
      const resposta = (await chamar(`/api/professionals?filtro=${filtro}`)) as {
        profissionais: Profissional[];
      };
      setProfissionais(resposta.profissionais);
      setEtapa("COCKPIT");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao listar profissionais.");
    } finally {
      setOcupado(false);
    }
  }, [filtro]);

  useEffect(() => {
    if (etapa === "COCKPIT") void carregarProfissionais();
  }, [etapa, carregarProfissionais]);

  function alternarSelecao(id: string) {
    setSelecao((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) {
        novo.delete(id);
      } else if (novo.size < PILOT_MAX) {
        novo.add(id);
      }
      return novo;
    });
  }

  async function gerarPreview() {
    setOcupado(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ professionalIds: [...selecao] }),
      })) as { previews: Preview[]; remetente: string; quantidade: number; maximo: number; aviso: string };
      setPreviews(resposta);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha no preview.");
    } finally {
      setOcupado(false);
    }
  }

  async function carregarOutboxDoLote(loteId: string) {
    const resposta = (await chamar(`/api/pilot/outbox?loteId=${loteId}`)) as {
      itens: OutboxItem[];
    };
    setOutbox(resposta.itens);
  }

  async function prepararLote() {
    setOcupado(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ professionalIds: [...selecao] }),
      })) as { loteId: string; codigo: string; totalItens: number };
      setLote({ ...resposta, status: "PREPARACAO" });
      await carregarOutboxDoLote(resposta.loteId);
      setEtapa("OUTBOX");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao preparar lote.");
    } finally {
      setOcupado(false);
    }
  }

  async function atualizarOutbox() {
    if (!lote) return;
    setOcupado(true);
    try {
      await carregarOutboxDoLote(lote.loteId);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao consultar outbox.");
    } finally {
      setOcupado(false);
    }
  }

  // Painel Integração Gmail: conexão real é gate humano (consent Google);
  // desconexão é ação explícita e auditada. Nenhum secret atravessa a UI.
  async function conectarGmail() {
    setOcupado(true);
    try {
      const resposta = (await chamar("/api/oauth/gmail/start")) as { authorizationUrl: string };
      window.location.assign(resposta.authorizationUrl);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao iniciar o fluxo OAuth.");
      setOcupado(false);
    }
  }

  async function desconectarGmail() {
    setOcupado(true);
    try {
      await chamar("/api/oauth/gmail/connection", { method: "DELETE" });
      await carregarReadiness();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao desconectar a conta.");
    } finally {
      setOcupado(false);
    }
  }

  async function verificarGmail() {
    setOcupado(true);
    try {
      setGmail((await chamar("/api/oauth/gmail/status")) as GmailIntegracao);
      await carregarEstadoControlado();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao verificar a integração.");
    } finally {
      setOcupado(false);
    }
  }

  // Prepara o lote sintético CONTROLLED_GMAIL_TEST (idempotente). NÃO ativa
  // o lote, NÃO executa worker e NÃO envia — ativação/envio permanecem gates
  // humanos separados, e REAL_SEND_ENABLED=false mantém o envio bloqueado.
  async function prepararLoteControlado() {
    setOcupado(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/controlled/prepare", {
        method: "POST",
      })) as { criado: boolean; codigo: string; totalItens: number };
      await carregarEstadoControlado();
      setAtivacao(
        resposta.criado
          ? `LOTE_CONTROLADO_CRIADO (${resposta.codigo}, ${resposta.totalItens} comunicação)`
          : `LOTE_CONTROLADO_EXISTENTE (${resposta.codigo})`,
      );
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao preparar o lote controlado.");
    } finally {
      setOcupado(false);
    }
  }

  const carregarReadiness = useCallback(async () => {
    try {
      setReadiness((await chamar("/api/readiness")) as ReadinessReport);
      setGmail((await chamar("/api/oauth/gmail/status")) as GmailIntegracao);
    } catch {
      setReadiness(null);
      setGmail(null);
    }
  }, []);

  // Estado read-only do teste controlado (sem mutação — apenas consulta).
  const carregarEstadoControlado = useCallback(async () => {
    try {
      setEstadoControlado((await chamar("/api/pilot/controlled/state")) as EstadoLoteControlado);
    } catch {
      setEstadoControlado(null);
    }
  }, []);

  // F12/F22: ao restaurar a sessão, também recupera do PostgreSQL qualquer
  // lote PF/DRY_RUN já persistido. Refresh/reabertura não reinicia o fluxo.
  useEffect(() => {
    if (sessao.status !== "AUTENTICADO") {
      setReadiness(null);
      return;
    }
    void carregarReadiness();
    void carregarEstadoControlado();
    void (async () => {
      try {
        const resposta = (await chamar("/api/pilot/recovery")) as {
          lote: {
            loteId: string;
            codigo: string;
            totalItens: number;
            status: "PREPARACAO" | "ATIVO";
          } | null;
          itens: OutboxItem[];
        };
        if (resposta.lote) {
          // Continuidade de UX: o processamento recuperado fica acessível como
          // cartão separado ("Processamento existente") e em "Acompanhamento",
          // SEM sequestrar a etapa atual — iniciar nova validação permanece
          // possível mesmo com lote histórico ATIVO no PostgreSQL.
          setLote(resposta.lote);
          setOutbox(resposta.itens);
          setAtivacao(resposta.lote.status === "ATIVO" ? "RECOVERED_ACTIVE" : null);
        }
      } catch {
        // Readiness continuará visível; recovery é best-effort de UI.
      }
    })();
  }, [sessao.status, carregarReadiness, carregarEstadoControlado]);

  async function liberarLote() {
    if (!lote) return;
    setOcupado(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loteId: lote.loteId }),
      })) as { resultado?: { resultCode: string }; modoEnvio?: string; aviso?: string };
      setAtivacao(resposta.resultado?.resultCode ?? "ACTIVATED");
      setLote((atual) => (atual ? { ...atual, status: "ATIVO" } : atual));
      await carregarOutboxDoLote(lote.loteId);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha na liberação do lote.");
    } finally {
      setOcupado(false);
    }
  }

  // Cancelamento auditado do lote DRY_RUN histórico — somente para o lote
  // canônico PF-MAIL-PILOTO-MUB37G1H. Exige confirmação textual humana exata.
  // Nenhum dado é apagado: apenas o status do lote muda para CANCELADO.
  const CODIGO_LOTE_HISTORICO_UI = "PF-MAIL-PILOTO-MUB37G1H";
  const CONFIRMACAO_CANCELAMENTO_UI =
    "AUTORIZO CANCELAR DE FORMA AUDITADA O LOTE DRY_RUN HISTÓRICO " +
    "PF-MAIL-PILOTO-MUB37G1H, PRESERVANDO TODOS OS DADOS E SEM EXECUTAR O WORKER";
  async function cancelarLoteHistorico() {
    if (!lote || lote.codigo !== CODIGO_LOTE_HISTORICO_UI) return;
    if (cancelamentoHistorico.confirmacao.trim() !== CONFIRMACAO_CANCELAMENTO_UI) return;
    setOcupado(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/batch/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loteId: lote.loteId,
          confirmacao: cancelamentoHistorico.confirmacao.trim(),
        }),
      })) as { estado?: { status: string; resultCode: string }; aviso?: string };
      setCancelamentoHistorico({ aberto: false, confirmacao: "", resultado: resposta.aviso ?? null });
      setLote((atual) =>
        atual ? { ...atual, status: (resposta.estado?.status as "CANCELADO") ?? "CANCELADO" } : atual,
      );
      await carregarEstadoControlado();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha no cancelamento do lote histórico.");
    } finally {
      setOcupado(false);
    }
  }

  async function executarWorkerUmaVez() {
    setOcupado(true);
    setWorkerExecutando(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/worker/run-once", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      })) as WorkerRun;
      setWorkerRun(resposta);
      if (lote) await carregarOutboxDoLote(lote.loteId);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha na execução do worker.");
    } finally {
      setWorkerExecutando(false);
      setOcupado(false);
    }
  }

  return (
    <div className="operational-flow">
      <section className="flow-progress" aria-label="Progresso do fluxo">
        <ol>
          {ETAPAS.map((e) => (
            <li
              key={e.id}
              className={
                ETAPAS.findIndex((x) => x.id === etapa) >= ETAPAS.findIndex((x) => x.id === e.id)
                  ? "is-complete"
                  : ""
              }
            >
              {e.rotulo}
            </li>
          ))}
        </ol>
      </section>

      {erro && (
        <p className="flow-error" role="alert">
          {erro}
        </p>
      )}

      {/* F12 — Sessão operacional: estado claro antes de liberar o fluxo. */}
      {sessao.status !== "AUTENTICADO" ? (
        <section className="flow-panel" aria-labelledby="session-title">
          <h2 id="session-title">Sessão operacional</h2>
          <p className="flow-warn">
            {sessao.status === "DESCONHECIDO"
              ? "Verificando sessão operacional…"
              : "Autenticação operacional necessária — nenhuma operação disponível até autenticar."}
          </p>
          <div className="flow-filters">
            <input
              type="password"
              value={tokenOperador}
              onChange={(e) => setTokenOperador(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void autenticar();
              }}
              placeholder="Token operacional"
              autoComplete="off"
              aria-label="Token operacional"
            />
            <button type="button" disabled={!tokenOperador || entrando} onClick={autenticar}>
              {entrando ? "Autenticando…" : "Autenticar sessão"}
            </button>
          </div>
          <small>
            O token é enviado uma única vez e trocado por um cookie HttpOnly de sessão; ele não
            é persistido no navegador.
          </small>
        </section>
      ) : (
        <section className="flow-panel" aria-labelledby="session-title">
          <h2 id="session-title">Sessão operacional</h2>
          <p>
            Sessão ativa{sessao.expiraEm ? ` (expira ${new Date(sessao.expiraEm).toLocaleString()})` : ""}.
          </p>
          <button type="button" onClick={sair}>
            Encerrar sessão operacional
          </button>
        </section>
      )}

      {/* F12 — Nenhuma operação disponível sem sessão autenticada. */}
      {sessao.status !== "AUTENTICADO" && (
        <section className="flow-panel" aria-label="Fluxo bloqueado">
          <p className="flow-warn">
            Fluxo operacional bloqueado até a sessão ser autenticada. Informe o token operacional
            para liberar as etapas abaixo.
          </p>
        </section>
      )}

      {/* F12 — Fluxo operacional inteiro atrás da sessão autenticada. */}
      {sessao.status === "AUTENTICADO" && (
        <>
      {/* Continuidade de UX — processamento existente (recuperado do PostgreSQL)
          acessível separadamente; nunca impede iniciar uma nova validação. */}
      {lote && etapa !== "OUTBOX" && (
        <section className="flow-panel" aria-labelledby="existing-batch-title">
          <h2 id="existing-batch-title">Processamento existente</h2>
          <p>
            Há um processamento <strong>{lote.codigo}</strong> · {lote.totalItens} comunicação(ões)
            · <strong>{rotuloStatus(lote.status)}</strong>. Ele permanece inalterado caso você
            inicie uma nova validação de arquivo.
          </p>
          <div className="flow-filters">
            <button type="button" onClick={() => setEtapa("OUTBOX")}>
              Abrir acompanhamento
            </button>
            <button type="button" onClick={iniciarNovaValidacao}>
              Iniciar nova validação de arquivo
            </button>
          </div>
        </section>
      )}
      {etapa === "UPLOAD" && (
        <section className="flow-panel" aria-labelledby="upload-title">
          <h2 id="upload-title">Importar profissionais</h2>
          <p>Selecione a planilha institucional de profissionais. Esta etapa apenas lê e confere os dados.</p>
          <input
            key={chaveUpload}
            type="file"
            accept=".xlsx"
            onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
          />
          <button type="button" disabled={!arquivo || ocupado} onClick={enviarArquivo}>
            {ocupado ? "Analisando…" : "Continuar"}
          </button>
        </section>
      )}

      {analise && etapa === "MAPPING" && (
        <section className="flow-panel" aria-labelledby="mapping-title">
          <h2 id="mapping-title">Conferir associação das colunas</h2>
          <p>{analise.totalLinhas} registros encontrados na planilha selecionada.</p>
          <details className="flow-tech-details">
            <summary>Detalhes técnicos do arquivo</summary>
            <small>
              Identificador SHA-256: <code>{analise.sha256.slice(0, 16)}…</code> · Folha{" "}
              <strong>{analise.folha}</strong>
            </small>
          </details>
          {analise.cabecalhosDuplicados.length > 0 && (
            <p className="flow-warn">
              Cabeçalhos duplicados: {analise.cabecalhosDuplicados.join(", ")}
            </p>
          )}
          <table className="flow-table">
            <thead>
              <tr>
                <th>Campo</th>
                <th>Coluna da planilha</th>
              </tr>
            </thead>
            <tbody>
              {analise.sugestao.map((s) => (
                <tr key={s.campo}>
                  <td>{s.campo}</td>
                  <td>
                    <select
                      value={mapeamento[s.campo] ?? ""}
                      onChange={(e) =>
                        setMapeamento((m) =>
                          atualizarSelecaoMapeamento(m, s.campo, e.target.value),
                        )
                      }
                    >
                      <option value="">— não associado —</option>
                      {analise.cabecalhos.map((h, i) => (
                        <option key={`${h}-${i}`} value={i}>
                          [{i}] {h}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" disabled={ocupado} onClick={rodarPreflight}>
            Revisar dados da importação
          </button>
        </section>
      )}

      {resumo && etapa === "PREFLIGHT" && (
        <section className="flow-panel" aria-labelledby="preflight-title">
          <h2 id="preflight-title">Revisar dados antes de salvar</h2>
          <ul className="flow-stats">
            <li>Total: {resumo.total}</li>
            <li>Válidos: {resumo.validos}</li>
            <li>Inválidos: {resumo.invalidos}</li>
            <li>CPF inválido: {resumo.cpfInvalido}</li>
            <li>E-mail inválido: {resumo.emailInvalido}</li>
            <li>Endereço p/ revisão: {resumo.enderecoRequerRevisao}</li>
            <li>Endereço inválido: {resumo.enderecoInvalido}</li>
            <li>Duplicados: {resumo.duplicados}</li>
            <li>
              <strong>Aptos p/ contato: {resumo.aptosContato}</strong>
            </li>
          </ul>
          <div className="flow-scroll">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>Linha</th>
                  <th>Código</th>
                  <th>Nome</th>
                  <th>CPF</th>
                  <th>E-mail</th>
                  <th>Endereço</th>
                  <th>Pendências</th>
                </tr>
              </thead>
              <tbody>
                {resumo.registros.map((r) => (
                  <tr key={r.numeroLinha}>
                    <td>{r.numeroLinha}</td>
                    <td>{r.codigo}</td>
                    <td>{r.nome}</td>
                    <td>{r.cpfValido ? "válido" : "inválido"}</td>
                    <td>{r.emailValido ? "válido" : "inválido"}</td>
                    <td>{r.endereco.classificacao}</td>
                    <td>{r.issues.join("; ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" disabled={ocupado} onClick={confirmarImportacao}>
            Salvar profissionais
          </button>
        </section>
      )}

      {resultadoImportacao && etapa === "PERSISTIDO" && (
        <section className="flow-panel" aria-labelledby="persisted-title">
          <h2 id="persisted-title">Profissionais salvos</h2>
          <ul className="flow-stats">
            <li>Profissionais criados: {resultadoImportacao.profissionaisCriados}</li>
            <li>Linhas pendentes: {resultadoImportacao.linhasPendentes}</li>
            <li>Linhas inválidas: {resultadoImportacao.linhasInvalidas}</li>
          </ul>
          <button type="button" onClick={() => setEtapa("COCKPIT")}>
            Selecionar profissionais
          </button>
        </section>
      )}

      {etapa === "COCKPIT" && (
        <section className="flow-panel" aria-labelledby="cockpit-title">
          <h2 id="cockpit-title">Profissionais</h2>
          <div className="flow-filters">
            {["TODOS", "APTOS_CONTATO", "PENDENCIA_CADASTRAL", "EMAIL_INVALIDO", "ENDERECO_PENDENTE"].map(
              (f) => (
                <button
                  key={ROTULOS_FILTRO[f] ?? f}
                  type="button"
                  className={filtro === f ? "is-selected" : ""}
                  onClick={() => {
                    setFiltro(f);
                    void carregarProfissionais();
                  }}
                >
                  {ROTULOS_FILTRO[f] ?? f}
                </button>
              ),
            )}
          </div>
          <p>
            Selecionados: {selecao.size} de {PILOT_MAX} profissionais permitidos nesta validação
          </p>
          <div className="flow-scroll">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>Selecionar</th>
                  <th>Código</th>
                  <th>Nome</th>
                  <th>E-mail</th>
                  <th>Telefone</th>
                  <th>Endereço</th>
                  <th>Status</th>
                  <th>Pendências</th>
                </tr>
              </thead>
              <tbody>
                {profissionais.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selecao.has(p.id)}
                        disabled={!p.elegivelComunicacao || (selecao.size >= PILOT_MAX && !selecao.has(p.id))}
                        onChange={() => alternarSelecao(p.id)}
                        aria-label={`Selecionar ${p.codigo} para o piloto`}
                      />
                    </td>
                    <td>{p.codigo}</td>
                    <td>{p.nome}</td>
                    <td>{p.emailMascarado}</td>
                    <td>{p.telefoneMascarado}</td>
                    <td>{p.enderecoResumo}</td>
                    <td>{rotuloStatus(p.status)}</td>
                    <td>{p.issues.join("; ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" disabled={selecao.size === 0 || ocupado} onClick={gerarPreview}>
            Revisar comunicações selecionadas
          </button>
        </section>
      )}

      {previews && (
        <section className="flow-panel" aria-labelledby="preview-title">
          <h2 id="preview-title">Revisar comunicações</h2>
          <p>
            Remetente: {previews.remetente} · Quantidade: {previews.quantidade}/{previews.maximo}
          </p>
          <p className="flow-warn">{previews.aviso}</p>
          {previews.previews.map((p) => (
            <details key={p.professionalId}>
              <summary>
                {p.codigo} → {p.destinatarioMascarado} · {p.assunto}
              </summary>
              <pre>{p.corpoTexto}</pre>
              <small>Modelo de comunicação: {p.templateVersion}</small>
            </details>
          ))}
          <button
            type="button"
            className="flow-primary"
            disabled={ocupado}
            onClick={prepararLote}
          >
            Preparar comunicações ({previews.quantidade}/{previews.maximo})
          </button>
        </section>
      )}

      {gmail && (
        <details className="flow-panel flow-diagnostics" open>
          <summary id="gmail-title">Integração Gmail</summary>
          <p>
            Estado do transporte institucional. Nenhum secret, token ou endereço de e-mail é exibido.
          </p>
          <ul className="flow-stats">
            <li>Transporte: <code>{gmail.realSendEnabled ? "READY" : "DISABLED"}</code></li>
            <li>OAuth: <code>{gmail.status}</code></li>
            <li>Envio real: <code>{gmail.realSendEnabled ? "ARMED (GATE 1 ativo)" : "DISABLED"}</code></li>
            <li>Modo controlado: <code>{gmail.controlledMode ? "ACTIVE" : "OFF"}</code></li>
            <li>Escopo concedido: <code>{gmail.escopo}</code></li>
            <li>
              Conta esperada configurada: <code>{gmail.contaEsperadaConfigurada ? "SIM" : "NÃO"}</code>
              {" · Domínio organizacional: "}
              <code>{gmail.hdOrganizacionalConfigurado ? "SIM" : "NÃO"}</code>
            </li>
          </ul>
          <p>{gmail.mensagem}</p>
          <div className="flow-filters">
            <button type="button" onClick={verificarGmail} disabled={ocupado}>
              Verificar integração
            </button>
            {gmail.status === "CONNECTED" ? (
              <button type="button" onClick={conectarGmail} disabled={ocupado}>
                Reconectar Gmail
              </button>
            ) : (
              <button type="button" onClick={conectarGmail} disabled={ocupado}>
                Conectar Gmail
              </button>
            )}
            <button
              type="button"
              onClick={desconectarGmail}
              disabled={ocupado || gmail.status !== "CONNECTED"}
            >
              Desconectar Gmail
            </button>
          </div>
          {estadoControlado && (
            <div className="flow-diagnostics">
              <h3>Lote de teste controlado ({estadoControlado.codigo})</h3>
              <p>
                Pré-voo read-only. A preparação cria o lote sintético em PREPARACAO — não
                ativa o lote, não executa worker e não envia (REAL_SEND_ENABLED=false).
              </p>
              <ul className="flow-stats">
                <li>
                  Outbox pendente fora do teste:{" "}
                  <code>{estadoControlado.outboxPendenteForaDoTeste}</code>
                </li>
                <li>
                  Outbox em processamento: <code>{estadoControlado.outboxProcessamento}</code>
                </li>
                <li>
                  Lotes ATIVOS fora do teste: <code>{estadoControlado.lotesAtivosForaDoTeste}</code>
                </li>
                {estadoControlado.lote ? (
                  <>
                    <li>
                      Comunicações no lote: <code>{estadoControlado.lote.totalItens}</code> · Fonte:{" "}
                      <code>{estadoControlado.lote.fonteRegistro ?? "—"}</code> · Modo:{" "}
                      <code>{estadoControlado.lote.modo}</code>
                    </li>
                    <li>
                      Destinatário = controlado:{" "}
                      <code>
                        {estadoControlado.lote.destinatarioCorresponde === null
                          ? "INDETERMINADO"
                          : estadoControlado.lote.destinatarioCorresponde
                            ? "SIM"
                            : "NÃO"}
                      </code>{" "}
                      · Receipt anterior: <code>{estadoControlado.lote.receiptAnterior ? "SIM" : "NÃO"}</code>
                    </li>
                    <li>
                      Liberação humana auditada:{" "}
                      <code>{estadoControlado.lote.liberacaoHumanaAuditada ? "SIM" : "NÃO"}</code> · Status:{" "}
                      <code>{estadoControlado.lote.status}</code>
                    </li>
                  </>
                ) : (
                  <li>Lote controlado ainda não existe (será criado pela preparação).</li>
                )}
                <li>
                  OAuth: <code>{gmail.status}</code> · Envio real:{" "}
                  <code>{gmail.realSendEnabled ? "ARMED" : "DISABLED"}</code>
                </li>
              </ul>
              <div className="flow-filters">
                <button type="button" onClick={carregarEstadoControlado} disabled={ocupado}>
                  Atualizar estado
                </button>
                <button
                  type="button"
                  onClick={prepararLoteControlado}
                  disabled={ocupado || !gmail.controlledMode || !gmail.contaEsperadaConfigurada}
                >
                  Preparar lote de teste controlado
                </button>
              </div>
            </div>
          )}
        </details>
      )}

      {readiness && (
        <details className="flow-panel flow-diagnostics">
          <summary id="readiness-title">Diagnóstico técnico do ambiente</summary>
          <p>
            Informações para suporte e validação técnica. Nenhum valor sensível é exibido.
          </p>
          <table className="flow-table">
            <thead>
              <tr>
                <th>Subsistema</th>
                <th>Estado</th>
                <th>Detalhe / ação necessária</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  readiness.database,
                  readiness.cryptography,
                  readiness.intake,
                  readiness.persistence,
                  readiness.outbox,
                  readiness.worker,
                  readiness.gmailTransport,
                  readiness.gmailOauth,
                  readiness.realSend,
                  {
                    name: "Real send executed",
                    status: readiness.realSend.status === "EXECUTED" ? "EXECUTED" : "DISABLED",
                    detail:
                      readiness.realSend.status === "EXECUTED"
                        ? "Existe aceite real registrado no ledger de auditoria."
                        : "Nenhum envio real registrado (REAL_SEND_EXECUTED=false).",
                  },
                  readiness.ppn,
                ] as ReadinessItem[]
              ).map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td>
                    <code>{item.status}</code>
                  </td>
                  <td>
                    {item.detail}
                    {item.requiredAction ? <small> · {item.requiredAction}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {etapa === "OUTBOX" && lote && (
        <section className="flow-panel" aria-labelledby="outbox-title">
          <h2 id="outbox-title">Acompanhamento do processamento</h2>
          <p>
            Processamento <strong>{lote.codigo}</strong> · {lote.totalItens} comunicação(ões) ·{" "}
            <strong>{rotuloStatus(lote.status)}</strong>.
            {lote.status === "PREPARACAO"
              ? " Revise e autorize antes de iniciar o teste."
              : " O processamento de teste está autorizado; nenhum envio real será realizado."}
          </p>
          <div className="flow-filters">
            <button type="button" onClick={atualizarOutbox} disabled={ocupado}>
              Atualizar andamento
            </button>
            <button
              type="button"
              onClick={liberarLote}
              disabled={ocupado || lote.status === "ATIVO"}
            >
              {lote.status === "ATIVO"
                ? "Processamento autorizado"
                : "Autorizar processamento"}
            </button>
            <button
              type="button"
              onClick={executarWorkerUmaVez}
              disabled={ocupado || lote.status !== "ATIVO"}
            >
              {workerExecutando ? "Processando teste…" : "Executar teste de processamento"}
            </button>
            <button type="button" onClick={iniciarNovaValidacao}>
              Iniciar nova validação de arquivo
            </button>
            {lote.codigo === CODIGO_LOTE_HISTORICO_UI && lote.status === "ATIVO" && (
              <button
                type="button"
                onClick={() =>
                  setCancelamentoHistorico((atual) => ({ ...atual, aberto: !atual.aberto }))
                }
                disabled={ocupado}
              >
                Cancelar lote DRY_RUN histórico
              </button>
            )}
          </div>
          {lote.codigo === CODIGO_LOTE_HISTORICO_UI && lote.status === "ATIVO" &&
            cancelamentoHistorico.aberto && (
              <div className="flow-stats">
                <p>
                  <strong>Cancelar lote DRY_RUN histórico</strong> — altera APENAS o status do lote
                  para CANCELADO. Itens, comunicações, outbox, confirmações, importações e TODA a
                  trilha de auditoria permanecem preservados. Nada é apagado. O worker não é
                  executado e nenhum envio é realizado.
                </p>
                <p>
                  Para confirmar, cole exatamente a frase:
                  <br />
                  <code>
                    {CONFIRMACAO_CANCELAMENTO_UI}
                  </code>
                </p>
                <input
                  value={cancelamentoHistorico.confirmacao}
                  onChange={(e) =>
                    setCancelamentoHistorico((atual) => ({ ...atual, confirmacao: e.target.value }))
                  }
                  placeholder="Cole a frase de autorização aqui"
                  disabled={ocupado}
                  style={{ width: "100%" }}
                />
                <div className="flow-filters">
                  <button
                    type="button"
                    onClick={cancelarLoteHistorico}
                    disabled={
                      ocupado ||
                      cancelamentoHistorico.confirmacao.trim() !== CONFIRMACAO_CANCELAMENTO_UI
                    }
                  >
                    Confirmar cancelamento auditado
                  </button>
                </div>
              </div>
            )}
          {cancelamentoHistorico.resultado && (
            <p className="flow-stats">{cancelamentoHistorico.resultado}</p>
          )}
          {ativacao && (
            <p className="flow-stats">
              Autorização registrada. O ambiente continua em modo de validação, sem envio real.
            </p>
          )}
          {workerRun && (
            <div className="flow-stats">
              <p>Resultado do teste de processamento:</p>
              {workerRun.motivo && <p>Motivo do bloqueio: <code>{workerRun.motivo}</code></p>}
              {workerRun.resultado && (
                <ul>
                  <li>Processados: {workerRun.resultado.processados}</li>
                  <li>Enviados (sintético): {workerRun.resultado.enviados}</li>
                  <li>Falhas: {workerRun.resultado.falhas}</li>
                </ul>
              )}
              {workerRun.aviso && <small>{workerRun.aviso}</small>}
            </div>
          )}
          <table className="flow-table">
            <thead>
              <tr>
                <th>Registro</th>
                <th>Processamento</th>
                <th>Status</th>
                <th>Tentativas</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {outbox.map((o) => (
                <tr key={o.outboxId}>
                  <td>
                    <code>{o.outboxId.slice(0, 8)}…</code>
                  </td>
                  <td>{o.codigo ?? "—"}</td>
                  <td>{rotuloStatus(o.status)}</td>
                  <td>{o.tentativas}</td>
                  <td>{o.erroCodigo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
        </>
      )}
    </div>
  );
}
