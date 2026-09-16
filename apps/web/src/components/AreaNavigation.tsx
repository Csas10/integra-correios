import { AREAS_COCKPIT, type AreaCockpit } from "../model";

interface AreaNavigationProps {
  readonly ativa: AreaCockpit;
  readonly onChange: (area: AreaCockpit) => void;
}

export function AreaNavigation({ ativa, onChange }: AreaNavigationProps) {
  return (
    <nav className="area-navigation" aria-label="Áreas do cockpit">
      <p className="navigation-label">Fluxo operacional</p>
      <ol>
        {AREAS_COCKPIT.map((area, index) => {
          const isActive = area.id === ativa;
          return (
            <li key={area.id}>
              <button
                type="button"
                className={isActive ? "area-link is-active" : "area-link"}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onChange(area.id)}
              >
                <span className="area-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{area.rotulo}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
