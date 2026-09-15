export function AppHeader() {
  return (
    <header className="app-header">
      <div className="brand" aria-label="Integra Correios">
        <span className="brand-mark" aria-hidden="true">
          IC
        </span>
        <span className="brand-copy">
          <strong>Integra Correios</strong>
          <small>Operação PF e PJ</small>
        </span>
      </div>

      <div className="environment-chip" aria-label="Ambiente Preview">
        <span aria-hidden="true" />
        Preview de fundação
      </div>
    </header>
  );
}
