import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { AppHeader } from "../components/AppHeader";
import { campaignLogoutDisposition } from "./campaign-logout-state";

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
  phase: "FOUNDATION";
  individualOperatorIdentityRequired: true;
  canPersistImport: false;
  canCreateBatch: false;
  canExecute: false;
  realSendEnabled: boolean;
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
      setEtapa(4);
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
  async function avaliarBase() {
    if (!arquivo || !avaliacaoArquivo) return;
    const ausentes = CAMPOS_OBRIGATORIOS.filter(
      (campo) => !(typeof mapeamento[campo] === "number" && mapeamento[campo] >= 0),
    );
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
          "x-file-name": arquivo.name,
          "x-mapping": JSON.stringify(mapeamento),
        },
        body: arquivo,
      });
      setBase(resultado);
      setExcluidos([]);
      setAprovacao(null);
      setEtapa(5);
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
      setEtapa(8);
    } catch (error) {
      setErroEtapa(
        error instanceof ApiCampanhaError ? error.message : "Aprovação recusada pelo servidor.",
      );
    } finally {
      setAvaliando(false);
    }
  }

  function alternativaSintetica() {
    setErroEtapa("");
    setAvaliando(true);
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
        setEtapa(5);
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

  function alternarExclusao(linha: number) {
    setExcluidos((atual) =>
      atual.includes(linha) ? atual.filter((item) => item !== linha) : [...atual, linha],
    );
    setAprovacao(null);
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
            {feedback ? <span className="campaign-session-error" role="status">{feedback}</span> : null}
          </div>
        </section>

        <nav className="campaign-journey" aria-label="Etapas da jornada operacional">
          <ol>
            {ETAPAS.map((item) => (
              <li key={item.numero} className={etapa === item.numero ? "is-active" : undefined}>
                <button
                  type="button"
                  onClick={() => setEtapa(item.numero)}
                  aria-current={etapa === item.numero ? "step" : undefined}
                >
                  <span>{String(item.numero).padStart(2, "0")}</span>
                  <strong>{ROTULOS_ETAPA[item.numero]}</strong>
                </button>
              </li>
            ))}
          </ol>
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
          Etapa atual: {String(etapa).padStart(2, "0")} · {ROTULOS_ETAPA[etapa]} · Ações disponíveis:{" "}
          {status?.availableActions.join(", ") || "—"}
        </p>
        <p className="campaign-actions-note">
          Bloqueadas: EXECUTAR_LOTE (canExecute=false nesta fase) · ACOMPANHAR_PAUSAR_CANCELAR
          (nenhum lote em execução — canCreateBatch=false) · ADMIN_TECNICO não recebe poder
          operacional implícito.
        </p>

        {erroEtapa ? (
          <p className="campaign-feedback campaign-feedback-error" role="alert">{erroEtapa}</p>
        ) : null}

        {/* Etapa 3 — Importação */}
        {etapa === 3 && (
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
            {avaliacaoArquivo ? (
              <div className="campaign-flow-stats">
                <p>SHA-256: <code>{avaliacaoArquivo.sha256}</code></p>
                <p>Folhas: {avaliacaoArquivo.folhas_disponiveis.join(", ")} · Linhas: {avaliacaoArquivo.total_linhas}</p>
                <p>Cabeçalhos: {avaliacaoArquivo.cabecalhos.join(" · ") || "—"}</p>
                <button type="button" onClick={() => setEtapa(4)}>Confirmar e ir para o mapeamento</button>
              </div>
            ) : null}
          </section>
        )}

        {/* Etapa 4 — Mapeamento */}
        {etapa === 4 && avaliacaoArquivo && (
          <section className="campaign-panel" aria-labelledby="etapa-mapeamento">
            <h2 id="etapa-mapeamento">4 · Mapeamento de colunas</h2>
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
              <button type="button" onClick={avaliarBase} disabled={avaliando || !podeImportar}>
                {avaliando ? "Avaliando…" : "Confirmar mapeamento e classificar"}
              </button>
              {motivosBloqueioImportacao.map((motivo) => (
                <small key={motivo} role="status">Bloqueado: {motivo}</small>
              ))}
            </div>
          </section>
        )}
        {etapa === 4 && !avaliacaoArquivo ? (
          <section className="campaign-panel">
            <h2>4 · Mapeamento de colunas</h2>
            <p>Nenhum arquivo analisado nesta sessão. Volte à etapa 3 para importar.</p>
            <button type="button" onClick={() => setEtapa(3)}>Ir para a importação</button>
          </section>
        ) : null}

        {/* Etapa 5 — Inconsistências */}
        {etapa === 5 && base && (
          <section className="campaign-panel" aria-labelledby="etapa-inconsistencias">
            <h2 id="etapa-inconsistencias">5 · Inconsistências aguardando decisão humana</h2>
            <p>
              Duplicidades e divergências de normalização exigem decisão do papel REVISOR. Nada é
              corrigido automaticamente; o arquivo original nunca é alterado.
            </p>
            {base.inconsistencias_pendentes === 0 ? (
              <p className="campaign-flow-stats">Nenhuma inconsistência pendente nesta base.</p>
            ) : (
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
            )}
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
            <div className="campaign-panel-actions">
              <button type="button" onClick={() => setEtapa(6)}>Continuar para a revisão</button>
            </div>
          </section>
        )}
        {etapa === 5 && !base ? (
          <section className="campaign-panel">
            <h2>5 · Inconsistências</h2>
            <p>Nenhuma base avaliada nesta sessão. Importe e mapeie um arquivo primeiro.</p>
            <button type="button" onClick={() => setEtapa(3)}>Ir para a importação</button>
          </section>
        ) : null}

        {/* Etapa 6 — Revisão dos profissionais */}
        {etapa === 6 && base && (
          <section className="campaign-panel" aria-labelledby="etapa-revisao">
            <h2 id="etapa-revisao">6 · Revisão dos profissionais</h2>
            <p>
              Base final por identificador institucional. Marque exclusões apenas quando a decisão
              humana justificar (EXCLUIR_DO_LOTE); a marcação invalida qualquer aprovação vigente.
            </p>
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
              <button type="button" onClick={() => setEtapa(7)} disabled={aptosParaAprovacao.length === 0}>
                Continuar para a prévia ({aptosParaAprovacao.length} aptos)
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

        {/* Etapa 7 — Prévia das mensagens */}
        {etapa === 7 && base && (
          <section className="campaign-panel" aria-labelledby="etapa-previa">
            <h2 id="etapa-previa">7 · Prévia das mensagens</h2>
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
              <button type="button" onClick={() => setEtapa(8)} disabled={aptosParaAprovacao.length === 0}>
                Ir para a aprovação
              </button>
            </div>
          </section>
        )}
        {etapa === 7 && !base ? (
          <section className="campaign-panel">
            <h2>7 · Prévia das mensagens</h2>
            <p>Nenhuma base avaliada nesta sessão.</p>
            <button type="button" onClick={() => setEtapa(3)}>Ir para a importação</button>
          </section>
        ) : null}

        {/* Etapa 8 — Aprovação */}
        {etapa === 8 && base && (
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
        {etapa === 8 && !base ? (
          <section className="campaign-panel">
            <h2>8 · Aprovação</h2>
            <p>Nenhuma base avaliada nesta sessão.</p>
            <button type="button" onClick={() => setEtapa(3)}>Ir para a importação</button>
          </section>
        ) : null}

        {/* Etapa 9 — Execução controlada (sempre bloqueada nesta fase) */}
        {etapa === 9 && (
          <section className="campaign-panel" aria-labelledby="etapa-execucao">
            <h2 id="etapa-execucao">9 · Execução controlada</h2>
            <p>
              A execução de lote aprovado permanece bloqueada por política da fundação
              (canExecute=false). Nenhum caminho da interface pode iniciar envio — o gate é
              server-side e não existe botão de execução nesta etapa.
            </p>
            <ul className="campaign-flow-stats">
              <li>Lote aprovado: {aprovacao ? `hash ${aprovacao.conteudoHash.slice(0, 12)}…` : "nenhum"}</li>
              <li>Manifesto final: apresentado após a autorização humana de envio (futura).</li>
              <li>Autorização de envio: aguardando gate externo — não disponível na interface.</li>
            </ul>
          </section>
        )}

        {/* Etapa 10 — Acompanhamento */}
        {etapa === 10 && (
          <section className="campaign-panel" aria-labelledby="etapa-acompanhamento">
            <h2 id="etapa-acompanhamento">10 · Acompanhamento</h2>
            <p>
              Contadores operacionais consolidados da sessão. Nenhum envio foi realizado; os
              contadores de envio permanecem zerados por construção.
            </p>
            <table className="campaign-table">
              <thead>
                <tr><th>Indicador</th><th>Valor</th></tr>
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
          </section>
        )}

        <section className="campaign-guardrail" aria-label="Regras de segurança">
          <strong>Nenhum lote pode ser criado ou enviado nesta fase.</strong>
          <p>
            A identidade individual e os papéis são verificados no servidor em cada mutação.
            Importação persistente, criação de lote e execução continuam desabilitadas até o
            próximo gate. CONTROLLED_GMAIL_TEST permanece exclusivo do piloto técnico.
          </p>
        </section>
      </main>
    </div>
  );
}
