import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CampaignPersistenceError,
  persistirCampanhaAprovada,
  persistirLoteCampanha,
  type CampanhaPool,
} from "../src/campaign-persistence.js";
import {
  hashAprovacaoCampanha,
  snapshotCampanha,
  codigoLoteCampanha,
} from "../src/campaigns.js";

const REGISTROS = [
  { profissional_id: "PF-1", nome: "Ana Sintetica", email_normalizado: "ana@exemplo.test", status_validacao: "APTO" },
  { profissional_id: "PF-2", nome: "Bruno Sintetico", email_normalizado: "bruno@exemplo.test", status_validacao: "APTO" },
];

/** Pool em memória que grava SQL emitido: prova transação única + rollback. */
function poolMemoria(): {
  pool: CampanhaPool;
  sqls: () => string[];
  falhaProxima: () => void;
} {
  const emitidos: string[] = [];
  let falhar = false;
  const executa = async (text: string) => {
    if (falhar && !/^(BEGIN|ROLLBACK)/.test(text.trim())) {
      throw new Error("falha simulada de banco");
    }
    emitidos.push(text);
    return { rows: [] as any[], rowCount: 0 };
  };
  const pool: CampanhaPool = {
    connect: async () => {
      const transacao = {
        query: executa,
        release: () => {},
      };
      return transacao;
    },
    query: executa,
  };
  return { pool, sqls: () => emitidos, falhaProxima: () => { falhar = true; } };
}

