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
import { cpfValido, emailValido } from "@integra-correios/validation";
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
  readonly classificacao: "PARSED" | "REVIEW_REQUIRED" | "INVALID";
  readonly enderecoOrigem: string;
  readonly issues: readonly string[];
}

export interface RegistroPreflight {
  readonly numeroLinha: number;
  readonly codigo: string;
  readonly nome: string;
  readonly emailValido: boolean;
  readonly cpfValido: boolean;
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
}export interface PreflightInput {
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
  const fingerprints = new Set<string>();
  let duplicados = 0;

  for (const linha of aplicado.linhas) {
    const issues: string[] = [];
    const codigo = (linha.valores.CODIGO ?? "").trim();
    const nome = (linha.valores.NOME ?? "").trim();
    const email = (linha.valores.EMAIL ?? "").trim();
    const telefone = (linha.valores.TELEFONE ?? "").trim();
    const documento = (linha.valores.CPF_CNPJ ?? "").replace(/\D/g, "");
    const enderecoOrigem = (linha.valores.ENDERECO_COMPOSTO ?? "").trim();

    if (!codigo) issues.push("CODIGO vazio.");
    if (!nome) issues.push("NOME vazio.");
    const emailOk = email.length > 0 && emailValido(email);
    if (!emailOk) issues.push("E-mail inválido ou ausente.");
    const cpfOk = cpfValido(documento);
    if (!cpfOk) issues.push("CPF inválido.");
    for (const alerta of linha.alertasNumericos) {
      issues.push(`Bloqueio: ${alerta}`);
    }

    const parsing = parsearEnderecoComposto(enderecoOrigem);
    if (parsing.classificacao === "REVIEW_REQUIRED") {
      issues.push("Endereço requer revisão (decomposição assistida incompleta).");
    } else if (parsing.classificacao === "INVALID") {
      issues.push("Endereço inválido/não parseável.");
    }

    // Deduplicação por fingerprint HMAC do documento — nunca criamos dois
    // profissionais para o mesmo CPF. Linhas duplicadas permanecem listadas.
    const fingerprint = documento ? hmac.fingerprint("cpf-preflight", documento) : "";
    let duplicada = false;
    if (fingerprint) {
      if (fingerprints.has(fingerprint)) {
        duplicada = true;
        duplicados += 1;
        issues.push("Duplicada: mesmo CPF já presente no arquivo.");
      } else {
        fingerprints.add(fingerprint);
      }
    }

    const aptoContato = issues.length === 0;
    registros.push({
      numeroLinha: linha.numero,
      codigo,
      nome,
      emailValido: emailOk,
      cpfValido: cpfOk,
      endereco: {
        classificacao: parsing.classificacao,
        enderecoOrigem,
        issues: parsing.issues,
      },
      issues: duplicada ? [...issues] : issues,
      aptoContato,
    });
  }

  const validos = registros.filter((r) => !r.issues.includes("CODIGO vazio.") && r.cpfValido).length;
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

import { createHmac } from "node:crypto";
const hmac = {
  fingerprint(namespace: string, valor: string): string {
    return createHmac("sha256", "preflight-synthetic-key").update(namespace).update("\0").update(valor).digest("hex");
  },
};

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
  readonly linhasPendentes: number;
  readonly linhasInvalidas: number;
}

/**
 * Persiste a importação confirmada:
 *   arquivo_importacao → importacao → linha_importada → profissional
 *   → snapshot ORIGINAL (cifrado) → evento_auditoria.
 *
 * Idempotência: reimportar o MESMO arquivo (mesmo SHA-256) é determinístico —
 * o arquivo é registrado uma única vez e os profissionais existentes
 * (mesma origem+codigo) não são recriados. Duplicidade de CPF entre
 * códigos diferentes é bloqueada pela UNIQUE (origem, documento_fingerprint).
 */
