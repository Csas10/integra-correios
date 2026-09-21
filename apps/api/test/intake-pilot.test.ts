import { afterEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { confirmarImportacao, executarPreflight } from "../src/intake.js";
import type { PostgresOperationalRepository } from "@integra-correios/persistence";

const CABECALHOS = [
  "CODIGO",
  "REGISTRO NACIONAL",
  "CPF",
  "NOME",
  "EMAIL",
  "CELULAR",
  "TELEFONE",
  "ENDERECO",
  "DATA EVENTO",
  "ULTIMOEXERCICIOQUITADO",
  "ULTIMOEXERCICIOPAGO",
  "ULTIMOEXERCICIOPAGO PARCELAS",
  "EXERCICIOS PENDENTES",
];

const CPF_SINTETICO_1 = ["000", "000", "001", "91"].join("");
const CPF_SINTETICO_2 = ["168", "995", "350", "09"].join("");

const MAPEAMENTO = [
  { campo: "CODIGO" as const, coluna: 0 },
  { campo: "CPF_CNPJ" as const, coluna: 2 },
  { campo: "NOME" as const, coluna: 3 },
  { campo: "EMAIL" as const, coluna: 4 },
  { campo: "CELULAR" as const, coluna: 5 },
  { campo: "TELEFONE" as const, coluna: 6 },
  { campo: "ENDERECO_COMPOSTO" as const, coluna: 7 },
];

function workbookBytes(): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([
    CABECALHOS,
    [
      "SINT-PF-001",
      "RN-SINT-001",
      "52998224725",
      "Pessoa Sintetica Um",
      "pessoa1@example.test",
      "71999990001",
      "7133330001",
      "Rua das Flores, 123 - Centro - Salvador/BA - 40020-000",
      "2026-09-21",
      "",
      "",
      "",
      "",
    ],
    [
      "SINT-PF-002",
      "RN-SINT-002",
      CPF_SINTETICO_2,
      "Pessoa Sintetica Dois",
      "email-invalido",
      "71999990002",
      "7133330002",
      "Avenida Sete, 200 - Centro - Salvador/BA - 40060-001",
      "2026-09-21",
      "",
      "",
      "",
      "",
    ],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "PF");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const oldEnv = {
  data: process.env.DATA_ENCRYPTION_KEY_BASE64,
  fp: process.env.DOCUMENT_FINGERPRINT_KEY_BASE64,
  version: process.env.DATA_ENCRYPTION_KEY_VERSION,
};

afterEach(() => {
  if (oldEnv.data === undefined) delete process.env.DATA_ENCRYPTION_KEY_BASE64;
  else process.env.DATA_ENCRYPTION_KEY_BASE64 = oldEnv.data;
  if (oldEnv.fp === undefined) delete process.env.DOCUMENT_FINGERPRINT_KEY_BASE64;
  else process.env.DOCUMENT_FINGERPRINT_KEY_BASE64 = oldEnv.fp;
  if (oldEnv.version === undefined) delete process.env.DATA_ENCRYPTION_KEY_VERSION;
  else process.env.DATA_ENCRYPTION_KEY_VERSION = oldEnv.version;
});

describe("intake PF institucional → triagem operacional", () => {
  it("aceita a estrutura CRT sem coluna ORIGEM e classifica apto/pendência para o cockpit", async () => {
    const bytes = workbookBytes();

    const preflight = executarPreflight({
      nomeArquivo: "pf-sintetico.xlsx",
      bytes,
      folha: "PF",
      mapeamento: MAPEAMENTO,
    });
    expect(preflight.total).toBe(2);
    expect(preflight.aptosContato).toBe(1);
    expect(preflight.registros[0]?.aptoContato).toBe(true);
    expect(preflight.registros[1]?.aptoContato).toBe(false);

    process.env.DATA_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 1).toString("base64");
    process.env.DOCUMENT_FINGERPRINT_KEY_BASE64 = Buffer.alloc(32, 2).toString("base64");
    process.env.DATA_ENCRYPTION_KEY_VERSION = "test-v1";

    let commandCapturado: any;
    const repository = {
      async registrarImportacaoPf(command: any) {
        commandCapturado = command;
        return {
          arquivoImportacaoId: "10000000-0000-4000-8000-000000000001",
          importacaoId: "10000000-0000-4000-8000-000000000002",
          profissionaisCriados: 2,
          linhasValidas: 2,
          linhasPendentes: 1,
          linhasInvalidas: 0,
        };
      },
    } as unknown as PostgresOperationalRepository;

    await confirmarImportacao(
      {
        nomeArquivo: "pf-sintetico.xlsx",
        bytes,
        folha: "PF",
        mapeamento: MAPEAMENTO,
        operador: "teste",
      },
      repository,
    );

    expect(commandCapturado.linhas[0].statusLinha).toBe("VALIDA");
    expect(commandCapturado.linhas[0].profissional.status).toBe("APTO_CONTATO");
    expect(commandCapturado.linhas[1].statusLinha).toBe("PENDENTE");
    expect(commandCapturado.linhas[1].profissional.status).toBe("PENDENCIA_TRIAGEM");
  });
});
