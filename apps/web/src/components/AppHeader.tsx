export function AppHeader() {
  return (
    <header className="app-header">
      <div className="brand" aria-label="Integra Correios — Carteiras Profissionais">
        <span className="brand-mark" aria-hidden="true">
          IC
        </span>
        <span className="brand-copy">
          <strong>Integra Correios</strong>
          <small>Carteiras Profissionais</small>
        </span>
      </div>

      <div className="environment-chip" aria-label="Ambiente de validação controlada">
        <span aria-hidden="true" />
        Validação controlada
      </div>
    </header>
  );
}
