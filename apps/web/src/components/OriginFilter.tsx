import {
  FILTROS_ORIGEM,
  type ValorFiltroOrigem,
} from "../model";

interface OriginFilterProps {
  readonly value: ValorFiltroOrigem;
  readonly onChange: (value: ValorFiltroOrigem) => void;
}

export function OriginFilter({ value, onChange }: OriginFilterProps) {
  return (
    <fieldset className="origin-filter">
      <legend>Filtrar origem</legend>
      <div className="segmented-control">
        {FILTROS_ORIGEM.map((filtro) => (
          <button
            key={filtro.valor}
            type="button"
            className={filtro.valor === value ? "is-selected" : undefined}
            aria-pressed={filtro.valor === value}
            onClick={() => onChange(filtro.valor)}
          >
            {filtro.rotulo}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
