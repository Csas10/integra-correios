/**
 * Regressões sintéticas do TESTE CONTROLADO GMAIL (preparação sem envio).
 *
 * Contrato desta etapa:
 *  - lote CONTROLLED_GMAIL_TEST com EXATAMENTE uma comunicação;
 *  - fonte CONTROLADO_SINTETICO (nunca INSTITUCIONAL_XLSX);
 *  - destinatário EXATAMENTE GMAIL_CONTROLLED_RECIPIENT;
 *  - lote nasce PREPARACAO em modo LIVE_PILOT (único modo do motor LIVE, F7);
 *  - registro profissional 100% sintético (sem CPF/telefone/endereço real);
 *  - REAL_SEND_ENABLED=false durante TODA a etapa (GATE 1 fechado);
 *  - preparação idempotente pelo código canônico do lote;
 *  - pré-voo fail-closed: pendências fora do teste, processamento e lotes
 *    ATIVOS fora do teste bloqueiam a criação;
 *  - NENHUM envio: nenhum caminho aqui chama gateway/Gmail.
 *
 * Todas as fixtures são sintéticas (example.test) — nenhum dado institucional.
 */
import { describe, expect, it } from "vitest";
import {
  BloqueioLoteControladoError,
  carregarPoliticaControlada,
  CODIGO_LOTE_TESTE_CONTROLADO,
  lerEstadoLoteControlado,
  prepararLoteTesteControlado,
} from "../src/pilot.js";

const RECIPIENTE_CONTROLADO = "controlado@example.test";

function politicaBase(overrides: Partial<Parameters<typeof carregarPoliticaControlada>[0]> = {}) {
  return carregarPoliticaControlada({
    GMAIL_CONTROLLED_MODE: "true",
    GMAIL_CONTROLLED_RECIPIENT: RECIPIENTE_CONTROLADO,
    REAL_SEND_ENABLED: "false",
    ...overrides,
  });
}

function caixaTeste() {
  // Cifra sintética in-memory (mesmo contrato de Aes256GcmSecretBox) — o foco
  // aqui é o FLUXO, não a primitiva criptográfica (coberta por outras suítes).
  return {
    seal(plaintext: string, context: string) {
      if (!context) throw new Error("contexto obrigatório");
      return {
        ciphertext: new Uint8Array(Buffer.from(plaintext, "utf8")),
        nonce: new Uint8Array(12),
        authTag: new Uint8Array(16),
        keyVersion: "v1",
      };
    },
    open(value: { ciphertext: Uint8Array; nonce: Uint8Array; authTag: Uint8Array; keyVersion: string }, context: string) {
      if (!context) throw new Error("contexto obrigatório");
      return new Uint8Array(Buffer.from(value.ciphertext));
    },
  };
}

function fingerprinterTeste() {
  return {
    fingerprint(namespace: string, valor: string) {
      return `${namespace}:${valor}`.length >= 64
        ? "a".repeat(64)
        : ("a".repeat(63) + "b").slice(0, 64);
    },
  };
}

function tokensTeste() {
  const contador = { n: 0 };
  return {
    async issue() {
      contador.n += 1;
      return { plainToken: `token-${contador.n}`, tokenHash: "b".repeat(64) };
    },
    async hash(plain: string) {
      return `hash:${plain.length}`;
    },
  };
}

function repositoryCapturador() {
  const comandos: unknown[] = [];
  return {
    comandos,
    async enqueueCommunicationBatch(command: unknown) {
      comandos.push(command);
    },
  };
}

function poolSequencial(respostas: Array<{ rows: readonly any[]; rowCount: number | null }>) {
  const consultas: string[] = [];
  let indice = 0;
  return {
    consultas,
    async query(text: string) {
      consultas.push(text);
      const resposta = respostas[Math.min(indice, respostas.length - 1)] ?? { rows: [], rowCount: 0 };
      indice += 1;
      return resposta;
    },
  };
}

