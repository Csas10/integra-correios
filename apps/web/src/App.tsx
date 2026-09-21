import { AppHeader } from "./components/AppHeader";
import { ConfirmationPage } from "./pages/ConfirmationPage";
import { OperationalFlow } from "./pages/OperationalFlow";

export function App() {
  if (window.location.pathname.startsWith("/confirma/")) {
    return <ConfirmationPage />;
  }

  return (
    <div className="app-shell pf-operator-shell">
      <AppHeader />
      <main className="pf-operator-main">
        <section className="pf-operator-hero" aria-labelledby="pf-operator-title">
          <div>
            <span className="eyebrow">Profissionais</span>
            <h1 id="pf-operator-title">Envio controlado de carteiras profissionais</h1>
            <p>
              Importe a base, confira os dados, revise as comunicações e acompanhe cada etapa em um
              único fluxo operacional.
            </p>
          </div>
          <div className="pf-environment-badge" role="status">
            <strong>Ambiente de validação</strong>
            <span>Separado da produção · envio real desabilitado</span>
          </div>
        </section>

        <section className="pf-safety-banner" aria-label="Escopo deste ambiente">
          <div>
            <strong>Fluxo exclusivo para profissionais</strong>
            <p>
              Este ambiente trabalha somente com PF nesta etapa. Empresas, produção, Gmail real e
              PPN permanecem fora deste fluxo de validação.
            </p>
          </div>
          <span>PF</span>
        </section>

        <OperationalFlow />
      </main>
    </div>
  );
}