export async function confirmarImportacao(
  command: ConfirmarImportacaoCommand,
  repository: PostgresOperationalRepository,
  pool: {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly any[]; rowCount: number | null }>;
  },
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

  const sha256 = leitura.sha256;

  // 1) arquivo_importacao — idempotente por SHA-256 (arquivo já registrado
  //    não gera segunda linha).
  const existente = await pool.query(
    `SELECT id FROM arquivo_importacao WHERE sha256 = $1 AND origem = 'PF' LIMIT 1`,
    [sha256],
  );
  let arquivoId: string;
  if (existente.rows[0]) {
    arquivoId = existente.rows[0]!.id;
  } else {
    arquivoId = randomUUID();
    await pool.query(
      `INSERT INTO arquivo_importacao (id, origem, nome_original, mime_type, tamanho_bytes, sha256, storage_key)
       VALUES ($1, 'PF', $2, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', $3, $4, $5)`,
      [arquivoId, command.nomeArquivo, command.bytes.length, sha256, `mem://pf/${sha256}`],
    );
  }

  // 2) importacao
  const importacaoId = randomUUID();
  await pool.query(
    `INSERT INTO importacao (id, arquivo_importacao_id, origem, status, total_linhas, linhas_validas, linhas_pendentes)
     VALUES ($1, $2, 'PF', 'VALIDADA', $3, 0, 0)`,
    [importacaoId, arquivoId, aplicado.linhas.length],
  );

  const agora = new Date().toISOString();
  let criados = 0;
  let pendentes = 0;
  let invalidas = 0;

  for (const linha of aplicado.linhas) {
    const codigo = (linha.valores.CODIGO ?? "").trim();
    const nome = (linha.valores.NOME ?? "").trim();
    const email = (linha.valores.EMAIL ?? "").trim();
    const telefone = (linha.valores.TELEFONE ?? "").trim();
    const celular = (linha.valores.CELULAR ?? "").trim();
    const documento = (linha.valores.CPF_CNPJ ?? "").replace(/\D/g, "");
    const enderecoOrigem = (linha.valores.ENDERECO_COMPOSTO ?? "").trim();
    const parsing = parsearEnderecoComposto(enderecoOrigem);

    const issues: string[] = [];
    let statusLinha: "VALIDA" | "PENDENTE" | "INVALIDA" = "VALIDA";
    if (!codigo || !nome) {
      statusLinha = "INVALIDA";
      issues.push("CODIGO/NOME obrigatórios.");
    }
    if (!cpfValido(documento)) {
      statusLinha = statusLinha === "INVALIDA" ? "INVALIDA" : "PENDENTE";
      issues.push("CPF inválido.");
    }
    if (!emailValido(email)) {
      statusLinha = statusLinha === "INVALIDA" ? "INVALIDA" : "PENDENTE";
      issues.push("E-mail inválido.");
    }
    if (parsing.classificacao !== "PARSED") {
      statusLinha = statusLinha === "INVALIDA" ? "INVALIDA" : "PENDENTE";
      issues.push(`Endereço ${parsing.classificacao}.`);
    }
    if (linha.alertasNumericos.length > 0) {
      statusLinha = "INVALIDA";
      issues.push("Célula numérica em campo sensível a zeros.");
    }

    // linha_importada com dados brutos cifrados (preservação integral).
    const fingerprint = documento
      ? fingerprinter.fingerprint("cpf-importacao", documento)
      : null;
    await pool.query(
      `INSERT INTO linha_importada (importacao_id, folha, numero_linha, dados_brutos_ciphertext, dados_brutos_nonce, dados_brutos_auth_tag, chave_versao, documento_fingerprint, status, inconsistencias)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        importacaoId,
        folha.nome,
        linha.numero,
        ...parametrosCifrados(caixa.seal(JSON.stringify(linha.valores), "linha:bruta"), keyVersion),
        fingerprint,
        statusLinha,
        JSON.stringify(issues),
      ],
    );

    if (statusLinha === "INVALIDA") {
      invalidas += 1;
      continue;
    }
    if (statusLinha === "PENDENTE") {
      pendentes += 1;
    }

    // profissional — idempotente por (origem, codigo_operacional).
    const profissional = await pool.query(
      `SELECT id FROM profissional WHERE origem = 'PF' AND codigo_operacional = $1`,
      [codigo],
    );
    if (!profissional.rows[0]) {
      const profissionalId = randomUUID();
      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "CARTEIRA_IDENTIFICADA",
        document: {
          documentType: "CPF",
          fingerprint: fingerprint!,
          encrypted: caixa.seal(documento, "documento:cpf"),
        },
        originalSnapshot: caixa.seal(
          JSON.stringify({
            documento,
            nome,
            email,
            telefone,
            whatsapp: celular || undefined,
            endereco: {
              logradouro: parsing.sugerido.logradouro,
              numero: parsing.sugerido.numero,
              complemento: parsing.sugerido.complemento,
              bairro: parsing.sugerido.bairro,
              cidade: parsing.sugerido.cidade,
              uf: parsing.sugerido.uf,
              cep: parsing.sugerido.cep,
            },
            enderecoOrigem,
          }),
          "snapshot:original",
        ),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO",
          actorId: command.operador,
          occurredAt: agora,
          metadata: { importacaoId, classificacaoEndereco: parsing.classificacao },
          eventHash: hashEvento(profissionalId, agora),
        },
      });
      criados += 1;
    }
  }

  // importacao concluída com contagens reais.
  await pool.query(
    `UPDATE importacao
     SET status = 'CONCLUIDA', linhas_validas = $2, linhas_pendentes = $3, concluida_em = now()
     WHERE id = $1`,
    [importacaoId, criados + (pendentes ? 0 : 0), pendentes],
  );

  return {
    arquivoImportacaoId: arquivoId,
    importacaoId,
    profissionaisCriados: criados,
    linhasPendentes: pendentes,
    linhasInvalidas: invalidas,
  };
}

function parametrosCifrados(valor: { ciphertext: Uint8Array; nonce: Uint8Array; authTag: Uint8Array }, keyVersion: string) {
  return [Buffer.from(valor.ciphertext), Buffer.from(valor.nonce), Buffer.from(valor.authTag), keyVersion];
}

function hashEvento(id: string, ocorreuEm: string): string {
  return createHmac("sha256", "audit-chain").update(id).update(ocorreuEm).digest("hex");
}
