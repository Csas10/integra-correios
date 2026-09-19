import { useEffect, useState } from "react";
import { ufBrasileiraValida } from "@integra-correios/validation";

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
  if (!ufBrasileiraValida(form.uf)) return "Informe uma UF válida.";
  if (form.cep.replace(/\D/g, "").length !== 8) return "Informe um CEP com 8 dígitos.";
  if (!form.telefone.trim()) return "Informe um telefone para contato.";
  return undefined;
}

export function ConfirmationPage() {
  const [form, setForm] = useState<ConfirmationForm>(INITIAL_FORM);
  const [feedback, setFeedback] = useState<string>();
  const [enviando, setEnviando] = useState(false);
  const [erroServidor, setErroServidor] = useState<string>();
  const [concluido, setConcluido] = useState<"APTO_PREPOSTAGEM" | "PENDENCIA_CADASTRAL">();
  const [contexto, setContexto] = useState<{
    nome: string;
    enderecoApresentado: string;
    telefoneMascarado: string;
    expiraEm: string;
  }>();

  // F5: token vem da URL (/confirma/:token) — capability token, nunca CPF/código/id.
  const token =
    typeof window !== "undefined"
      ? decodeURIComponent(window.location.pathname.split("/").pop() ?? "")
      : "";

  // F5: contexto mínimo do backend (nome, endereço apresentado, telefone
  // mascarado). Token inválido/expirado/consumido → erro, sem dados.
  useEffect(() => {
    let cancelado = false;
    if (!token) return;
    fetch(`/api/confirmation?token=${encodeURIComponent(token)}`)
      .then(async (resposta) => {
        const corpo = (await resposta.json().catch(() => ({}))) as {
          erro?: string;
          nome?: string;
          enderecoApresentado?: string;
          telefoneMascarado?: string;
          expiraEm?: string;
        };
        if (cancelado) return;
        if (!resposta.ok) {
          setErroServidor(corpo.erro ?? "Link de confirmação inválido ou expirado.");
          return;
        }
        setContexto({
          nome: corpo.nome ?? "",
          enderecoApresentado: corpo.enderecoApresentado ?? "",
          telefoneMascarado: corpo.telefoneMascarado ?? "—",
          expiraEm: corpo.expiraEm ?? "",
        });
      })
      .catch(() => {
        if (!cancelado) setErroServidor("Serviço de confirmação indisponível.");
      });
    return () => {
      cancelado = true;
    };
  }, [token]);

  function update(field: keyof ConfirmationForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFeedback(undefined);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = validate(form);
    if (error) {
      setFeedback(error);
      return;
    }
    setEnviando(true);
    setErroServidor(undefined);
    try {
      const resposta = await fetch("/api/confirmation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          decision: form.decision,
          ...(form.decision === "ATUALIZAR"
            ? {
                logradouro: form.logradouro,
                numero: form.numero,
                bairro: form.bairro,
                cidade: form.cidade,
                uf: form.uf,
                cep: form.cep,
                telefone: form.telefone,
                ...(form.whatsapp ? { whatsapp: form.whatsapp } : {}),
              }
            : {}),
        }),
      });
      const corpo = (await resposta.json().catch(() => ({}))) as {
        erro?: string;
        status?: string;
      };
      if (!resposta.ok) {
        setErroServidor(corpo.erro ?? "Não foi possível registrar a confirmação.");
        return;
      }
      setConcluido(corpo.status === "PENDENCIA_CADASTRAL" ? "PENDENCIA_CADASTRAL" : "APTO_PREPOSTAGEM");
    } catch {
      setErroServidor("Serviço de confirmação indisponível.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="confirmation-page">
      <div className="confirmation-card">
        <span className="eyebrow">Integra Correios · confirmação PF</span>
        <h1>Confirme seus dados cadastrais</h1>
        {concluido ? (
          <p className="confirmation-lead" role="status">
            {concluido === "APTO_PREPOSTAGEM"
              ? "Confirmação registrada. Seus dados estão aptos para a pré-postagem da Carteira Profissional."
              : "Confirmação registrada. Há pendências cadastrais a corrigir antes da pré-postagem — a CRT-BA entrará em contato."}
          </p>
        ) : erroServidor ? (
          <p className="confirmation-lead" role="alert">{erroServidor}</p>
        ) : (
          <>
            <p className="confirmation-lead">
              Revise as informações recebidas. Esta página não exibe nem solicita CPF.
            </p>
            {contexto && (
              <div className="confirmation-context">
                <p><strong>{contexto.nome}</strong></p>
                <p>Endereço registrado: {contexto.enderecoApresentado}</p>
                <p>Telefone: {contexto.telefoneMascarado}</p>
              </div>
            )}
          </>
        )}
        {!concluido && !erroServidor && (

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

          <button className="confirmation-submit" type="submit" disabled={enviando}>
            {enviando ? "Enviando…" : "Enviar confirmação"}
          </button>
          <p className="confirmation-feedback" role="status" aria-live="polite">{feedback}</p>
        </form>
        )}
      </div>
    </main>
  );
}
