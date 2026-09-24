import { useEffect, useState } from "react";
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

const etapas = [
  ["Minha fila", "Lotes e tarefas atribuídos ao operador."],
  ["Importar base", "Pré-voo XLSX preservando o arquivo original."],
  ["Revisar inconsistências", "Duplicidades, inválidos e identidade institucional."],
  ["Revisar mensagens", "Destinatário mascarado, assunto e corpo personalizados."],
  ["Solicitar aprovação", "Resumo imutável antes de qualquer execução."],
  ["Executar lote aprovado", "Ação bloqueada nesta fase de fundação."],
  ["Acompanhar resultados", "Progresso, falhas seguras e itens pausados."],
] as const;

export function CampaignWorkspace() {
  const [me, setMe] = useState<OperatorMe | null>(null);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState("");

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
              Fluxo independente do piloto Gmail controlado. A infraestrutura homologada será
              reutilizada somente por contratos próprios da campanha, sem acesso direto a OAuth ou
              tokens.
            </p>
          </div>
          <aside className="campaign-lock" aria-label="Estado da campanha">
            <strong>Persistência e execução bloqueadas</strong>
            <span>Identidade individual ativa · campanha ainda fail-closed</span>
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

        <section className="campaign-guardrail" aria-label="Regras de segurança">
          <strong>Nenhum lote pode ser criado ou enviado nesta fase.</strong>
          <p>
            A identidade individual e os papéis já são verificados no servidor. Importação
            persistente, criação de lote e execução continuam desabilitadas até o próximo gate.
            CONTROLLED_GMAIL_TEST permanece exclusivo do piloto técnico.
          </p>
        </section>

        <section className="campaign-steps" aria-label="Jornada operacional">
          {etapas.map(([titulo, descricao], index) => (
            <article className="campaign-step" key={titulo}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><h2>{titulo}</h2><p>{descricao}</p></div>
            </article>
          ))}
        </section>

        <section className="campaign-summary-grid" aria-label="Resumo da campanha">
          <article><span>Base</span><strong>0</strong><p>Nenhum arquivo importado no banco.</p></article>
          <article><span>Em quarentena</span><strong>0</strong><p>Duplicidades exigirão decisão humana.</p></article>
          <article><span>Aprovados</span><strong>0</strong><p>Nenhuma aprovação persistida.</p></article>
          <article><span>Enviados</span><strong>0</strong><p>Envio real permanece indisponível.</p></article>
        </section>
      </main>
    </div>
  );
}
