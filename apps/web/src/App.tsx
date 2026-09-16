import { useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { AreaNavigation } from "./components/AreaNavigation";
import { ConfirmationQueuePanel } from "./components/ConfirmationQueuePanel";
import { MetricCard } from "./components/MetricCard";
import { OriginFilter } from "./components/OriginFilter";
import { WorkflowPanel } from "./components/WorkflowPanel";
import { ConfirmationPage } from "./pages/ConfirmationPage";
import {
  INDICADORES,
  obterArea,
  type AreaCockpit,
  type ValorFiltroOrigem,
} from "./model";

const CONTROLES_FUNDACAO = [
  "Identidade PF e PJ preservada",
  "Nenhum dado operacional neste Preview",
  "Rede e envio ao PPN desabilitados",
  "Evidências preparadas para SHA-256",
] as const;

export function App() {
  const [areaAtiva, setAreaAtiva] = useState<AreaCockpit>("entrada");
  const [origem, setOrigem] = useState<ValorFiltroOrigem>("TODOS");

  if (window.location.pathname.startsWith("/confirma/")) {
    return <ConfirmationPage />;
  }

  const area = obterArea(areaAtiva);

  return (
    <div className="app-shell">
      <AppHeader />

      <div className="app-layout">
        <aside className="sidebar">
          <AreaNavigation ativa={areaAtiva} onChange={setAreaAtiva} />

          <div className="sidebar-note">
            <span className="sidebar-note-mark" aria-hidden="true">
              i
            </span>
            <div>
              <strong>Ambiente estrutural</strong>
              <p>Sem consulta a planilhas, banco de dados ou Correios.</p>
            </div>
          </div>
        </aside>

        <main className="main-content">
          <section className="page-intro" aria-labelledby="page-title">
            <div>
              <span className="eyebrow">{area.rotulo}</span>
              <h1 id="page-title">{area.titulo}</h1>
              <p>{area.descricao}</p>
            </div>
            <OriginFilter value={origem} onChange={setOrigem} />
          </section>

          <div className="foundation-banner" role="status">
            <span className="banner-icon" aria-hidden="true">
              ✓
            </span>
            <div>
              <strong>Interface pronta para conexão controlada</strong>
              <p>
                Os indicadores permanecem vazios até que uma fonte operacional seja autorizada e
                integrada.
              </p>
            </div>
            <span className="banner-tag">Sem dados amostrais</span>
          </div>

          <section className="metrics-grid" aria-label="Indicadores operacionais">
            {INDICADORES.map((indicador) => (
              <MetricCard
                key={indicador.rotulo}
                label={indicador.rotulo}
                detail={indicador.detalhe}
              />
            ))}
          </section>

          <div className="content-grid">
            <section className="action-panel" aria-labelledby="action-title">
              <div className="section-heading compact">
                <div>
                  <span className="eyebrow">Área selecionada</span>
                  <h2 id="action-title">{area.rotulo}</h2>
                </div>
                <span className="origin-badge">
                  {origem === "TODOS" ? "PF + PJ" : origem}
                </span>
              </div>

              <div className="empty-state">
                <span className="empty-graphic" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <h3>Nenhum conteúdo operacional carregado</h3>
                <p>
                  A fundação visual está ativa. A ação será habilitada somente após o adaptador da
                  fonte autorizada passar pelos gates de segurança.
                </p>
                <button type="button" disabled title="Disponível após integração autorizada">
                  {area.acao}
                </button>
              </div>
            </section>

            <aside className="controls-panel" aria-labelledby="controls-title">
              <span className="eyebrow">Guardrails</span>
              <h2 id="controls-title">Controles da fundação</h2>
              <ul>
                {CONTROLES_FUNDACAO.map((controle) => (
                  <li key={controle}>
                    <span aria-hidden="true">✓</span>
                    {controle}
                  </li>
                ))}
              </ul>
              <div className="profile-card">
                <span>Perfil PPN</span>
                <strong>Perfil Ouro</strong>
                <small>Contrato versionado · conexão inativa</small>
              </div>
            </aside>
          </div>

          <ConfirmationQueuePanel />

          <WorkflowPanel ativa={areaAtiva} onChange={setAreaAtiva} />
        </main>
      </div>
    </div>
  );
}
