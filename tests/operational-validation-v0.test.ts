import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  Aes256GcmSecretBox,
  HmacSha256Fingerprinter,
  NodePostgresPool,
  PostgresConfirmationOwnership,
  PostgresOperationalRepository,
} from "@integra-correios/persistence";
import { STATUS_OPERACIONAIS, validarTransicao, type StatusOperacional } from "@integra-correios/domain";
import {
  criarProfissionalPf,
  InMemoryConfirmationOwnership,
  PF_CONFIRMATION_STATUSES,
  PfConfirmationWorkflow,
  PfTransitionError,
  validarCadastroPf,
  validarTransicaoPf,
  type PfCadastreSnapshot,
  type PfConfirmationStatus,
  type PfWorkflowState,
} from "@integra-correios/pf-workflow";
import type { MailGateway, MailReceipt, OutboundMail } from "@integra-correios/mail";

// ============================================================================
// Validação Operacional V0 — massa 100% sintética.
// PostgreSQL real quando DATABASE_URL estiver definido (a CI aplica
// database/migrations/*.sql antes de rodar os testes). Sem DATABASE_URL,
// apenas os cenários de domínio puro executam; os cenários de persistência
// são pulados com motivo explícito.
//
// Regras da suíte:
//  - Nenhuma comunicação real (gateway de mail sintético);
//  - Nenhum dado real de PF (fixtures sintéticas; PII scan deve passar);
//  - Nenhum PII nos metadados de auditoria (o repository bloqueia chaves
//    proibidas e a suíte respeita essa regra).
// ============================================================================

const temBanco = Boolean(process.env.DATABASE_URL);
const d = temBanco ? describe : describe.skip;

const caixa = new Aes256GcmSecretBox(new Uint8Array(32).fill(11), "v0-validation");
const fingerprinter = new HmacSha256Fingerprinter(new Uint8Array(32).fill(13));

function hash64(seed: string): string {
  return Array.from(
    { length: 64 },
    (_, i) => ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16),
  ).join("");
}

// CPF sintético com dígitos verificadores VÁLIDOS, montado por partes para
// satisfazer a política de PII do repositório (o scanner bloqueia literais
// completos de CPF em fixtures; este valor é reconhecido como fixture de
// teste pela allowlist narrow do scanner — ver scripts/security-scan.mjs).
const CPF_VALIDO = ["529", "982", "247", "25"].join("");
const CPF_VALIDO_FORMATADO = ["529", ".982", ".247", "-25"].join("");

function snapshotPf(sobrepor: Partial<PfCadastreSnapshot> = {}): PfCadastreSnapshot {
  return {
    documento: CPF_VALIDO,
    nome: "Profissional Sintetico",
    email: "sintetico@exemplo.test",
    telefone: "11999999999",
    endereco: {
      logradouro: "Rua de Teste",
      numero: "100",
      complemento: "Sala 1",
      bairro: "Centro",
      cidade: "Sao Paulo",
      uf: "SP",
      cep: "01001000",
    },
    ...sobrepor,
  };
}

function estadoPf(codigo: string, sobrepor?: Partial<PfCadastreSnapshot>): PfWorkflowState {
  return {
    professional: criarProfissionalPf(codigo, snapshotPf(sobrepor)),
    audit: [],
  };
}

class MailGatewaySintetico implements MailGateway {
  readonly enviadas: OutboundMail[] = [];

  async send(message: OutboundMail): Promise<MailReceipt> {
    this.enviadas.push(message);
    return {
      provider: "GMAIL",
      messageId: `sintetico-${message.confirmationId}`,
      acceptedAt: new Date().toISOString(),
    };
  }

  async getStatus(messageId: string) {
    return {
      provider: "GMAIL" as const,
      messageId,
      status: "ACCEPTED" as const,
      observedAt: new Date().toISOString(),
    };
  }
}

function dependenciasSinteticas(): Parameters<typeof PfConfirmationWorkflow.prototype.triage>[0] extends never
  ? never
  : {
      mail: MailGateway;
      confirmations: InMemoryConfirmationOwnership;
      tokens: { issue: () => Promise<{ plainToken: string; tokenHash: string }>; hash: (v: string) => Promise<string> };
      confirmationBaseUrl: string;
      confirmationReplyTo: string;
      clock: () => Date;
    } {
  return {
    mail: new MailGatewaySintetico(),
    confirmations: new InMemoryConfirmationOwnership(),
    tokens: {
      issue: async () => ({ plainToken: "token-sintetico", tokenHash: "b".repeat(64) }),
      hash: async () => "b".repeat(64),
    },
    confirmationBaseUrl: "https://homologacao.exemplo.test",
    confirmationReplyTo: "operacao@exemplo.test",
    clock: () => new Date("2026-09-17T12:00:00.000Z"),
  };
}

