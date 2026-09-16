import { AREAS_COCKPIT, type AreaCockpit } from "../model";

interface WorkflowPanelProps {
  readonly ativa: AreaCockpit;
  readonly onChange: (area: AreaCockpit) => void;
}

export function WorkflowPanel({ ativa, onChange }: WorkflowPanelProps) {
  const activeIndex = AREAS_COCKPIT.findIndex((area) => area.id === ativa);

  return (
    <section className="workflow-panel" aria-labelledby="workflow-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Visão do processo</span>
          <h2 id="workflow-title">Da entrada à auditoria</h2>
        </div>
        <p>Um único motor, com identidade e rastreabilidade separadas por origem.</p>
      </div>

      <ol className="workflow-list">
        {AREAS_COCKPIT.map((area, index) => {
          const state = index === activeIndex ? "active" : index < activeIndex ? "complete" : "next";
          return (
            <li key={area.id} className={`workflow-step is-${state}`}>
              <button type="button" onClick={() => onChange(area.id)}>
                <span className="workflow-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span>
                  <strong>{area.rotulo}</strong>
                  <small>{area.titulo}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
