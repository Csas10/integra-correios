import { useCallback, useEffect, useRef, useState } from "react";

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

const API_BASE = (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? "http://localhost:8787";
const PILOT_MAX = 5;

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
  { id: "UPLOAD", rotulo: "1. Upload XLSX" },
  { id: "MAPPING", rotulo: "2. Mapping" },
  { id: "PREFLIGHT", rotulo: "3. Validar" },
  { id: "PERSISTIDO", rotulo: "4. Confirmar" },
  { id: "COCKPIT", rotulo: "5. Profissionais" },
  { id: "LOTE", rotulo: "6. Lote" },
  { id: "OUTBOX", rotulo: "7. Outbox" },
];

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
  const [lote, setLote] = useState<{ loteId: string; codigo: string; totalItens: number } | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [workerRun, setWorkerRun] = useState<WorkerRun | null>(null);
  const [ativacao, setAtivacao] = useState<string | null>(null);
  const arquivoRef = useRef<FormData | null>(null);

  const guardarArquivo = useCallback((form: FormData) => {
    arquivoRef.current = form;
  }, []);

  async function chamar(caminho: string, init?: RequestInit): Promise<unknown> {
    const resposta = await fetch(`${API_BASE}${caminho}`, init);
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      throw new Error((corpo as { erro?: string }).erro ?? `HTTP ${resposta.status}`);
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

  async function prepararLote() {
    setOcupado(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ professionalIds: [...selecao] }),
      })) as { loteId: string; codigo: string; totalItens: number };
      setLote(resposta);
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
      const resposta = (await chamar(`/api/pilot/outbox?loteId=${lote.loteId}`)) as {
        itens: OutboxItem[];
      };
      setOutbox(resposta.itens);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao consultar outbox.");
    } finally {
      setOcupado(false);
    }
  }

  const carregarReadiness = useCallback(async () => {
    try {
      setReadiness((await chamar("/api/readiness")) as ReadinessReport);
    } catch {
      setReadiness(null);
    }
  }, []);

  useEffect(() => {
    void carregarReadiness();
  }, [carregarReadiness]);

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
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha na liberação do lote.");
    } finally {
      setOcupado(false);
    }
  }

  async function executarWorkerUmaVez() {
    setOcupado(true);
    setErro(undefined);
    try {
      const resposta = (await chamar("/api/pilot/worker/run-once", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      })) as WorkerRun;
      setWorkerRun(resposta);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha na execução do worker.");
    } finally {
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

      {etapa === "UPLOAD" && (
        <section className="flow-panel" aria-labelledby="upload-title">
          <h2 id="upload-title">Importar base de profissionais</h2>
          <p>Selecione o arquivo .xlsx institucional. A importação NÃO envia e-mail.</p>
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
          />
          <button type="button" disabled={!arquivo || ocupado} onClick={enviarArquivo}>
            {ocupado ? "Analisando…" : "Analisar arquivo"}
          </button>
        </section>
      )}

      {analise && etapa === "MAPPING" && (
        <section className="flow-panel" aria-labelledby="mapping-title">
          <h2 id="mapping-title">Revisar mapping</h2>
          <p>
            SHA-256: <code>{analise.sha256.slice(0, 16)}…</code> · Folha{" "}
            <strong>{analise.folha}</strong> · {analise.totalLinhas} linhas
          </p>
          {analise.cabecalhosDuplicados.length > 0 && (
            <p className="flow-warn">
              Cabeçalhos duplicados: {analise.cabecalhosDuplicados.join(", ")}
            </p>
          )}
          <table className="flow-table">
            <thead>
              <tr>
                <th>Campo</th>
                <th>Coluna sugerida</th>
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
                        setMapeamento((m) => ({
                          ...m,
                          [s.campo]: Number(e.target.value),
                        }))
                      }
                    >
                      <option value="">— não mapeado —</option>
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
            Executar preflight (validação sem persistir)
          </button>
        </section>
      )}

      {resumo && etapa === "PREFLIGHT" && (
        <section className="flow-panel" aria-labelledby="preflight-title">
          <h2 id="preflight-title">Validar importação</h2>
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
                  <th>Issues</th>
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
            Confirmar importação (persistir no PostgreSQL)
          </button>
        </section>
      )}

      {resultadoImportacao && etapa === "PERSISTIDO" && (
        <section className="flow-panel" aria-labelledby="persisted-title">
          <h2 id="persisted-title">Importação confirmada</h2>
          <ul className="flow-stats">
            <li>Profissionais criados: {resultadoImportacao.profissionaisCriados}</li>
            <li>Linhas pendentes: {resultadoImportacao.linhasPendentes}</li>
            <li>Linhas inválidas: {resultadoImportacao.linhasInvalidas}</li>
          </ul>
          <button type="button" onClick={() => setEtapa("COCKPIT")}>
            Ir para profissionais
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
                  key={f}
                  type="button"
                  className={filtro === f ? "is-selected" : ""}
                  onClick={() => {
                    setFiltro(f);
                    void carregarProfissionais();
                  }}
                >
                  {f}
                </button>
              ),
            )}
          </div>
          <p>
            Selecionados: {selecao.size} / {PILOT_MAX} (limite do piloto validado no backend)
          </p>
          <div className="flow-scroll">
            <table className="flow-table">
              <thead>
                <tr>
                  <th>Piloto</th>
                  <th>Código</th>
                  <th>Nome</th>
                  <th>E-mail</th>
                  <th>Telefone</th>
                  <th>Endereço</th>
                  <th>Status</th>
                  <th>Issues</th>
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
                    <td>{p.status}</td>
                    <td>{p.issues.join("; ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" disabled={selecao.size === 0 || ocupado} onClick={gerarPreview}>
            Gerar preview das comunicações (não envia)
          </button>
        </section>
      )}

      {previews && (
        <section className="flow-panel" aria-labelledby="preview-title">
          <h2 id="preview-title">Preview das comunicações</h2>
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
              <small>Template: {p.templateVersion}</small>
            </details>
          ))}
          <button
            type="button"
            className="flow-primary"
            disabled={ocupado}
            onClick={prepararLote}
          >
            CONFIRMAR PREPARAÇÃO DO LOTE ({previews.quantidade}/{previews.maximo})
          </button>
        </section>
      )}

      {readiness && (
        <section className="flow-panel" aria-labelledby="readiness-title">
          <h2 id="readiness-title">Prontidão operacional</h2>
          <p>
            Modo atual: <strong>{readiness.executionMode}</strong> — a ausência de configuração
            deixa de ser ambígua. Nenhum valor sensível é exibido.
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
        </section>
      )}

      {etapa === "OUTBOX" && lote && (
        <section className="flow-panel" aria-labelledby="outbox-title">
          <h2 id="outbox-title">Status da outbox</h2>
          <p>
            Lote <strong>{lote.codigo}</strong> com {lote.totalItens} item(ns), em PREPARACAO —
            não elegível a envio até liberação humana explícita (PREPARACAO → ATIVO).
          </p>
          <div className="flow-filters">
            <button type="button" onClick={atualizarOutbox} disabled={ocupado}>
              Atualizar status
            </button>
            <button type="button" onClick={liberarLote} disabled={ocupado}>
              LIBERAR LOTE (PREPARACAO → ATIVO) — decisão humana
            </button>
            <button type="button" onClick={executarWorkerUmaVez} disabled={ocupado}>
              Executar worker uma iteração (DRY_RUN)
            </button>
          </div>
          {ativacao && (
            <p className="flow-stats">
              Liberação: <code>{ativacao}</code> — lote ATIVO para o motor. Envio real permanece
              bloqueado (REAL_SEND_ENABLED=false).
            </p>
          )}
          {workerRun && (
            <div className="flow-stats">
              <p>Worker one-shot ({workerRun.modo ?? "DRY_RUN"}):</p>
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
                <th>Outbox</th>
                <th>Lote</th>
                <th>Status</th>
                <th>Tentativas</th>
                <th>Erro</th>
              </tr>
            </thead>
            <tbody>
              {outbox.map((o) => (
                <tr key={o.outboxId}>
                  <td>
                    <code>{o.outboxId.slice(0, 8)}…</code>
                  </td>
                  <td>{o.codigo ?? "—"}</td>
                  <td>{o.status}</td>
                  <td>{o.tentativas}</td>
                  <td>{o.erroCodigo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