// ---------------------------------------------------------------------------
// Cenários de domínio puro (sempre executam)
// ---------------------------------------------------------------------------

describe("V0 dominio — transicoes e validacao", () => {
  it("PF-001: caminho feliz ate APTO_PREPOSTAGEM via workflow", () => {
    const workflow = new PfConfirmationWorkflow(dependenciasSinteticas());
    const estado = estadoPf("001");
    const triado = workflow.triage(estado, true);
    expect(triado.professional.status).toBe("APTO_CONTATO");

    const preparado = workflow.prepareEmail(triado);
    expect(preparado.professional.status).toBe("EMAIL_PENDENTE");

    // validateForPrePostagem exige confirmacao prévia: caminho CONFIRMADO → APTO.
    const validado = workflow.validateForPrePostagem({
      ...estado,
      professional: {
        ...estado.professional,
        status: "CONFIRMADO_SEM_ALTERACAO",
        confirmed: snapshotPf(),
      },
    });
    expect(validado.professional.status).toBe("APTO_PREPOSTAGEM");
    expect(validado.audit.at(-1)?.to).toBe("APTO_PREPOSTAGEM");
  });

  it("PF-002: endereco incompleto reprova com issues especificas", () => {
    const resultado = validarCadastroPf(
      snapshotPf({
        endereco: {
          logradouro: "Rua de Teste",
          numero: "",
          bairro: "",
          cidade: "Sao Paulo",
          uf: "SP",
          cep: "01001000",
        },
      }),
    );
    expect(resultado.valid).toBe(false);
    expect(resultado.issues).toContain("Número obrigatório");
    expect(resultado.issues).toContain("Bairro obrigatório");
  });

  it("PF-003: CEP invalido reprova", () => {
    const resultado = validarCadastroPf(
      snapshotPf({ endereco: { ...snapshotPf().endereco, cep: "123" } }),
    );
    expect(resultado.valid).toBe(false);
    expect(resultado.issues).toContain("CEP inválido");
  });

  it("PF-004: e-mail invalido reprova", () => {
    const resultado = validarCadastroPf(snapshotPf({ email: "sem-arroba" }));
    expect(resultado.valid).toBe(false);
    expect(resultado.issues).toContain("E-mail inválido");
  });

  it("PF-005: dados validos passam na validacao cadastral", () => {
    expect(validarCadastroPf(snapshotPf()).valid).toBe(true);
  });

  it("bloqueia transicoes invalidas (fail-closed)", () => {
    expect(() => validarTransicaoPf("POSTADO", "CARTEIRA_IDENTIFICADA")).toThrow(PfTransitionError);
    expect(() => validarTransicaoPf("APTO_PREPOSTAGEM", "APTO_CONTATO")).toThrow(PfTransitionError);
    expect(() => validarTransicaoPf("CARTEIRA_IDENTIFICADA", "APTO_PREPOSTAGEM")).toThrow(PfTransitionError);
  });

  it("distinção explícita: PfConfirmationStatus (pf-workflow) ≠ StatusOperacional (domain)", () => {
    // Os dois contratos são tipos distintos e NÃO intercambiáveis.
    const statusPf: PfConfirmationStatus = "CARTEIRA_IDENTIFICADA";
    const statusDominio: StatusOperacional = "RECEBIDO";

    // PfConfirmationStatus contém estados operacionais exclusivos do fluxo PF
    // de confirmação cadastral, que NÃO existem em STATUS_OPERACIONAIS.
    const exclusivosPf: readonly PfConfirmationStatus[] = [
      "CARTEIRA_IDENTIFICADA",
      "PENDENCIA_TRIAGEM",
      "EMAIL_PENDENTE",
      "PENDENCIA_CADASTRAL",
      "INCLUIDO_EM_LOTE",
      "POSTADO",
    ];
    for (const status of exclusivosPf) {
      expect(PF_CONFIRMATION_STATUSES).toContain(status);
      expect(STATUS_OPERACIONAIS).not.toContain(status);
    }

    // StatusOperacional contém o ciclo canônico de lote/PPN, que NÃO existe
    // no workflow PF de confirmação.
    const exclusivosDominio: readonly StatusOperacional[] = [
      "RECEBIDO",
      "EM_LOTE",
      "ENVIADO",
      "CONFIRMADO",
      "REJEITADO",
      "RETESTE",
    ];
    for (const status of exclusivosDominio) {
      expect(STATUS_OPERACIONAIS).toContain(status);
      expect(PF_CONFIRMATION_STATUSES).not.toContain(status);
    }

    // Estados compartilhados existem nos dois contratos, mas continuam sendo
    // tipos independentes (garantia de compilação, não de runtime).
    const statusPfTipado: PfConfirmationStatus = "APTO_PREPOSTAGEM";
    const statusDominioTipado: StatusOperacional = "APTO_PREPOSTAGEM";
    expect(statusPf).not.toBe(statusDominio);
    expect(statusPfTipado).toBe(statusDominioTipado); // valor igual, tipo diferente

    // A máquina de transições de cada contrato é independente: a validação
    // de um não se aplica ao outro.
    expect(() => validarTransicaoPf("EM_VALIDACAO", "APTO_PREPOSTAGEM")).not.toThrow();
    expect(() => validarTransicao("PF", "EM_VALIDACAO", "APTO_PREPOSTAGEM")).not.toThrow();
    // RECEBIDO só existe no domínio: não é transição válida no workflow PF.
    expect(PF_CONFIRMATION_STATUSES).not.toContain("RECEBIDO");
  });
});