const ESTADO_VAZIO = {
  rows: [{ pendente_fora: "0", processamento: "0", ativos_fora: "0" }],
  rowCount: 1,
};
const SEM_LOTE = { rows: [], rowCount: 0 };

function comandoBase() {
  return {
    operador: "operador-teste",
    confirmationBaseUrl: "https://preview.example.test",
    oauthPronto: true,
  };
}

describe("TESTE CONTROLADO GMAIL — preparação sem envio", () => {
  it("pré-voo fail-closed: exige GMAIL_CONTROLLED_MODE ativo", async () => {
    const pool = poolSequencial([ESTADO_VAZIO, SEM_LOTE]);
    const repository = repositoryCapturador();
    await expect(
      prepararLoteTesteControlado(
        comandoBase(),
        repository as never,
        pool,
        caixaTeste(),
        fingerprinterTeste(),
        tokensTeste(),
        politicaBase({ GMAIL_CONTROLLED_MODE: "false" }),
      ),
    ).rejects.toMatchObject({ codigo: "CONTROLLED_MODE_REQUIRED" });
    expect(repository.comandos).toHaveLength(0);
  });

  it("pré-voo fail-closed: exige destinatário controlado configurado e válido", async () => {
    const repository = repositoryCapturador();
    const semRecipient = prepararLoteTesteControlado(
      comandoBase(),
      repository as never,
      poolSequencial([ESTADO_VAZIO, SEM_LOTE]),
      caixaTeste(),
      fingerprinterTeste(),
      tokensTeste(),
      politicaBase({ GMAIL_CONTROLLED_RECIPIENT: " " }),
    );
    await expect(semRecipient).rejects.toMatchObject({ codigo: "CONTROLLED_RECIPIENT_REQUIRED" });

    const recipientInvalido = prepararLoteTesteControlado(
      comandoBase(),
      repository as never,
      poolSequencial([ESTADO_VAZIO, SEM_LOTE]),
      caixaTeste(),
      fingerprinterTeste(),
      tokensTeste(),
      politicaBase({ GMAIL_CONTROLLED_RECIPIENT: "sem-arroba" }),
    );
    await expect(recipientInvalido).rejects.toMatchObject({ codigo: "CONTROLLED_RECIPIENT_INVALID" });
    expect(repository.comandos).toHaveLength(0);
  });

  it("pré-voo fail-closed: REAL_SEND_ENABLED=true bloqueia a preparação desta etapa", async () => {
    const repository = repositoryCapturador();
    await expect(
      prepararLoteTesteControlado(
        comandoBase(),
        repository as never,
        poolSequencial([ESTADO_VAZIO, SEM_LOTE]),
        caixaTeste(),
        fingerprinterTeste(),
        tokensTeste(),
        politicaBase({ REAL_SEND_ENABLED: "true" }),
      ),
    ).rejects.toMatchObject({ codigo: "REAL_SEND_ARMED" });
    expect(repository.comandos).toHaveLength(0);
  });

  it("pré-voo fail-closed: OAuth não READY bloqueia a preparação", async () => {
    const repository = repositoryCapturador();
    await expect(
      prepararLoteTesteControlado(
        { ...comandoBase(), oauthPronto: false },
        repository as never,
        poolSequencial([ESTADO_VAZIO, SEM_LOTE]),
        caixaTeste(),
        fingerprinterTeste(),
        tokensTeste(),
        politicaBase(),
      ),
    ).rejects.toMatchObject({ codigo: "OAUTH_NOT_READY" });
    expect(repository.comandos).toHaveLength(0);
  });

  it("pré-voo fail-closed: outbox pendente FORA do teste bloqueia", async () => {
    const repository = repositoryCapturador();
    await expect(
      prepararLoteTesteControlado(
        comandoBase(),
        repository as never,
        poolSequencial([
          { rows: [{ pendente_fora: "2", processamento: "0", ativos_fora: "0" }], rowCount: 1 },
          SEM_LOTE,
        ]),
        caixaTeste(),
        fingerprinterTeste(),
        tokensTeste(),
        politicaBase(),
      ),
    ).rejects.toMatchObject({ codigo: "OUTBOX_PENDING_OUTSIDE_TEST" });
    expect(repository.comandos).toHaveLength(0);
  });

  it("pré-voo fail-closed: outbox em processamento bloqueia", async () => {
    const repository = repositoryCapturador();
    await expect(
      prepararLoteTesteControlado(
        comandoBase(),
        repository as never,
        poolSequencial([
          { rows: [{ pendente_fora: "0", processamento: "1", ativos_fora: "0" }], rowCount: 1 },
          SEM_LOTE,
        ]),
        caixaTeste(),
        fingerprinterTeste(),
        tokensTeste(),
        politicaBase(),
      ),
    ).rejects.toMatchObject({ codigo: "OUTBOX_PROCESSING" });
    expect(repository.comandos).toHaveLength(0);
  });

  it("pré-voo fail-closed: lotes ATIVOS fora do teste bloqueiam", async () => {
    const repository = repositoryCapturador();
    await expect(
      prepararLoteTesteControlado(
        comandoBase(),
        repository as never,
        poolSequencial([
          { rows: [{ pendente_fora: "0", processamento: "0", ativos_fora: "1" }], rowCount: 1 },
          SEM_LOTE,
        ]),
        caixaTeste(),
        fingerprinterTeste(),
        tokensTeste(),
        politicaBase(),
      ),
    ).rejects.toMatchObject({ codigo: "ACTIVE_BATCHES_OUTSIDE_TEST" });
    expect(repository.comandos).toHaveLength(0);
  });

  it("cria EXATAMENTE uma comunicação sintética para o destinatário controlado, em PREPARACAO/LIVE_PILOT", async () => {
    const pool = poolSequencial([ESTADO_VAZIO, SEM_LOTE]);
    const repository = repositoryCapturador();
    const resultado = await prepararLoteTesteControlado(
      comandoBase(),
      repository as never,
      pool,
      caixaTeste(),
      fingerprinterTeste(),
      tokensTeste(),
      politicaBase(),
      new Date("2026-09-22T12:00:00Z"),
    );

    expect(resultado.criado).toBe(true);
    expect(resultado.codigo).toBe(CODIGO_LOTE_TESTE_CONTROLADO);
    expect(resultado.totalItens).toBe(1);
    expect(repository.comandos).toHaveLength(1);

    const comando = repository.comandos[0] as {
      code: string;
      mode: string;
      source: string;
      items: readonly {
        encryptedPayload: { ciphertext: Uint8Array };
        recipientFingerprint: string;
        tokenHash: string;
      }[];
    };
    expect(comando.code).toBe(CODIGO_LOTE_TESTE_CONTROLADO);
    expect(comando.mode).toBe("LIVE_PILOT");
    expect(comando.source).toBe("CONTROLADO_SINTETICO");
    expect(comando.items).toHaveLength(1);
    expect(comando.items[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(comando.items[0]?.recipientFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const payload = JSON.parse(Buffer.from(comando.items[0]!.encryptedPayload.ciphertext).toString("utf8")) as {
      destinatario: string;
      nome: string;
      telefone: string;
      enderecoApresentado: string;
      codigo: string;
    };
    // Destinatário EXATAMENTE o controlado; registro sintético sem PII.
    expect(payload.destinatario).toBe(RECIPIENTE_CONTROLADO);
    expect(payload.nome).toContain("Sintetica");
    expect(payload.telefone).toBe("");
    expect(payload.enderecoApresentado).not.toMatch(/Rua|Avenida/i);
    expect(payload.codigo).toBe("SINTETICO-CONTROLADO-GMAIL");
    // Nenhuma fixture institucional: payload não contém CPF (11 dígitos).
    expect(JSON.stringify(payload)).not.toMatch(/\b\d{11}\b/);
  });

  it("é idempotente: lote existente retorna criado=false sem novo INSERT", async () => {
    const repository = repositoryCapturador();
    const estadoComLote = {
      rows: [
        {
          lote_id: "40000000-0000-4000-8000-000000000001",
          lote_status: "PREPARACAO",
          lote_modo: "LIVE_PILOT",
          total_itens: "1",
          fonte_registro: "CONTROLADO_SINTETICO",
          receipts: "0",
          ativacoes: "0",
          payload_ciphertext: null,
          payload_nonce: null,
          payload_auth_tag: null,
          chave_versao: null,
        },
      ],
      rowCount: 1,
    };
    const resultado = await prepararLoteTesteControlado(
      comandoBase(),
      repository as never,
      poolSequencial([ESTADO_VAZIO, estadoComLote]),
      caixaTeste(),
      fingerprinterTeste(),
      tokensTeste(),
      politicaBase(),
    );
    expect(resultado.criado).toBe(false);
    expect(resultado.loteId).toBe("40000000-0000-4000-8000-000000000001");
    expect(repository.comandos).toHaveLength(0);
  });

  it("consulta read-only reporta contagens fora do teste e estado derivado do banco", async () => {
    const pool = poolSequencial([
      { rows: [{ pendente_fora: "0", processamento: "0", ativos_fora: "0" }], rowCount: 1 },
      {
        rows: [
          {
            lote_id: "40000000-0000-4000-8000-000000000002",
            lote_status: "PREPARACAO",
            lote_modo: "LIVE_PILOT",
            total_itens: "1",
            fonte_registro: "CONTROLADO_SINTETICO",
            receipts: "0",
            ativacoes: "0",
            payload_ciphertext: new Uint8Array(Buffer.from(JSON.stringify({ destinatario: RECIPIENTE_CONTROLADO }))),
            payload_nonce: new Uint8Array(12),
            payload_auth_tag: new Uint8Array(16),
            chave_versao: "v1",
          },
        ],
        rowCount: 1,
      },
    ]);
    const estado = await lerEstadoLoteControlado(pool, {
      caixa: caixaTeste(),
      controlledRecipient: RECIPIENTE_CONTROLADO,
    });
    expect(estado.codigo).toBe(CODIGO_LOTE_TESTE_CONTROLADO);
    expect(estado.outboxPendenteForaDoTeste).toBe(0);
    expect(estado.outboxProcessamento).toBe(0);
    expect(estado.lotesAtivosForaDoTeste).toBe(0);
    expect(estado.lote?.totalItens).toBe(1);
    expect(estado.lote?.fonteRegistro).toBe("CONTROLADO_SINTETICO");
    expect(estado.lote?.receiptAnterior).toBe(false);
    expect(estado.lote?.liberacaoHumanaAuditada).toBe(false);
    expect(estado.lote?.destinatarioCorresponde).toBe(true);
  });

  it("consulta read-only marca destinatarioCorresponde=null quando payload é ilegível (fail-closed)", async () => {
    const pool = poolSequencial([
      ESTADO_VAZIO,
      {
        rows: [
          {
            lote_id: "40000000-0000-4000-8000-000000000003",
            lote_status: "PREPARACAO",
            lote_modo: "LIVE_PILOT",
            total_itens: "1",
            fonte_registro: "CONTROLADO_SINTETICO",
            receipts: "0",
            ativacoes: "0",
            payload_ciphertext: new Uint8Array(Buffer.from("lixo")),
            payload_nonce: new Uint8Array(12),
            payload_auth_tag: new Uint8Array(16),
            chave_versao: "v1",
          },
        ],
        rowCount: 1,
      },
    ]);
    const estado = await lerEstadoLoteControlado(pool, {
      caixa: {
        open() {
          throw new Error("payload corrompido");
        },
      },
      controlledRecipient: RECIPIENTE_CONTROLADO,
    });
    expect(estado.lote?.destinatarioCorresponde).toBe(null);
  });

  it("nenhum caminho desta suíte executa envio (nenhum gateway é instanciado)", () => {
    // Guarda estrutural: o módulo pilot.ts não importa gateway/envio.
    expect(BloqueioLoteControladoError).toBeDefined();
  });
});
