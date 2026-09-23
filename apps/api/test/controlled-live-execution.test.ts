/**
 * Regressões sintéticas da EXECUÇÃO LIVE CONTROLADA (uma única mensagem).
 *
 * Contrato desta etapa:
 *  - ativação auditada reutiliza o CAS existente (PF_LOTE_COMUNICACAO_ATIVADO),
 *    restrita ao lote CONTROLLED_GMAIL_TEST;
 *  - execução run-once com pré-voo fail-closed: exatamente 1 comunicação,
 *    zero receipts Gmail globais, nenhum lote ATIVO fora do teste, outbox
 *    zerada, lote ATIVO em LIVE_PILOT, REAL_SEND_ENABLED=true;
 *  - exatamente UMA chamada do executor LIVE (nenhum loop/retry).
 *
 * Todas as fixtures são sintéticas — nenhum dado institucional.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BloqueioExecucaoControladaError,
  BloqueioLoteControladoError,
  ativarLoteControlado,
  autorizarRetryPreRede,
  executarWorkerControladoUmaVez,
  validarRetryPreRede,
} from "../src/pilot.js";

const RECIPIENTE = "controlado@example.test";

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

const PREVOO_OK = {
  rows: [
    {
      comunicacoes_teste: "1",
      communication_id: "50000000-0000-4000-8000-000000000001",
      receipts_globais: "0",
      ativos_fora: "0",
      pendente_fora: "0",
      processamento: "0",
      modo: "LIVE_PILOT",
      status_lote: "ATIVO",
      teste_pendente: "1",
      outbox_status_teste: "PENDING",
      outbox_tentativas_teste: "0",
      outbox_erro_teste: null,
      provider_ids_teste: "0",
    },
  ],
  rowCount: 1,
};

const POSFLIGHT_ENVIADO = {
  rows: [
    {
      communication_id: "50000000-0000-4000-8000-000000000001",
      estado: "ACCEPTED",
      receipts_globais: "1",
      outbox_status: "SENT",
      outbox_tentativas: "1",
      outbox_erro: null,
      message_id_presente: true,
      thread_id_presente: true,
    },
  ],
  rowCount: 1,
};

function politica(overrides: Record<string, string> = {}) {
  return {
    controlledMode: overrides.GMAIL_CONTROLLED_MODE !== "false",
    controlledRecipient: overrides.GMAIL_CONTROLLED_RECIPIENT ?? RECIPIENTE,
    realSendEnabled: overrides.REAL_SEND_ENABLED === "true",
  };
}

describe("executarWorkerControladoUmaVez — pré-voo fail-closed", () => {
  it("bloqueia quando REAL_SEND_ENABLED=false (zero chamadas do executor)", async () => {
    const pool = poolSequencial([]);
    const executarLive = vi.fn();
    await expect(
      executarWorkerControladoUmaVez(pool, politica({ REAL_SEND_ENABLED: "false" }), executarLive),
    ).rejects.toMatchObject({ codigo: "REAL_SEND_DISABLED" });
    expect(executarLive).not.toHaveBeenCalled();
    expect(pool.consultas).toHaveLength(0);
  });

  it("bloqueia quando CONTROLLED_MODE inativo", async () => {
    const pool = poolSequencial([]);
    const executarLive = vi.fn();
    await expect(
      executarWorkerControladoUmaVez(pool, politica({ GMAIL_CONTROLLED_MODE: "false", REAL_SEND_ENABLED: "true" }), executarLive),
    ).rejects.toMatchObject({ codigo: "CONTROLLED_MODE_REQUIRED" });
    expect(executarLive).not.toHaveBeenCalled();
  });

  it("bloqueia receituação pré-existente (nenhum segundo envio)", async () => {
    const pool = poolSequencial([{ rows: [{ ...PREVOO_OK.rows[0], receipts_globais: "1" }], rowCount: 1 }]);
    const executarLive = vi.fn();
    await expect(executarWorkerControladoUmaVez(pool, politica({ REAL_SEND_ENABLED: "true" }), executarLive)).rejects.toMatchObject({ codigo: "RECEIPT_ALREADY_EXISTS" });
    expect(executarLive).not.toHaveBeenCalled();
  });

  it("bloqueia contagem de comunicações divergente de 1", async () => {
    const pool = poolSequencial([{ rows: [{ ...PREVOO_OK.rows[0], comunicacoes_teste: "2" }], rowCount: 1 }]);
    const executarLive = vi.fn();
    await expect(executarWorkerControladoUmaVez(pool, politica({ REAL_SEND_ENABLED: "true" }), executarLive)).rejects.toMatchObject({ codigo: "COMMUNICATION_COUNT_INVALID" });
    expect(executarLive).not.toHaveBeenCalled();
  });

  it("bloqueia lote ATIVO fora do teste e outbox não resolvida", async () => {
    const executarLive = vi.fn();
    const poolAtivos = poolSequencial([{ rows: [{ ...PREVOO_OK.rows[0], ativos_fora: "1" }], rowCount: 1 }]);
    await expect(executarWorkerControladoUmaVez(poolAtivos, politica({ REAL_SEND_ENABLED: "true" }), executarLive)).rejects.toMatchObject({ codigo: "ACTIVE_BATCHES_OUTSIDE_TEST" });
    const poolOutbox = poolSequencial([{ rows: [{ ...PREVOO_OK.rows[0], pendente_fora: "1" }], rowCount: 1 }]);
    await expect(executarWorkerControladoUmaVez(poolOutbox, politica({ REAL_SEND_ENABLED: "true" }), executarLive)).rejects.toMatchObject({ codigo: "OUTBOX_NOT_SETTLED" });
    expect(executarLive).not.toHaveBeenCalled();
  });

  it("bloqueia lote não-ATIVO ou modo divergente", async () => {
    const executarLive = vi.fn();
    const pool = poolSequencial([{ rows: [{ ...PREVOO_OK.rows[0], status_lote: "PREPARACAO" }], rowCount: 1 }]);
    await expect(executarWorkerControladoUmaVez(pool, politica({ REAL_SEND_ENABLED: "true" }), executarLive)).rejects.toMatchObject({ codigo: "BATCH_NOT_ACTIVE" });
    expect(executarLive).not.toHaveBeenCalled();
  });

  it("bloqueia provider não-Gmail ANTES do claim — zero consultas e zero chamadas", async () => {
    const pool = poolSequencial([]);
    const executarLive = vi.fn();
    await expect(
      executarWorkerControladoUmaVez(
        pool,
        politica({ REAL_SEND_ENABLED: "true" }),
        executarLive,
        { providerGmailConfigurado: false },
      ),
    ).rejects.toMatchObject({ codigo: "PROVIDER_NOT_CONFIGURED" });
    expect(executarLive).not.toHaveBeenCalled();
    expect(pool.consultas).toHaveLength(0); // nada consumido, nada mutado
  });

  it("recusa execução quando a outbox do teste não está PENDING (nenhuma repetição)", async () => {
    const executarLive = vi.fn();
    const pool = poolSequencial([
      { rows: [{ ...PREVOO_OK.rows[0], outbox_status_teste: "FAILED", outbox_erro_teste: "DELIVERY_UNKNOWN" }], rowCount: 1 },
    ]);
    await expect(
      executarWorkerControladoUmaVez(pool, politica({ REAL_SEND_ENABLED: "true" }), executarLive),
    ).rejects.toMatchObject({ codigo: "OUTBOX_NOT_PENDING" });
    expect(executarLive).not.toHaveBeenCalled();
  });

  it("falha pré-rede FAILED exige liberação auditada (RETRY_NOT_AUTHORIZED)", async () => {
    const executarLive = vi.fn();
    const pool = poolSequencial([
      {
        rows: [
          {
            ...PREVOO_OK.rows[0],
            outbox_status_teste: "FAILED",
            outbox_erro_teste: "PROVIDER_NOT_CONFIGURED",
            outbox_tentativas_teste: "1",
            provider_ids_teste: "0",
          },
        ],
        rowCount: 1,
      },
    ]);
    await expect(
      executarWorkerControladoUmaVez(pool, politica({ REAL_SEND_ENABLED: "true" }), executarLive),
    ).rejects.toMatchObject({ codigo: "RETRY_NOT_AUTHORIZED" });
    expect(executarLive).not.toHaveBeenCalled();
  });

  it("retry pré-rede liberado executa exatamente uma vez e propaga motivo do motor", async () => {
    const pool = poolSequencial([
      {
        rows: [
          {
            ...PREVOO_OK.rows[0],
            outbox_status_teste: "FAILED",
            outbox_erro_teste: "PROVIDER_NOT_CONFIGURED",
            outbox_tentativas_teste: "1",
          },
        ],
        rowCount: 1,
      },
      // Pós-voo: motor bloqueado antes do claim → nada enviado.
      {
        rows: [
          {
            communication_id: "50000000-0000-4000-8000-000000000001",
            estado: "FAILED",
            receipts_globais: "0",
            outbox_status: "FAILED",
            outbox_tentativas: "1",
            outbox_erro: "PROVIDER_NOT_CONFIGURED",
            message_id_presente: false,
            thread_id_presente: false,
          },
        ],
        rowCount: 1,
      },
    ]);
    const executarLive = vi.fn().mockResolvedValue({ motivo: "PROVIDER_NOT_CONFIGURED" });
    const resultado = await executarWorkerControladoUmaVez(
      pool,
      politica({ REAL_SEND_ENABLED: "true" }),
      executarLive,
      { retryAutorizado: true },
    );
    expect(executarLive).toHaveBeenCalledTimes(1); // run-once, sem loop
    expect(resultado.sentItems).toBe(0);
    expect(resultado.falhas).toBe(1);
    expect(resultado.executado).toBe(false);
    expect(resultado.motivoBloqueio).toBe("PROVIDER_NOT_CONFIGURED");
    expect(resultado.statusOutbox).toBe("FAILED");
    expect(resultado.tentativas).toBe(1);
    expect(resultado.erroCodigo).toBe("PROVIDER_NOT_CONFIGURED");
    expect(resultado.messageIdPresente).toBe(false);
  });

  it("executa exatamente UMA iteração e deriva o estado pós-envio do banco", async () => {
    const pool = poolSequencial([PREVOO_OK, POSFLIGHT_ENVIADO]);
    const executarLive = vi.fn().mockResolvedValue({ resultado: { enviados: 1 } });
    const resultado = await executarWorkerControladoUmaVez(
      pool,
      politica({ REAL_SEND_ENABLED: "true" }),
      executarLive,
      { providerGmailConfigurado: true },
    );
    expect(executarLive).toHaveBeenCalledTimes(1); // run-once, sem loop
    expect(resultado.executionMode).toBe("CONTROLLED_GMAIL_TEST");
    expect(resultado.sentItems).toBe(1);
    expect(resultado.falhas).toBe(0);
    expect(resultado.executado).toBe(true);
    expect(resultado.motivoBloqueio).toBeNull();
    expect(resultado.estadoComunicacao).toBe("ACCEPTED");
  });

  it("nenhuma chamada Gmail ocorre quando qualquer bloqueio dispara (agregado)", async () => {
    const executarLive = vi.fn();
    const casos = [
      politica({ REAL_SEND_ENABLED: "false" }),
      politica({ GMAIL_CONTROLLED_MODE: "false", REAL_SEND_ENABLED: "true" }),
      politica({ GMAIL_CONTROLLED_RECIPIENT: "", REAL_SEND_ENABLED: "true" }),
    ];
    for (const p of casos) {
      await expect(executarWorkerControladoUmaVez(poolSequencial([]), p, executarLive)).rejects.toBeInstanceOf(
        BloqueioExecucaoControladaError,
      );
    }
    expect(executarLive).not.toHaveBeenCalled();
  });
});

describe("ativarLoteControlado — CAS auditado restrito ao lote canônico", () => {
  const LOTE_ID = "40000000-0000-4000-8000-000000000002";

  function estadoControladoRow(overrides: Record<string, unknown> = {}) {
    return {
      rows: [
        {
          pendente_fora: "0",
          processamento: "0",
          ativos_fora: "0",
          ...(overrides.rows ?? {
            lote_id: LOTE_ID,
            lote_status: "PREPARACAO",
            lote_modo: "LIVE_PILOT",
            total_itens: "1",
            fonte_registro: "CONTROLADO_SINTETICO",
            receipts: "0",
            ativacoes: "0",
            payload_ciphertext: new Uint8Array(Buffer.from(JSON.stringify({ destinatario: RECIPIENTE }))),
            payload_nonce: new Uint8Array(12),
            payload_auth_tag: new Uint8Array(16),
            chave_versao: "v1",
          }),
        },
      ],
      rowCount: 1,
      ...(overrides.top ?? {}),
    };
  }

  function repositoryComAtivacao(resultCode = "ACTIVATED") {
    return {
      ativarLoteComunicacao: vi.fn().mockResolvedValue({
        status: "ATIVO",
        totalItems: 1,
        sentItems: 0,
        templateVersion: "pf-pilot-crtba-v1",
        createdAt: "2026-09-22T12:00:00.000Z",
        activatedAt: "2026-09-22T12:01:00.000Z",
        resultCode,
      }),
    };
  }

  it("ativa o lote canônico com CAS e um único evento auditado", async () => {
    const pool = poolSequencial([estadoControladoRow()]);
    const repository = repositoryComAtivacao();
    const resultado = await ativarLoteControlado(
      { loteId: LOTE_ID, operador: "operador-sintetico" },
      repository,
      pool as never,
      politica({}),
    );
    expect(resultado.resultCode).toBe("ACTIVATED");
    expect(resultado.status).toBe("ATIVO");
    expect(repository.ativarLoteComunicacao).toHaveBeenCalledTimes(1);
    const comando = repository.ativarLoteComunicacao.mock.calls[0]![0];
    expect(comando.batchId).toBe(LOTE_ID);
    expect(comando.auditEvent.type).toBe("PF_LOTE_COMUNICACAO_ATIVADO");
    expect(JSON.stringify(comando.auditEvent.metadata)).not.toContain(RECIPIENTE); // sem PII
  });

  it("rejeita loteId divergente do lote canônico (nenhum outro lote é ativável)", async () => {
    const pool = poolSequencial([estadoControladoRow()]);
    const repository = repositoryComAtivacao();
    await expect(
      ativarLoteControlado(
        { loteId: "99999999-0000-4000-8000-000000000009", operador: "operador-sintetico" },
        repository,
        pool as never,
        politica({}),
      ),
    ).rejects.toMatchObject({ codigo: "LOTE_CONTROLADO_INEXISTENTE" });
    expect(repository.ativarLoteComunicacao).not.toHaveBeenCalled();
  });

  it("rejeita lote fora do teste ativo e idempotente em ALREADY_ACTIVE", async () => {
    const repository = repositoryComAtivacao();
    const poolAtivos = poolSequencial([estadoControladoRow({ rows: { ativos_fora: "1" } })]);
    await expect(
      ativarLoteControlado({ loteId: LOTE_ID, operador: "op" }, repository, poolAtivos as never, politica({})),
    ).rejects.toBeInstanceOf(BloqueioLoteControladoError);

    const linhaAtiva = { ...estadoControladoRow().rows[0]!, lote_status: "ATIVO" };
    const poolAtivo = poolSequencial([estadoControladoRow({ rows: linhaAtiva })]);
    const resultado = await ativarLoteControlado(
      { loteId: LOTE_ID, operador: "op" },
      repositoryComAtivacao(),
      poolAtivo as never,
      politica({}),
    );
    expect(resultado.resultCode).toBe("ALREADY_ACTIVE");
  });
});
