import { useState } from "react";

interface ConfirmationForm {
  readonly decision: "CONFIRMAR" | "ATUALIZAR";
  readonly logradouro: string;
  readonly numero: string;
  readonly bairro: string;
  readonly cidade: string;
  readonly uf: string;
  readonly cep: string;
  readonly telefone: string;
  readonly whatsapp: string;
}

const INITIAL_FORM: ConfirmationForm = {
  decision: "CONFIRMAR",
  logradouro: "",
  numero: "",
  bairro: "",
  cidade: "",
  uf: "",
  cep: "",
  telefone: "",
  whatsapp: "",
};

function validate(form: ConfirmationForm): string | undefined {
  if (form.decision === "CONFIRMAR") return undefined;
  if (!form.logradouro.trim() || !form.numero.trim() || !form.bairro.trim() || !form.cidade.trim()) {
    return "Preencha o endereço completo.";
  }
  if (!/^[A-Za-z]{2}$/.test(form.uf.trim())) return "Informe uma UF válida.";
  if (form.cep.replace(/\D/g, "").length !== 8) return "Informe um CEP com 8 dígitos.";
  if (!form.telefone.trim()) return "Informe um telefone para contato.";
  return undefined;
}

export function ConfirmationPage() {
  const [form, setForm] = useState<ConfirmationForm>(INITIAL_FORM);
  const [feedback, setFeedback] = useState<string>();

  function update(field: keyof ConfirmationForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFeedback(undefined);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validate(form);
    if (error) {
      setFeedback(error);
      return;
    }
    setFeedback("Solicitação registrada para processamento seguro.");
  }

  return (
    <main className="confirmation-page">
      <div className="confirmation-card">
        <span className="eyebrow">Integra Correios · confirmação PF</span>
        <h1>Confirme seus dados cadastrais</h1>
        <p className="confirmation-lead">
          Revise as informações recebidas. Esta página não exibe nem solicita CPF e não envia dados
          enquanto a integração autorizada não estiver ativa.
        </p>

        <form onSubmit={submit} noValidate>
          <fieldset>
            <legend>Decisão</legend>
            <label className="choice-label">
              <input
                type="radio"
                name="decision"
                checked={form.decision === "CONFIRMAR"}
                onChange={() => update("decision", "CONFIRMAR")}
              />
              Confirmar os dados apresentados
            </label>
            <label className="choice-label">
              <input
                type="radio"
                name="decision"
                checked={form.decision === "ATUALIZAR"}
                onChange={() => update("decision", "ATUALIZAR")}
              />
              Informar uma alteração
            </label>
          </fieldset>

          <fieldset disabled={form.decision === "CONFIRMAR"}>
            <legend>Dados atualizados (se necessário)</legend>
            <div className="form-grid">
              <label>Logradouro<input value={form.logradouro} onChange={(event) => update("logradouro", event.target.value)} /></label>
              <label>Número<input value={form.numero} onChange={(event) => update("numero", event.target.value)} /></label>
              <label>Bairro<input value={form.bairro} onChange={(event) => update("bairro", event.target.value)} /></label>
              <label>Cidade<input value={form.cidade} onChange={(event) => update("cidade", event.target.value)} /></label>
              <label>UF<input maxLength={2} value={form.uf} onChange={(event) => update("uf", event.target.value.toUpperCase())} /></label>
              <label>CEP<input inputMode="numeric" maxLength={9} value={form.cep} onChange={(event) => update("cep", event.target.value)} /></label>
              <label>Telefone<input inputMode="tel" value={form.telefone} onChange={(event) => update("telefone", event.target.value)} /></label>
              <label>WhatsApp (opcional)<input inputMode="tel" value={form.whatsapp} onChange={(event) => update("whatsapp", event.target.value)} /></label>
            </div>
          </fieldset>

          <button className="confirmation-submit" type="submit">Enviar confirmação</button>
          <p className="confirmation-feedback" role="status" aria-live="polite">{feedback}</p>
        </form>
      </div>
    </main>
  );
}
