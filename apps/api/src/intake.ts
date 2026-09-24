import { randomUUID } from "node:crypto";
import {
  aplicarMapeamento,
  confirmarMapeamento,
  lerXlsx,
  parsearEnderecoComposto,
  sha256Arquivo,
  sugerirMapeamento,
  validarMapeamento,
  type Campo,
  type FolhaExtraida,
  type Mapeamento,
  type OpcoesLeituraXlsx,
  type ResultadoLeituraXlsx,
} from "@integra-correios/importers";
import { cpfValido, emailValido, telefoneValido } from "@integra-correios/validation";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  type PostgresOperationalRepository,
} from "@integra-correios/persistence";

/**
 * Intake operacional PF — orquestração backend da Fase B.
 *
 * Regras:
 *  - Análise/preflight são PURAS: nenhum side effect, nenhuma persistência;
 *  - Persistência somente em confirmarImportacao(), com confirmação
 *    explícita do operador;
 *  - UPLOAD != ENVIO: nada aqui cria lote, comunicação ou outbox;
 *  - Dados sensíveis (CPF) nunca retornam completos — mascarados;
 *  - CPF é persistido cifrado (AES-256-GCM) + fingerprint HMAC para dedup.
 */

// ---------------------------------------------------------------------------
// Análise estrutural (etapa 1 do fluxo)
// ---------------------------------------------------------------------------

export interface AnaliseIntake {
  readonly sha256: string;
  readonly nomeArquivo: string;
  readonly folhasDisponiveis: readonly string[];
  readonly folha: string;
  readonly linhaCabecalho: number;
  readonly cabecalhos: readonly string[];
  readonly cabecalhosDuplicados: readonly string[];
  readonly totalLinhas: number;
  readonly sugestao: readonly { campo: Campo; cabecalho: string | null; coluna: number | null }[];
  /** Prévia das primeiras N linhas (texto cru, sem persistência). */
  readonly preview: readonly { numero: number; valores: readonly string[] }[];
}

export function analisarXlsx(nomeArquivo: string, bytes: Uint8Array, folha?: string, linhaCabecalho?: number): AnaliseIntake {
  const leitura: ResultadoLeituraXlsx = lerXlsx(
    { nome: nomeArquivo, bytes },
    opcoesLeitura(folha, linhaCabecalho),
  );
  return {
    sha256: leitura.sha256,
    nomeArquivo,
    folhasDisponiveis: leitura.folhasDisponiveis,
    folha: leitura.folha.nome,
    linhaCabecalho: leitura.folha.linhaCabecalho,
    cabecalhos: leitura.folha.cabecalhos,
    cabecalhosDuplicados: leitura.cabecalhosDuplicados,
    totalLinhas: leitura.folha.linhas.length,
    sugestao: sugerirMapeamento(leitura.folha.cabecalhos),
    preview: leitura.folha.linhas.slice(0, 8).map((linha) => ({
      numero: linha.numero,
      valores: linha.celulas.map((celula) => celula.texto),
    })),
  };
}

// ---------------------------------------------------------------------------
// Preflight (etapa de validação — sem persistência)
// ---------------------------------------------------------------------------

export interface StatusEndereco {
  readonly classificacao: "PARSED" | "REVIEW_REQUIRED" | "INVALID" | "NOT_PROVIDED";
  readonly enderecoOrigem: string;
  readonly issues: readonly string[];
}

export interface RegistroPreflight {
  readonly numeroLinha: number;
  readonly codigo: string;
  readonly nome: string;
  readonly emailValido: boolean;
  readonly cpfValido: boolean;
  readonly telefoneValido: boolean;
  readonly endereco: StatusEndereco;
  readonly issues: readonly string[];
  readonly aptoContato: boolean;
}

export interface ResumoPreflight {
  readonly sha256: string;
  readonly total: number;
  readonly validos: number;
  readonly invalidos: number;
  readonly cpfInvalido: number;
  readonly emailInvalido: number;
  readonly enderecoRequerRevisao: number;
  readonly enderecoInvalido: number;
  readonly duplicados: number;
  readonly aptosContato: number;
  readonly registros: readonly RegistroPreflight[];
}

/**
 * Mascara um CPF para exibição: ***.***.###-## (nunca completo).
 */
export function mascararCpf(documento: string): string {
  const digitos = documento.replace(/\D/g, "");
  if (digitos.length !== 11) return "***";
  return `***.***.${digitos.slice(6, 9)}-${digitos.slice(9)}`;
}

export interface PreflightInput {
  readonly nomeArquivo: string;
  readonly bytes: Uint8Array;
  readonly folha?: string;
  readonly linhaCabecalho?: number;
  /** Mapeamento confirmado pelo operador: campo → índice de coluna. */
  readonly mapeamento: readonly { campo: Campo; coluna: number }[];
}

