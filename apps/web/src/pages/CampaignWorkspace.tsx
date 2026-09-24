import { AppHeader } from "../components/AppHeader";

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
            <strong>Fundação bloqueada</strong>
            <span>Feature flag desabilitada · envio real indisponível</span>
          </aside>
        </header>

        <section className="campaign-guardrail" aria-label="Regras de segurança">
          <strong>Nenhum lote pode ser criado ou enviado nesta fase.</strong>
          <p>
            São obrigatórios antes da ativação: identificador institucional na base, identidade
            individual do operador, aprovação auditada e gate específico de execução.
            CONTROLLED_GMAIL_TEST permanece exclusivo do piloto técnico.
          </p>
        </section>

        <section className="campaign-operator-card" aria-label="Identidade do operador">
          <div>
            <span>Identidade operacional</span>
            <strong>operator_id individual obrigatório</strong>
          </div>
          <p>
            O OPERATOR_TOKEN legado permanece um mecanismo técnico/administrativo e não representa
            uma pessoa nesta interface.
          </p>
        </section>

        <section className="campaign-steps" aria-label="Jornada operacional">
          {etapas.map(([titulo, descricao], index) => (
            <article className="campaign-step" key={titulo}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{titulo}</h2>
                <p>{descricao}</p>
              </div>
            </article>
          ))}
        </section>

        <section className="campaign-summary-grid" aria-label="Resumo da campanha">
          <article>
            <span>Base</span>
            <strong>0</strong>
            <p>Nenhum arquivo importado no banco.</p>
          </article>
          <article>
            <span>Em quarentena</span>
            <strong>0</strong>
            <p>Duplicidades exigirão decisão humana.</p>
          </article>
          <article>
            <span>Aprovados</span>
            <strong>0</strong>
            <p>Nenhuma aprovação persistida.</p>
          </article>
          <article>
            <span>Enviados</span>
            <strong>0</strong>
            <p>Envio real permanece indisponível.</p>
          </article>
        </section>
      </main>
    </div>
  );
}
