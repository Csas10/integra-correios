interface MetricCardProps {
  readonly label: string;
  readonly detail: string;
}

export function MetricCard({ label, detail }: MetricCardProps) {
  return (
    <article className="metric-card">
      <div className="metric-heading">
        <span>{label}</span>
        <span className="metric-empty" aria-label="Sem dados carregados">
          —
        </span>
      </div>
      <p>{detail}</p>
      <div className="metric-state">
        <span aria-hidden="true" />
        Aguardando fonte autorizada
      </div>
    </article>
  );
}
