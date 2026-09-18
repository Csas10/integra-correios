import { ufBrasileiraValida } from "@integra-correios/validation";
import { createWebTokenService, type ConfirmationOwnership, type ConsumePendingConfirmation } from "@integra-correios/pf-workflow";
import {
  Aes256GcmSecretBox,
  PostgresOperationalRepository,
} from "@integra-correios/persistence";

/**
 * F5 — Backend público por capability token (sem CPF/código/UUID na URL).
 *
 * CONSULTAR → contexto mínimo do snapshot (nome, endereço apresentado,
 *             telefone mascarado). Token inválido/expirado/consumido → 404.
 * CONFIRMAR → consumePending (compare-and-set atômico) + fechamento
 *             transacional server-side: snapshot confirmado, workflow,
 *             auditoria. Replay/expiração FAIL CLOSED.
 * ATUALIZAR → validação dos dados propostos; ORIGINAL preservado; snapshot
 *             CONFIRMADO criado com os dados propostos; workflow decide
 *             APTO_PREPOSTAGEM × PENDENCIA_CADASTRAL por regra server-side.
 */

type Environment = Readonly<Record<string, string | undefined>>;

export interface ConfirmationDecisionInput {
  readonly decision: "CONFIRMAR" | "ATUALIZAR";
  readonly logradouro?: string;
  readonly numero?: string;
  readonly complemento?: string;
  readonly bairro?: string;
  readonly cidade?: string;
  readonly uf?: string;
  readonly cep?: string;
  readonly telefone?: string;
  readonly whatsapp?: string;
}

export interface SubmissaoResultado {
  readonly status: "APTO_PREPOSTAGEM" | "PENDENCIA_CADASTRAL";
  readonly registrado: true;
}

/** Valida os dados propostos (somente ATUALIZAR). Server-side, nunca browser. */
export function validarDadosPropostos(input: ConfirmationDecisionInput): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (input.decision === "CONFIRMAR") return { ok: true, issues };
  if (!input.logradouro?.trim()) issues.push("Logradouro obrigatório");
  if (!input.numero?.trim()) issues.push("Número obrigatório");
  if (!input.bairro?.trim()) issues.push("Bairro obrigatório");
  if (!input.cidade?.trim()) issues.push("Cidade obrigatória");
  if (!input.uf || !ufBrasileiraValida(input.uf)) issues.push("UF inválida");
  if ((input.cep ?? "").replace(/\D/g, "").length !== 8) issues.push("CEP inválido");
  if (!input.telefone?.trim()) issues.push("Telefone obrigatório");
  return { ok: issues.length === 0, issues };
}

/**
 * Fecha a confirmação server-side: consumo atômico do token + registro
 * transacional do resultado no repositório operacional. Idempotente em
 * replay: o segundo consumo falha no compare-and-set (fail closed).
 */
export async function concluirConfirmacao(
  token: string,
  input: ConfirmationDecisionInput,
  ownership: ConfirmationOwnership,
  repository: PostgresOperationalRepository,
  caixa: Aes256GcmSecretBox,
  agora: Date = new Date(),
): Promise<SubmissaoResultado> {
  const agoraIso = agora.toISOString();
  const tokens = createWebTokenService();
  const tokenHash = await tokens.hash(token);

  // 1) Consumo atômico (compare-and-set) — replay/expiração falham fechados.
  const command: ConsumePendingConfirmation = {
    confirmationId: await obterConfirmationIdPorHash(repository, tokenHash),
    tokenHash,
    usedAt: agoraIso,
    decision: input.decision,
  };
  const consumida = await ownership.consumePending(command);
  if (!consumida) {
    throw new ConfirmationInvalidaError("TOKEN_INVALID_OR_EXPIRED");
  }

  // 2) Snapshot decidido: CONFIRMAR mantém o conteúdo; ATUALIZAR propõe novo.
  const original = await decifrarSnapshotOriginal(repository, caixa, consumida.professionalId);
  if (!original) {
    throw new ConfirmationInvalidaError("ORIGINAL_NOT_FOUND");
  }
  const decidido =
    input.decision === "CONFIRMAR"
      ? original
      : {
          ...original,
          endereco: {
            logradouro: input.logradouro ?? "",
            numero: input.numero ?? "",
            complemento: input.complemento ?? undefined,
            bairro: input.bairro ?? "",
            cidade: input.cidade ?? "",
            uf: input.uf ?? "",
            cep: (input.cep ?? "").replace(/\D/g, ""),
          },
          telefone: input.telefone ?? original.telefone,
          ...(input.whatsapp ? { whatsapp: input.whatsapp } : {}),
        };

  // 3) Fechamento transacional server-side (repositório decide o workflow).
  const resultado = await repository.registrarResultadoConfirmacao({
    confirmationId: consumida.id,
    professionalId: consumida.professionalId,
    snapshotCifrado: caixa.seal(JSON.stringify(decidido), "snapshot:original"),
    snapshotDecidido: decidido as Record<string, unknown>,
    decisao: input.decision,
    fonte: "CONFIRMACAO_WEB",
    occurredAt: agoraIso,
  });

  return { status: resultado.status as SubmissaoResultado["status"], registrado: true };
}

export class ConfirmationInvalidaError extends Error {
  constructor(readonly codigo: string) {
    super(`Confirmação inválida: ${codigo}`);
    this.name = "ConfirmationInvalidaError";
  }
}

async function obterConfirmationIdPorHash(
  repository: PostgresOperationalRepository,
  tokenHash: string,
): Promise<string> {
  const result = await repository.pool.query<{ id: string }>(
    `SELECT id FROM confirmacao WHERE token_hash = $1 AND status = 'PENDING' LIMIT 1`,
    [tokenHash],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new ConfirmationInvalidaError("TOKEN_NOT_FOUND");
  return id;
}

async function decifrarSnapshotOriginal(
  repository: PostgresOperationalRepository,
  caixa: Aes256GcmSecretBox,
  professionalId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await repository.pool.query<{
    conteudo_ciphertext: Uint8Array;
    conteudo_nonce: Uint8Array;
    conteudo_auth_tag: Uint8Array;
    chave_versao: string;
  }>(
    `SELECT conteudo_ciphertext, conteudo_nonce, conteudo_auth_tag, chave_versao
    FROM snapshot_cadastral
    WHERE profissional_id = $1 AND tipo = 'ORIGINAL' AND vigente`,
    [professionalId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  try {
    return JSON.parse(
      new TextDecoder().decode(
        caixa.open(
          {
            ciphertext: row.conteudo_ciphertext,
            nonce: row.conteudo_nonce,
            authTag: row.conteudo_auth_tag,
            keyVersion: row.chave_versao,
          },
          "snapshot:original",
        ),
      ),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