/** Helper compatível com exactOptionalPropertyTypes (nunca passa undefined). */
function opcoesLeitura(folha?: string, linhaCabecalho?: number): OpcoesLeituraXlsx {
  const opcoes: { folha?: string; linhaCabecalho?: number } = {};
  if (folha !== undefined) opcoes.folha = folha;
  if (linhaCabecalho !== undefined) opcoes.linhaCabecalho = linhaCabecalho;
  return opcoes;
}

type AnaliseEndereco = {
  readonly enderecoOrigem: string;
  readonly informado: boolean;
  readonly parsing?: ReturnType<typeof parsearEnderecoComposto>;
};

function analisarEndereco(
  valores: Readonly<Partial<Record<Campo, string>>>,
): AnaliseEndereco {
  const composto = (valores.ENDERECO_COMPOSTO ?? "").trim();
  const logradouro = (valores.LOGRADOURO ?? "").trim();
  const numero = (valores.NUMERO ?? "").trim();
  const partes = [
    [logradouro, numero].filter(Boolean).join(", "),
    (valores.COMPLEMENTO ?? "").trim(),
    (valores.BAIRRO ?? "").trim(),
    (valores.CIDADE ?? "").trim(),
    (valores.UF ?? "").trim(),
    (valores.CEP ?? "").trim(),
  ].filter(Boolean);
  const enderecoOrigem = composto || partes.join(" - ");
  if (!enderecoOrigem) {
    return { enderecoOrigem: "", informado: false };
  }
  return {
    enderecoOrigem,
    informado: true,
    parsing: parsearEnderecoComposto(enderecoOrigem),
  };
}

export function executarPreflight(input: PreflightInput): ResumoPreflight {
  const leitura = lerXlsx(
    { nome: input.nomeArquivo, bytes: input.bytes },
    opcoesLeitura(input.folha, input.linhaCabecalho),
  );
  const folha: FolhaExtraida = leitura.folha;
  const mapeamentoConfirmado = confirmarMapeamento(
    { itens: input.mapeamento } satisfies Mapeamento,
    folha.cabecalhos.length,
    "PF",
  );
  const aplicado = aplicarMapeamento(folha, mapeamentoConfirmado);

  const registros: RegistroPreflight[] = [];
  // F11: deduplicação apenas EM MEMÓRIA, pelo documento normalizado — sem
  // chave fixa de desenvolvimento, sem fingerprint persistido.
  const documentosVistos = new Set<string>();
  let duplicados = 0;

  for (const linha of aplicado.linhas) {
    const issues: string[] = [];
    const codigo = (linha.valores.CODIGO ?? "").trim();
    const nome = (linha.valores.NOME ?? "").trim();
    const email = (linha.valores.EMAIL ?? "").trim();
    const telefone = (linha.valores.TELEFONE ?? "").trim();
    const documento = (linha.valores.CPF_CNPJ ?? "").replace(/\D/g, "");
    const endereco = analisarEndereco(linha.valores);

    if (!nome) issues.push("NOME vazio.");
    const emailOk = email.length > 0 && emailValido(email);
    if (!emailOk) issues.push("E-mail inválido ou ausente.");
    const cpfOk = cpfValido(documento);
    if (!cpfOk) issues.push("CPF inválido.");
    // Requisito real de contato homologado: TELEFONE presente e válido.
    const telefoneOk = telefoneValido(telefone);
    if (!telefoneOk) issues.push("Telefone inválido ou ausente.");
    for (const alerta of linha.alertasNumericos) {
      issues.push(`Bloqueio: ${alerta}`);
    }

    // Contrato PF: endereço é condição NÃO bloqueante para APTO_CONTATO —
    // permanece como alerta/contador para revisão do operador e bloqueia
    // somente a progressão postal posterior (APTO_PREPOSTAGEM, via
    // validarCadastroPf). Ausência vira NOT_PROVIDED sem pendência.
    if (endereco.parsing?.classificacao === "REVIEW_REQUIRED") {
      issues.push("Endereço requer revisão (decomposição assistida incompleta).");
    } else if (endereco.parsing?.classificacao === "INVALID") {
      issues.push("Endereço inválido/não parseável.");
    }

    // Deduplicação em memória pelo documento normalizado — nunca criamos dois
    // profissionais para o mesmo CPF. Linhas duplicadas permanecem listadas.
    let duplicada = false;
    if (documento) {
      if (documentosVistos.has(documento)) {
        duplicada = true;
        duplicados += 1;
        issues.push("Duplicada: mesmo CPF já presente no arquivo.");
      } else {
        documentosVistos.add(documento);
      }
    }

    const aptoContato =
      nome.length > 0 && emailOk && cpfOk && telefoneOk && linha.alertasNumericos.length === 0 && !duplicada;
    registros.push({
      numeroLinha: linha.numero,
      codigo,
      nome,
      emailValido: emailOk,
      cpfValido: cpfOk,
      telefoneValido: telefoneOk,
      endereco: {
        classificacao: endereco.parsing?.classificacao ?? "NOT_PROVIDED",
        enderecoOrigem: endereco.enderecoOrigem,
        issues: endereco.parsing?.issues ?? [],
      },
      issues: duplicada ? [...issues, "Duplicada."] : issues,
      aptoContato,
    });
  }

  const validos = registros.filter((r) => r.cpfValido).length;
  return {
    sha256: leitura.sha256,
    total: registros.length,
    validos,
    invalidos: registros.length - validos,
    cpfInvalido: registros.filter((r) => !r.cpfValido).length,
    emailInvalido: registros.filter((r) => !r.emailValido).length,
    enderecoRequerRevisao: registros.filter(
      (r) => r.endereco.classificacao === "REVIEW_REQUIRED",
    ).length,
    enderecoInvalido: registros.filter((r) => r.endereco.classificacao === "INVALID").length,
    duplicados,
    aptosContato: registros.filter((r) => r.aptoContato).length,
    registros,
  };
}