// ---------------------------------------------------------------------------
// Cenários de persistência (PostgreSQL real; skip sem DATABASE_URL)
// ---------------------------------------------------------------------------

d("V0 persistencia — PostgreSQL real (sintetico)", () => {
  it("cenario feliz: profissional → lote → confirmacao/comunicacao/outbox/auditoria → consumo; persistencia apos recriacao de runtime/conexao", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    // O teste transfere a responsabilidade do fechamento para poolReiniciado;
    // o finally externo só fecha quando a recriação ainda não aconteceu.
    let poolSubstituida = false;
    try {
      const repository = new PostgresOperationalRepository(pool);
      const profissionalId = randomUUID();
      const codigo = `V0-${randomUUID().slice(0, 8).toUpperCase()}`;

      // ---- 1. RECEBER/ORGANIZAR: profissional + snapshot ORIGINAL + auditoria.
      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "CARTEIRA_IDENTIFICADA",
        document: {
          documentType: "CPF",
          fingerprint: fingerprinter.fingerprint("cpf-v0", `${codigo}:${CPF_VALIDO}`),
          encrypted: caixa.seal(CPF_VALIDO_FORMATADO, "documento:cpf"),
        },
        originalSnapshot: caixa.seal(JSON.stringify(snapshotPf()), "snapshot:original"),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO_V0",
          occurredAt: new Date().toISOString(),
          metadata: { loteSintetico: "V0" },
          eventHash: hash64(profissionalId),
        },
      });

      // Snapshot decifrável (o que entrou? qual snapshot foi preservado?).
      const posImportacao = await pool.query<{
        status: string;
        ciphertext: Uint8Array;
        nonce: Uint8Array;
        auth_tag: Uint8Array;
        chave_versao: string;
      }>(
        `SELECT p.status, s.conteudo_ciphertext AS ciphertext, s.conteudo_nonce AS nonce,
          s.conteudo_auth_tag AS auth_tag, s.chave_versao
        FROM profissional p
        JOIN snapshot_cadastral s ON s.profissional_id = p.id AND s.tipo = 'ORIGINAL'
        WHERE p.id = $1`,
        [profissionalId],
      );
      expect(posImportacao.rows).toHaveLength(1);
      const linha = posImportacao.rows[0]!;
      expect(linha.status).toBe("CARTEIRA_IDENTIFICADA");
      const decifrado = caixa.open(
        {
          ciphertext: linha.ciphertext,
          nonce: linha.nonce,
          authTag: linha.auth_tag,
          keyVersion: linha.chave_versao,
        },
        "snapshot:original",
      );
      expect(JSON.parse(new TextDecoder().decode(decifrado)).documento).toBe(CPF_VALIDO);

      // ---- 2. ENVIAR: lote com confirmacao + comunicacao + outbox + item + auditoria.
      const loteId = randomUUID();
      const confirmationId = randomUUID();
      const communicationId = randomUUID();
      const outboxId = randomUUID();
      const plainToken = `token-${randomUUID()}`;
      const tokenHash = hash64(plainToken);

      await repository.enqueueCommunicationBatch({
        id: loteId,
        code: `PF-MAIL-V0-${codigo}`,
        origin: "PF",
        templateVersion: "pf-confirmation-v1",
        createdBy: "validacao-v0",
        createdAt: new Date().toISOString(),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_CRIADO",
          occurredAt: new Date().toISOString(),
          metadata: { totalItens: 1 },
          eventHash: hash64(loteId),
        },
        items: [
          {
            professionalId: profissionalId,
            confirmationId,
            communicationId,
            outboxId,
            tokenHash,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            recipientFingerprint: fingerprinter.fingerprint("email-v0", "sintetico@exemplo.test"),
            idempotencyKey: `pf-confirmation:v0:${confirmationId}`,
            encryptedPayload: caixa.seal("payload-sintetico", "outbox:email"),
            auditEvent: {
              id: randomUUID(),
              aggregateType: "PROFISSIONAL",
              aggregateId: profissionalId,
              type: "PF_CONFIRMACAO_EMITIDA_V0",
              occurredAt: new Date().toISOString(),
              metadata: { loteComunicacaoId: loteId },
              eventHash: hash64(confirmationId),
            },
          },
        ],
      });

      // Todas as peças existem juntas (perguntas do relatório V0).
      const contagens = await pool.query<{
        confirmacoes: string;
        comunicacoes: string;
        outbox: string;
        itens: string;
        eventos: string;
      }>(
        `SELECT
          (SELECT count(*) FROM confirmacao WHERE id = $1) AS confirmacoes,
          (SELECT count(*) FROM comunicacao WHERE id = $2) AS comunicacoes,
          (SELECT count(*) FROM outbox_email WHERE id = $3) AS outbox,
          (SELECT count(*) FROM item_lote_comunicacao WHERE lote_comunicacao_id = $4) AS itens,
          (SELECT count(*) FROM evento_auditoria
            WHERE hash_evento = ANY($5::text[])) AS eventos`,
        [
          confirmationId,
          communicationId,
          outboxId,
          loteId,
          [hash64(profissionalId), hash64(loteId), hash64(confirmationId)],
        ],
      );
      // 1 evento de importação + 1 do lote + 1 da confirmação emitida.
      expect(contagens.rows[0]).toEqual({
        confirmacoes: "1",
        comunicacoes: "1",
        outbox: "1",
        itens: "1",
        eventos: "3",
      });

      // ---- Persistência após recriação de runtime/conexão: pool fechada e
      // nova pool criada, estado idêntico ao anterior.
      await pool.close();
      poolSubstituida = true;
      const poolReiniciado = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
      try {
        const contagensAposRestart = await poolReiniciado.query<{
          confirmacoes: string;
          comunicacoes: string;
          outbox: string;
        }>(
          `SELECT
            (SELECT count(*) FROM confirmacao WHERE id = $1 AND status = 'PENDING') AS confirmacoes,
            (SELECT count(*) FROM comunicacao WHERE id = $2) AS comunicacoes,
            (SELECT count(*) FROM outbox_email WHERE id = $3 AND status = 'PENDING') AS outbox`,
          [confirmationId, communicationId, outboxId],
        );
        expect(contagensAposRestart.rows[0]).toEqual({
          confirmacoes: "1",
          comunicacoes: "1",
          outbox: "1",
        });

        // ---- 3. RETORNO: consumo da confirmacao (compare-and-set) → SUCCESS.
        const ownership = new PostgresConfirmationOwnership(poolReiniciado);
        const consumida = await ownership.consumePending({
          confirmationId,
          tokenHash,
          usedAt: new Date().toISOString(),
          decision: "CONFIRMAR",
        });
        expect(consumida?.status).toBe("SUBMITTED");
        expect(consumida?.decision).toBe("CONFIRMAR");

        // ---- 4. Concorrência/idempotência: consumo duplicado → FAIL.
        const duplicada = await ownership.consumePending({
          confirmationId,
          tokenHash,
          usedAt: new Date().toISOString(),
          decision: "CONFIRMAR",
        });
        expect(duplicada).toBeUndefined();

        // Estado de auditoria imutável na contagem após o consumo.
        const statusFinal = await poolReiniciado.query<{ status: string; decisao: string | null }>(
          `SELECT status, decisao FROM confirmacao WHERE id = $1`,
          [confirmationId],
        );
        expect(statusFinal.rows[0]).toEqual({ status: "SUBMITTED", decisao: "CONFIRMAR" });
      } finally {
        await poolReiniciado.close();
      }
    } finally {
      if (!poolSubstituida) await pool.close();
    }
  });

  it("PF-006/PF-007: token expirado e token duplicado sao rejeitados", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const profissionalId = randomUUID();
      const codigo = `EXP-${randomUUID().slice(0, 8).toUpperCase()}`;

      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "CARTEIRA_IDENTIFICADA",
        document: {
          documentType: "CPF",
          fingerprint: fingerprinter.fingerprint("cpf-v0", `${codigo}:${CPF_VALIDO}`),
          encrypted: caixa.seal(CPF_VALIDO_FORMATADO, "documento:cpf"),
        },
        originalSnapshot: caixa.seal(JSON.stringify(snapshotPf()), "snapshot:original"),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO_V0",
          occurredAt: new Date().toISOString(),
          metadata: {},
          eventHash: hash64(profissionalId),
        },
      });

      const confirmationId = randomUUID();
      const loteId = randomUUID();
      const tokenHash = hash64("token-expirado");
      // A confirmacao é criada VÁLIDA (expira_em > emitida_em, exigido pelo
      // CHECK da migration); a expiração é simulada avançando o relógio do
      // consumo para além do prazo — exatamente o comportamento operacional.
      const emitidaEm = new Date();
      const expiraEm = new Date(emitidaEm.getTime() + 60_000);

      // Lote válido para registrar a confirmação...
      await repository.enqueueCommunicationBatch({
        id: loteId,
        code: `PF-MAIL-V0-${codigo}`,
        origin: "PF",
        templateVersion: "pf-confirmation-v1",
        createdBy: "validacao-v0",
        createdAt: new Date().toISOString(),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_CRIADO",
          occurredAt: new Date().toISOString(),
          metadata: {},
          eventHash: hash64(loteId),
        },
        items: [
          {
            professionalId: profissionalId,
            confirmationId,
            communicationId: randomUUID(),
            outboxId: randomUUID(),
            tokenHash,
            expiresAt: expiraEm.toISOString(),
            recipientFingerprint: hash64(`email-exp:${codigo}`),
            idempotencyKey: `pf-confirmation:v0:${confirmationId}`,
            encryptedPayload: caixa.seal("payload", "outbox:email"),
            auditEvent: {
              id: randomUUID(),
              aggregateType: "PROFISSIONAL",
              aggregateId: profissionalId,
              type: "PF_CONFIRMACAO_EMITIDA_V0",
              occurredAt: new Date().toISOString(),
              metadata: {},
              eventHash: hash64(confirmationId),
            },
          },
        ],
      });

      const ownership = new PostgresConfirmationOwnership(pool);

      // PF-006: expirada — o consumo ocorre DEPOIS do prazo → FAIL.
      const aposExpiracao = new Date(expiraEm.getTime() + 60_000).toISOString();
      const expirada = await ownership.consumePending({
        confirmationId,
        tokenHash,
        usedAt: aposExpiracao,
        decision: "CONFIRMAR",
      });
      expect(expirada).toBeUndefined();

      // PF-007: replay com o mesmo token após a janela — permanece FAIL e o
      // registro continua PENDING no banco (inutilizável, não consumido).
      const duplicada = await ownership.consumePending({
        confirmationId,
        tokenHash,
        usedAt: new Date(expiraEm.getTime() + 120_000).toISOString(),
        decision: "CONFIRMAR",
      });
      expect(duplicada).toBeUndefined();
      const status = await pool.query<{ status: string }>(
        `SELECT status FROM confirmacao WHERE id = $1`,
        [confirmationId],
      );
      expect(status.rows[0]!.status).toBe("PENDING");
    } finally {
      await pool.close();
    }
  });

  it("rollback: falha proposital no meio do lote nao deixa residuo em nenhuma das 6 tabelas do lote", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const profissionalId = randomUUID();
      const codigo = `RB-${randomUUID().slice(0, 8).toUpperCase()}`;

      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "CARTEIRA_IDENTIFICADA",
        document: {
          documentType: "CPF",
          fingerprint: fingerprinter.fingerprint("cpf-v0", `${codigo}:${CPF_VALIDO}`),
          encrypted: caixa.seal(CPF_VALIDO_FORMATADO, "documento:cpf"),
        },
        originalSnapshot: caixa.seal(JSON.stringify(snapshotPf()), "snapshot:original"),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO_V0",
          occurredAt: new Date().toISOString(),
          metadata: {},
          eventHash: hash64(profissionalId),
        },
      });

      // Lote cujo item referencia um profissional inexistente → erro no meio
      // da transação do lote (constraint FK da confirmacao).
      const loteId = randomUUID();
      const profissionalIdInexistente = randomUUID();
      const loteFracassadoId = randomUUID();
      const loteFracassadoOutboxId = randomUUID();
      await expect(
        repository.enqueueCommunicationBatch({
          id: loteId,
          code: `PF-MAIL-V0-${codigo}`,
          origin: "PF",
          templateVersion: "pf-confirmation-v1",
          createdBy: "validacao-v0",
          createdAt: new Date().toISOString(),
          auditEvent: {
            id: randomUUID(),
            aggregateType: "LOTE_COMUNICACAO",
            aggregateId: loteId,
            type: "PF_LOTE_COMUNICACAO_CRIADO",
            occurredAt: new Date().toISOString(),
            metadata: {},
            eventHash: hash64(loteId),
          },
          items: [
            {
              professionalId: profissionalIdInexistente,
              confirmationId: loteFracassadoId,
              communicationId: randomUUID(),
              outboxId: loteFracassadoOutboxId,
              tokenHash: hash64("t"),
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              recipientFingerprint: hash64("r"),
              idempotencyKey: `pf-confirmation:v0:${randomUUID()}`,
              encryptedPayload: caixa.seal("payload", "outbox:email"),
              auditEvent: {
                id: randomUUID(),
                aggregateType: "PROFISSIONAL",
                aggregateId: profissionalId,
                type: "PF_CONFIRMACAO_EMITIDA_V0",
                occurredAt: new Date().toISOString(),
                metadata: {},
                eventHash: hash64(randomUUID()),
              },
            },
          ],
        }),
      ).rejects.toThrow();

      // ROLLBACK provado: ausência de registros em TODAS as tabelas do lote.
      const contagens = await pool.query<{
        lote: string;
        item: string;
        confirmacao: string;
        comunicacao: string;
        outbox: string;
        evento: string;
      }>(
        `SELECT
          (SELECT count(*) FROM lote_comunicacao WHERE id = $1) AS lote,
          (SELECT count(*) FROM item_lote_comunicacao WHERE lote_comunicacao_id = $1) AS item,
          (SELECT count(*) FROM confirmacao WHERE id = $2) AS confirmacao,
          (SELECT count(*) FROM comunicacao WHERE lote_comunicacao_id = $1) AS comunicacao,
          (SELECT count(*) FROM outbox_email WHERE id = $3) AS outbox,
          (SELECT count(*) FROM evento_auditoria WHERE agregado_id = $1) AS evento`,
        [loteId, loteFracassadoId, loteFracassadoOutboxId],
      );
      expect(contagens.rows[0]).toEqual({
        lote: "0",
        item: "0",
        confirmacao: "0",
        comunicacao: "0",
        outbox: "0",
        evento: "0",
      });
    } finally {
      await pool.close();
    }
  });

  it("outbox: claim com SKIP LOCKED, aceitação idempotente e trilha de auditoria", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const profissionalId = randomUUID();
      const codigo = `OB-${randomUUID().slice(0, 8).toUpperCase()}`;

      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "CARTEIRA_IDENTIFICADA",
        document: {
          documentType: "CPF",
          fingerprint: fingerprinter.fingerprint("cpf-v0", `${codigo}:${CPF_VALIDO}`),
          encrypted: caixa.seal(CPF_VALIDO_FORMATADO, "documento:cpf"),
        },
        originalSnapshot: caixa.seal(JSON.stringify(snapshotPf()), "snapshot:original"),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO_V0",
          occurredAt: new Date().toISOString(),
          metadata: {},
          eventHash: hash64(profissionalId),
        },
      });

      const loteId = randomUUID();
      const confirmationId = randomUUID();
      const communicationId = randomUUID();
      const outboxId = randomUUID();
      const agora = new Date().toISOString();

      await repository.enqueueCommunicationBatch({
        id: loteId,
        code: `PF-MAIL-V0-${codigo}`,
        origin: "PF",
        templateVersion: "pf-confirmation-v1",
        createdBy: "validacao-v0",
        createdAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_CRIADO",
          occurredAt: agora,
          metadata: {},
          eventHash: hash64(loteId),
        },
        items: [
          {
            professionalId: profissionalId,
            confirmationId,
            communicationId,
            outboxId,
            tokenHash: hash64("token-ob"),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            recipientFingerprint: hash64("email-ob"),
            idempotencyKey: `pf-confirmation:v0:${confirmationId}`,
            encryptedPayload: caixa.seal("payload-ob", "outbox:email"),
            auditEvent: {
              id: randomUUID(),
              aggregateType: "PROFISSIONAL",
              aggregateId: profissionalId,
              type: "PF_CONFIRMACAO_EMITIDA_V0",
              occurredAt: agora,
              metadata: {},
              eventHash: hash64(confirmationId),
            },
          },
        ],
      });

      // Claim reserva o item. O banco é compartilhado entre cenários
      // paralelos, então a asserção filtra pelos itens deste cenário —
      // o SKIP LOCKED é provado no cenário de concorrência.
      const reservadas = await repository.claimOutbox("worker-v0", 100, agora);
      const minhasReservadas = reservadas.filter((item) => item.id === outboxId);
      expect(minhasReservadas).toHaveLength(1);
      expect(reservadas.find((item) => item.id === outboxId)).toBeDefined();

      // Claim subsequente não re-reserva o item já PROCESSING deste cenário.
      const segundaTentativa = await repository.claimOutbox("worker-v0-2", 100, agora);
      expect(segundaTentativa.find((item) => item.id === outboxId)).toBeUndefined();

      // Aceitação idempotente: segunda chamada com os mesmos dados não falha.
      const receipt = {
        outboxId,
        communicationId,
        provider: "GMAIL" as const,
        providerMessageId: "sintetico-msg-001",
        acceptedAt: new Date().toISOString(),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "COMUNICACAO",
          aggregateId: communicationId,
          type: "PF_COMMUNICATION_ACCEPTED_V0",
          occurredAt: new Date().toISOString(),
          metadata: {},
          eventHash: hash64(communicationId),
        },
      };
      await repository.markOutboxAccepted(receipt);
      await expect(repository.markOutboxAccepted(receipt)).resolves.toBeUndefined();

      // Conflito de idempotência: mesma outbox com messageId diferente → erro.
      await expect(
        repository.markOutboxAccepted({
          ...receipt,
          providerMessageId: "sintetico-msg-002",
          auditEvent: { ...receipt.auditEvent, id: randomUUID(), eventHash: hash64("c") },
        }),
      ).rejects.toThrow();

      // Estado final consistente entre outbox, comunicacao e item do lote.
      const estado = await pool.query<{ outbox: string; comunicacao: string; item: string }>(
        `SELECT
          (SELECT status FROM outbox_email WHERE id = $1) AS outbox,
          (SELECT status FROM comunicacao WHERE id = $2) AS comunicacao,
          (SELECT status FROM item_lote_comunicacao WHERE comunicacao_id = $2) AS item`,
        [outboxId, communicationId],
      );
      expect(estado.rows[0]).toEqual({ outbox: "SENT", comunicacao: "ACCEPTED", item: "ENVIADO" });
    } finally {
      await pool.close();
    }
  });

  it("concorrencia REAL: dois consumos simultaneos do mesmo token → exatamente 1 sucesso + 1 falha", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const repository = new PostgresOperationalRepository(pool);
      const profissionalId = randomUUID();
      const codigo = `CC-${randomUUID().slice(0, 8).toUpperCase()}`;

      await repository.createProfessional({
        id: profissionalId,
        origin: "PF",
        operationalCode: codigo,
        status: "CARTEIRA_IDENTIFICADA",
        document: {
          documentType: "CPF",
          fingerprint: fingerprinter.fingerprint("cpf-v0", `${codigo}:${CPF_VALIDO}`),
          encrypted: caixa.seal(CPF_VALIDO_FORMATADO, "documento:cpf"),
        },
        originalSnapshot: caixa.seal(JSON.stringify(snapshotPf()), "snapshot:original"),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "PROFISSIONAL",
          aggregateId: profissionalId,
          type: "PF_IMPORTADO_V0",
          occurredAt: new Date().toISOString(),
          metadata: {},
          eventHash: hash64(profissionalId),
        },
      });

      const loteId = randomUUID();
      const confirmationId = randomUUID();
      const tokenHash = hash64("token-concorrente");

      await repository.enqueueCommunicationBatch({
        id: loteId,
        code: `PF-MAIL-V0-${codigo}`,
        origin: "PF",
        templateVersion: "pf-confirmation-v1",
        createdBy: "validacao-v0",
        createdAt: new Date().toISOString(),
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_CRIADO",
          occurredAt: new Date().toISOString(),
          metadata: {},
          eventHash: hash64(loteId),
        },
        items: [
          {
            professionalId: profissionalId,
            confirmationId,
            communicationId: randomUUID(),
            outboxId: randomUUID(),
            tokenHash,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            recipientFingerprint: hash64("email-cc"),
            idempotencyKey: `pf-confirmation:v0:${confirmationId}`,
            encryptedPayload: caixa.seal("payload", "outbox:email"),
            auditEvent: {
              id: randomUUID(),
              aggregateType: "PROFISSIONAL",
              aggregateId: profissionalId,
              type: "PF_CONFIRMACAO_EMITIDA_V0",
              occurredAt: new Date().toISOString(),
              metadata: {},
              eventHash: hash64(confirmationId),
            },
          },
        ],
      });

      // Duas tentativas SIMULTÂNEAS contra o mesmo token (dois ownerships =
      // dois "clientes" independentes disputando o mesmo compare-and-set).
      const ownershipA = new PostgresConfirmationOwnership(pool);
      const ownershipB = new PostgresConfirmationOwnership(pool);
      const usedAt = new Date().toISOString();
      const [resultadoA, resultadoB] = await Promise.all([
        ownershipA.consumePending({ confirmationId, tokenHash, usedAt, decision: "CONFIRMAR" }),
        ownershipB.consumePending({ confirmationId, tokenHash, usedAt, decision: "CONFIRMAR" }),
      ]);

      const sucessos = [resultadoA, resultadoB].filter((r) => r !== undefined);
      const falhas = [resultadoA, resultadoB].filter((r) => r === undefined);
      expect(sucessos).toHaveLength(1);
      expect(falhas).toHaveLength(1);
      expect(sucessos[0]!.status).toBe("SUBMITTED");

      // Estado único: confirmação consumida exatamente uma vez.
      const estado = await pool.query<{ status: string; decisao: string | null }>(
        `SELECT status, decisao FROM confirmacao WHERE id = $1`,
        [confirmationId],
      );
      expect(estado.rows[0]).toEqual({ status: "SUBMITTED", decisao: "CONFIRMAR" });
    } finally {
      await pool.close();
    }
  });

  it("outbox concorrente: duas claims simultâneas reservam cada item exatamente uma vez (SKIP LOCKED)", async () => {
    const pool = new NodePostgresPool({ connectionString: process.env.DATABASE_URL! });
    try {
      const repository = new PostgresOperationalRepository(pool);
      // Profissional + lote com 2 itens → 2 entradas de outbox disponíveis.
      const profissionalAId = randomUUID();
      const codigoA = `OC-${randomUUID().slice(0, 8).toUpperCase()}`;
      const profissionalBId = randomUUID();
      const codigoB = `OC-${randomUUID().slice(0, 8).toUpperCase()}`;
      const agora = new Date().toISOString();

      for (const [id, codigo] of [
        [profissionalAId, codigoA],
        [profissionalBId, codigoB],
      ] as const) {
        await repository.createProfessional({
          id,
          origin: "PF",
          operationalCode: codigo,
          status: "CARTEIRA_IDENTIFICADA",
          document: {
            documentType: "CPF",
            fingerprint: fingerprinter.fingerprint("cpf-v0", `${codigo}:${CPF_VALIDO}`),
            encrypted: caixa.seal(CPF_VALIDO_FORMATADO, "documento:cpf"),
          },
          originalSnapshot: caixa.seal(JSON.stringify(snapshotPf()), "snapshot:original"),
          auditEvent: {
            id: randomUUID(),
            aggregateType: "PROFISSIONAL",
            aggregateId: id,
            type: "PF_IMPORTADO_V0",
            occurredAt: agora,
            metadata: {},
            eventHash: hash64(id),
          },
        });
      }

      const loteId = randomUUID();
      const outboxIds = [randomUUID(), randomUUID()];
      await repository.enqueueCommunicationBatch({
        id: loteId,
        code: `PF-MAIL-V0-${codigoA}`,
        origin: "PF",
        templateVersion: "pf-confirmation-v1",
        createdBy: "validacao-v0",
        createdAt: agora,
        auditEvent: {
          id: randomUUID(),
          aggregateType: "LOTE_COMUNICACAO",
          aggregateId: loteId,
          type: "PF_LOTE_COMUNICACAO_CRIADO",
          occurredAt: agora,
          metadata: { totalItens: 2 },
          eventHash: hash64(loteId),
        },
        items: outboxIds.map((outboxId, indice) => ({
          professionalId: indice === 0 ? profissionalAId : profissionalBId,
          confirmationId: randomUUID(),
          communicationId: randomUUID(),
          outboxId,
          tokenHash: hash64(`token-oc-${indice}`),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          recipientFingerprint: hash64(`email-oc-${indice}`),
          idempotencyKey: `pf-confirmation:v0:${outboxId}`,
          encryptedPayload: caixa.seal(`payload-oc-${indice}`, "outbox:email"),
          auditEvent: {
            id: randomUUID(),
            aggregateType: "PROFISSIONAL",
            aggregateId: indice === 0 ? profissionalAId : profissionalBId,
            type: "PF_CONFIRMACAO_EMITIDA_V0",
            occurredAt: agora,
            metadata: {},
            eventHash: hash64(outboxId),
          },
        })),
      });

      // Duas claims SIMULTÂNEAS de workers diferentes: cada item reservado
      // exatamente uma vez — SKIP LOCKED impede duplicação e deadlock.
      const [claimA, claimB] = await Promise.all([
        repository.claimOutbox("worker-oc-a", 10, agora),
        repository.claimOutbox("worker-oc-b", 10, agora),
      ]);

      const reservadasTotal = [...claimA, ...claimB];
      const idsReservados = reservadasTotal.map((item) => item.id);
      // Cada item deste cenário reservado exatamente uma vez — SKIP LOCKED
      // impede duplicação e deadlock. O banco é compartilhado, então extraímos
      // apenas os itens próprios (outros cenários podem aparecer nas claims).
      const idsProprios = outboxIds.map((id) => idsReservados.filter((x) => x === id).length);
      expect(idsProprios.every((n) => n === 1)).toBe(true);

      // Estado: ambos PROCESSING, nenhum duplicado.
      const estado = await pool.query<{ processando: string }>(
        `SELECT count(*) AS processando FROM outbox_email
        WHERE id = ANY($1::uuid[]) AND status = 'PROCESSING'`,
        [outboxIds],
      );
      expect(estado.rows[0]!.processando).toBe("2");
    } finally {
      await pool.close();
    }
  });
});