describe("CAMPAIGN_PERSISTENCE — snapshot, hash e validação de entrada (unit)", () => {
  it("snapshot contém apenas aptos e reflete decisões humanas", () => {
    const snapshot = snapshotCampanha({
      fingerprintArquivo: "a".repeat(64),
      templateVersao: "pf-expedicao-carteira-2026-v2",
      templateContentHash: "c".repeat(64),
      registros: [...REGISTROS, { profissional_id: "PF-3", nome: "Bloqueado", email_normalizado: "x@exemplo.test", status_validacao: "BLOQUEADO" }],
      decisoes: [{ linha: 1, profissional_id: "PF-1", tipo: "EXCLUSAO_HUMANA", motivo: "REVISAO" }],
    });
    expect(snapshot.total_registros).toBe(3);
    expect(snapshot.total_aptos).toBe(2);
    expect(snapshot.total_bloqueados).toBe(1);
    // GF-3 CORRECTIVE-01 (F4) — decisões são trilha de auditoria; os
    // registros submetidos JÁ são os finais pós-exclusão humana:
    // total_aprovados = snapshot.registros.length (sem dupla subtração).
    expect(snapshot.total_aprovados).toBe(snapshot.registros.length);
    expect(snapshot.registros.every((r) => r.status_validacao === "APTO")).toBe(true);
    expect(snapshot.decisoes_humanas).toHaveLength(1);
  });

  it("hash do snapshot segue o contrato V2 persistido no marcador (approval_hash_version)", () => {
    const templateContentHash = "c".repeat(64);
    const snapshot = snapshotCampanha({
      fingerprintArquivo: "a".repeat(64),
      templateVersao: "pf-expedicao-carteira-2026-v2",
      templateContentHash,
      registros: REGISTROS,
      decisoes: [],
    });
    expect(snapshot.approval_hash_version).toBe("CAMPANHA_APROVACAO_V2");
    const hash = hashAprovacaoCampanha({
      contrato: "CAMPANHA_APROVACAO_V2",
      templateVersao: "pf-expedicao-carteira-2026-v2",
      templateContentHash,
      registros: REGISTROS,
    });
    expect(hashDoSnapshotLocal(snapshot)).toBe(hash);
  });

  it("código do lote é determinístico por fingerprint", () => {
    expect(codigoLoteCampanha("abcdef0123456789")).toBe("CAMPANHA_PF_ABCDEF012345");
    expect(codigoLoteCampanha("abcdef0123456789")).toBe(codigoLoteCampanha("abcdef0123456789"));
  });

  it("recusa fingerprint não-hex, registros vazios e decisões duplicadas", async () => {
    const { pool } = poolMemoria();
    await expect(
      persistirCampanhaAprovada(pool, {
        operatorId: "00000000-0000-4000-8000-000000000001",
        fingerprintArquivo: "xyz",
        registros: REGISTROS,
        decisoes: [],
      }),
    ).rejects.toBeInstanceOf(CampaignPersistenceError);

    await expect(
      persistirCampanhaAprovada(pool, {
        operatorId: "00000000-0000-4000-8000-000000000001",
        fingerprintArquivo: "a".repeat(64),
        registros: [],
        decisoes: [],
      }),
    ).rejects.toBeInstanceOf(CampaignPersistenceError);

    await expect(
      persistirCampanhaAprovada(pool, {
        operatorId: "00000000-0000-4000-8000-000000000001",
        fingerprintArquivo: "a".repeat(64),
        registros: REGISTROS,
        decisoes: [
          { linha: 1, profissional_id: "PF-1", tipo: "EXCLUSAO_HUMANA", motivo: "a" },
          { linha: 1, profissional_id: "PF-1", tipo: "EXCLUSAO_HUMANA", motivo: "b" },
        ],
      }),
    ).rejects.toBeInstanceOf(CampaignPersistenceError);
  });

  it("transação única: BEGIN/COMMIT e INSERTs envolvidos; falha → ROLLBACK", async () => {
    const { pool, sqls, falhaProxima } = poolMemoria();

    // GF-2 FINAL — seleção EXPLÍCITA de template (sem default): a versão
    // registrada/APPROVED é parte do comando de persistência.
    await persistirCampanhaAprovada(pool, {
      operatorId: "00000000-0000-4000-8000-000000000001",
      fingerprintArquivo: "a".repeat(64),
      templateVersao: "pf-expedicao-carteira-2026-v2",
      registros: REGISTROS,
      decisoes: [],
    });
    const seq = sqls().map((s) => s.trim().split(/\s+/)[0]);
    expect(seq[0]).toBe("BEGIN");
    expect(seq[seq.length - 1]).toBe("COMMIT");
    expect(sqls().join("\n")).toContain("INSERT INTO campanha_persistida");
    expect(sqls().join("\n")).toContain("INSERT INTO evento_auditoria");

    falhaProxima();
    await expect(
      persistirCampanhaAprovada(pool, {
        operatorId: "00000000-0000-4000-8000-000000000001",
        fingerprintArquivo: "b".repeat(64),
        templateVersao: "pf-expedicao-carteira-2026-v2",
        registros: REGISTROS,
        decisoes: [],
      }),
    ).rejects.toThrow("falha simulada de banco");
    expect(sqls().at(-1)).toBe("ROLLBACK");
  });

  it("isolamento: lote de campanha alheia é recusado ANTES da validação do hash (403, não 409)", async () => {
    const poolScript: CampanhaPool = {
      connect: async () => ({
        query: async (text: string) => {
          if (/FROM campanha_persistida/.test(text)) {
            return {
              rows: [{
                id: "campanha-1",
                operator_id: "op-dono",
                hash_aprovacao: "a".repeat(64),
                fingerprint_arquivo: "f".repeat(64),
                template_versao: "v1",
                estado: "APROVADA",
                snapshot_registros: {},
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
      query: async () => ({ rows: [], rowCount: 0 }),
    };
    await expect(
      persistirLoteCampanha(poolScript, {
        campanhaId: "campanha-1",
        operatorId: "op-outro",
        hashSubmetido: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_OPERATOR_FORBIDDEN" });
  });

  it("isolamento: idempotência do persist não revela campanha a operador diferente", async () => {
    const emitidos: string[] = [];
    const poolScript: CampanhaPool = {
      connect: async () => ({
        query: async (text: string) => {
          emitidos.push(text);
          if (/FROM campanha_persistida/.test(text)) {
            return {
              rows: [{ id: "campanha-1", operator_id: "op-dono", hash_aprovacao: "h".repeat(64) }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
      query: async () => ({ rows: [], rowCount: 0 }),
    };
    await expect(
      persistirCampanhaAprovada(poolScript, {
        operatorId: "op-outro",
        fingerprintArquivo: "a".repeat(64),
        templateVersao: "pf-expedicao-carteira-2026-v2",
        registros: REGISTROS,
        decisoes: [],
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_OPERATOR_FORBIDDEN" });
    const seq = emitidos.map((linha) => linha.trim().split(/\s+/)[0]);
    expect(seq).toContain("COMMIT");
    expect(seq).not.toContain("INSERT");
  });
});

/**
 * Espelha o contrato canônico V2 (implementação independente da de produção,
 * sem depender do ciclo de import): namespace/versão + ordem fixa de campos,
 * encoding de presença tipado para campos ausentes (GF-3 CORRECTIVE-02/F4).
 */
function hashDoSnapshotLocal(snapshot: {
  template_versao: string;
  template_content_hash: string;
  registros: readonly {
    profissional_id: string;
    nome: string;
    email_normalizado: string;
    status_validacao: string;
  }[];
}): string {
  const sha256 = createHash("sha256");
  sha256.update("integra-correios:approval-hash:CAMPANHA_APROVACAO_V2\n");
  sha256.update(`templateVersion=${snapshot.template_versao}\n`);
  sha256.update(`templateContentHash=${snapshot.template_content_hash}\n`);
  sha256.update(`totalRegistros=${snapshot.registros.length}\n`);
  for (const registro of snapshot.registros) {
    sha256.update(
      [
        registro.profissional_id,
        registro.nome,
        registro.email_normalizado,
        registro.status_validacao,
        // GF-3 CORRECTIVE-02 (F4) — encoding de PRESENÇA tipado: ausente ⇒
        // marcador explícito (nunca "null"); presente ⇒ s:<len>:<valor>.
        "\u0000AUSENTE\u0000", // source_record_key (ausente neste fluxo)
        "\u0000AUSENTE\u0000", // telefone
        "\u0000AUSENTE\u0000", // cep
        "\u0000AUSENTE\u0000", // logradouro
        "\u0000AUSENTE\u0000", // numero
        "\u0000AUSENTE\u0000", // complemento
        "\u0000AUSENTE\u0000", // bairro
        "\u0000AUSENTE\u0000", // cidade
        "\u0000AUSENTE\u0000", // uf
      ].join("\u001f") + "\n",
    );
  }
  return sha256.digest("hex");
}
