import { describe, expect, it } from "vitest";
import {
  LotePilotoEmAndamentoError,
  prepararLotePiloto,
  recuperarLotePilotoEmAndamento,
} from "../src/pilot.js";
import type { PostgresOperationalRepository } from "@integra-correios/persistence";

describe("recovery do lote piloto", () => {
  it("reconstrói o lote PF/DRY_RUN persistido após refresh da UI", async () => {
    const pool = {
      async query() {
        return {
          rowCount: 1,
          rows: [
            {
              id: "10000000-0000-4000-8000-000000000010",
              codigo: "PF-MAIL-PILOTO-RECOVERY",
              status: "ATIVO",
              modo: "DRY_RUN",
              total_itens: 3,
            },
          ],
        };
      },
    };

    await expect(recuperarLotePilotoEmAndamento(pool)).resolves.toEqual({
      loteId: "10000000-0000-4000-8000-000000000010",
      codigo: "PF-MAIL-PILOTO-RECOVERY",
      status: "ATIVO",
      modo: "DRY_RUN",
      totalItens: 3,
    });
  });

  it("não inventa lote quando não existe operação recuperável", async () => {
    const pool = {
      async query() {
        return { rowCount: 0, rows: [] };
      },
    };
    await expect(recuperarLotePilotoEmAndamento(pool)).resolves.toBeUndefined();
  });

  it("bloqueia nova preparação antes do INSERT quando profissional já pertence a lote ativo", async () => {
    let chamada = 0;
    const pool = {
      async query() {
        chamada += 1;
        if (chamada === 1) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "20000000-0000-4000-8000-000000000001",
                codigo_operacional: "SINT-PF-RECOVERY",
                status: "APTO_CONTATO",
                conteudo_ciphertext: new Uint8Array([1]),
                conteudo_nonce: new Uint8Array(12),
                conteudo_auth_tag: new Uint8Array(16),
                chave_versao: "v1",
              },
            ],
          };
        }
        return {
          rowCount: 1,
          rows: [
            {
              id: "30000000-0000-4000-8000-000000000001",
              codigo: "PF-MAIL-PILOTO-JA-EXISTE",
              status: "ATIVO",
              criado_em: new Date(),
            },
          ],
        };
      },
    };

    const promise = prepararLotePiloto(
      {
        professionalIds: ["20000000-0000-4000-8000-000000000001"],
        operador: "teste",
        confirmationBaseUrl: "https://preview.example.test",
      },
      {} as PostgresOperationalRepository,
      pool,
      {
        seal() {
          throw new Error("não deve selar payload quando há conflito");
        },
        open() {
          throw new Error("não deve decifrar snapshot quando há conflito");
        },
      },
      {
        fingerprint() {
          throw new Error("não deve gerar fingerprint quando há conflito");
        },
      },
      { pilotMode: true, maxRecipients: 5, realSendEnabled: false },
      {
        async issue() {
          throw new Error("não deve emitir token quando há conflito");
        },
        async hash() {
          throw new Error("não deve hashear token quando há conflito");
        },
      },
    );

    await expect(promise).rejects.toBeInstanceOf(LotePilotoEmAndamentoError);
    await expect(promise).rejects.toMatchObject({
      lote: {
        codigo: "PF-MAIL-PILOTO-JA-EXISTE",
        status: "ATIVO",
      },
    });
  });
});