// ---------------------------------------------------------------------------
// Confirmação da importação (persistência — só com ação explícita)
// ---------------------------------------------------------------------------

export interface ConfirmarImportacaoCommand {
  readonly nomeArquivo: string;
  readonly bytes: Uint8Array;
  readonly folha?: string;
  readonly linhaCabecalho?: number;
  readonly mapeamento: readonly { campo: Campo; coluna: number }[];
  readonly operador: string;
}

export interface ResultadoConfirmarImportacao {
  readonly arquivoImportacaoId: string;
  readonly importacaoId: string;
  readonly profissionaisCriados: number;
  /** F9: linhas elegíveis — independe de profissionais já existentes. */
  readonly linhasValidas: number;
  readonly linhasPendentes: number;
  readonly linhasInvalidas: number;
}

/**
 * Persiste a importação confirmada — F8: UMA única transação operacional no
 * persistence package (registrarImportacaoPf): arquivo_importacao →
 * importacao → linha_importada → profissional → snapshot ORIGINAL (cifrado)
 * → evento_auditoria. Falha intermediária = ROLLBACK integral (provado por
 * teste de falha no meio da escrita).
 *
 * F9: contagens semânticas (linhas_validas = linhas elegíveis para criação,
 * independe de quantos profissionais já existiam) são calculadas e
 * persistidas pelo persistence package.
 *
 * Idempotência: reimportar o MESMO arquivo (mesmo SHA-256) é determinístico —
 * o arquivo é registrado uma única vez e os profissionais existentes
 * (mesma origem+codigo ou mesmo fingerprint documental) não são recriados.
 * Duplicidade de CPF entre códigos diferentes é bloqueada pela UNIQUE
 * (origem, documento_fingerprint).
 */
