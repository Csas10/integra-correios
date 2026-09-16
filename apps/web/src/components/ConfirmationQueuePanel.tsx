import { PF_QUEUE_STAGES } from "../model";

export function ConfirmationQueuePanel() {
  return (
    <section className="confirmation-queue-panel" aria-labelledby="confirmation-queue-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Fluxo PF</span>
          <h2 id="confirmation-queue-title">Confirmação cadastral</h2>
        </div>
        <p>Filas estruturais prontas para receber a fonte autorizada, sem contagens amostrais.</p>
      </div>
      <ol className="confirmation-queue-list">
        {PF_QUEUE_STAGES.map((stage, index) => (
          <li key={stage.id}>
            <span className="queue-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{stage.rotulo}</strong>
              <small>{stage.descricao}</small>
            </div>
            <span className="queue-empty" aria-label={`Nenhum valor carregado para ${stage.rotulo}`}>—</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