export async function confirmarImportacao(
  command: ConfirmarImportacaoCommand,
  repository: PostgresOperationalRepository,
): Promise<ResultadoConfirmarImportacao> {
  const leitura = lerXlsx(
    { nome: command.nomeArquivo, bytes: command.bytes },
    opcoesLeitura(command.folha, command.linhaCabecalho),
  );
  const folha = leitura.folha;
  const mapeamentoConfirmado = confirmarMapeamento(
    { itens: command.mapeamento } satisfies Mapeamento,
    folha.cabecalhos.length,
    "PF",
  );
  const aplicado = aplicarMapeamento(folha, mapeamentoConfirmado);

  // Chaves de criptografia: exigidas do ambiente (fail-closed).
  const encryptionKeyB64 = process.env.DATA_ENCRYPTION_KEY_BASE64;
  const fingerprintKeyB64 = process.env.DOCUMENT_FINGERPRINT_KEY_BASE64;
  const keyVersion = process.env.DATA_ENCRYPTION_KEY_VERSION?.trim();
  if (!encryptionKeyB64 || !fingerprintKeyB64 || !keyVersion) {
    throw new Error(
      "Configuração de criptografia ausente (DATA_ENCRYPTION_KEY_BASE64 / DOCUMENT_FINGERPRINT_KEY_BASE64 / DATA_ENCRYPTION_KEY_VERSION).",
    );
  }
  const caixa = new Aes256GcmSecretBox(Buffer.from(encryptionKeyB64, "base64"), keyVersion);
  const fingerprinter = new HmacSha256Fingerprinter(Buffer.from(fingerprintKeyB64, "base64"));

  const agora = new Date().toISOString();

  // Pré-processamento puro (sem side effects): classificação das linhas +
  // payload de profissional elegível.
  const linhas = aplicado.linhas.map((linha) => {
    const codigo = (linha.valores.CODIGO ?? "").trim();
    const nome = (linha.valores.NOME ?? "").trim();
    const email = (linha.valores.EMAIL ?? "").trim();
    const telefone = (linha.valores.TELEFONE ?? "").trim();
    const celular = (linha.valores.CELULAR ?? "").trim();
    const documento = (linha.valores.CPF_CNPJ ?? "").replace(/\D/g, "");
    const endereco = analisarEndereco(linha.valores);
    const parsing = endereco.parsing;

    const issues: string[] = [];
    let statusLinha: "VALIDA" | "PENDENTE" | "INVALIDA" = "VALIDA";
    if (!nome) {
      statusLinha = "INVALIDA";
      issues.push("NOME obrigatório.");
    }
    if (!cpfValido(documento)) {
      statusLinha = statusLinha === "INVALIDA" ? "INVALIDA" : "PENDENTE";
      issues.push("CPF inválido.");
    }
    if (!emailValido(email)) {
      statusLinha = statusLinha === "INVALIDA" ? "INVALIDA" : "PENDENTE";
      issues.push("E-mail inválido.");
    }
    // Requisito real de contato homologado: TELEFONE presente e válido.
    if (!telefoneValido(telefone)) {
      statusLinha = statusLinha === "INVALIDA" ? "INVALIDA" : "PENDENTE";
      issues.push("Telefone inválido ou ausente.");
    }
    // Contrato PF: endereço NÃO bloqueia APTO_CONTATO. Ausência → NOT_PROVIDED
    // (sem pendência); REVIEW_REQUIRED/INVALID permanecem apenas como
    // inconsistência informativa (revisão assistida) e bloqueiam somente a
    // progressão postal posterior (validarCadastroPf → APTO_PREPOSTAGEM).
    if (linha.alertasNumericos.length > 0) {
      statusLinha = "INVALIDA";
      issues.push("Célula numérica em campo sensível a zeros.");
    }

    const fingerprint = documento ? fingerprinter.fingerprint("cpf-importacao", documento) : null;
    const profissionalId = randomUUID();
    const codigoOperacional = codigo || profissionalId;
    const profissionalElegivel =
      statusLinha !== "INVALIDA" && fingerprint
        ? {
            id: profissionalId,
            codigoOperacional,
            // O preflight + confirmação da importação constituem a triagem
            // operacional desta vertical slice: linha com requisitos de
            // CONTATO íntegros entra APTO_CONTATO (endereço é não bloqueante);
            // linha com pendência fica bloqueada para revisão.
            status: statusLinha === "VALIDA" ? "APTO_CONTATO" : "PENDENCIA_TRIAGEM",
            documento: caixa.seal(documento, "documento:cpf"),
            originalSnapshot: caixa.seal(
              JSON.stringify({
                documento,
                nome,
                email,
                telefone,
                whatsapp: celular || undefined,
                endereco: {
                  logradouro: parsing?.classificacao === "PARSED" ? parsing.sugerido.logradouro : "",
                  numero: parsing?.classificacao === "PARSED" ? parsing.sugerido.numero : "",
                  complemento: parsing?.classificacao === "PARSED" ? parsing.sugerido.complemento : "",
                  bairro: parsing?.classificacao === "PARSED" ? parsing.sugerido.bairro : "",
                  cidade: parsing?.classificacao === "PARSED" ? parsing.sugerido.cidade : "",
                  uf: parsing?.classificacao === "PARSED" ? parsing.sugerido.uf : "",
                  cep: parsing?.classificacao === "PARSED" ? parsing.sugerido.cep : "",
                },
                enderecoOrigem: endereco.enderecoOrigem,
                enderecoInformado: endereco.informado,
              }),
              "snapshot:original",
            ),
          }
        : undefined;

    return {
      numeroLinha: linha.numero,
      dadosBrutos: caixa.seal(JSON.stringify(linha.valores), "linha:bruta"),
      documentoFingerprint: fingerprint,
      statusLinha,
      inconsistencias: issues,
      ...(profissionalElegivel ? { profissional: profissionalElegivel } : {}),
    };
  });

  // F8: UMA transação no persistence package para toda a escrita operacional.
  const resultado = await repository.registrarImportacaoPf({
    nomeArquivo: command.nomeArquivo,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytesLength: command.bytes.length,
    sha256: leitura.sha256,
    storageKey: `mem://pf/${leitura.sha256}`,
    folha: folha.nome,
    operador: command.operador,
    agora,
    linhas,
  });

  return {
    arquivoImportacaoId: resultado.arquivoImportacaoId,
    importacaoId: resultado.importacaoId,
    profissionaisCriados: resultado.profissionaisCriados,
    linhasValidas: resultado.linhasValidas,
    linhasPendentes: resultado.linhasPendentes,
    linhasInvalidas: resultado.linhasInvalidas,
  };
}
