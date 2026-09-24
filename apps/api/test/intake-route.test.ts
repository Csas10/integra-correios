import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { despachar } from "../src/server.js";

const TOKEN = "token-operacional-sintetico-intake-route";
const CPF_SINTETICO = ["000", "000", "001", "91"].join("");

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

const MAPEAMENTO_PF = [
  { campo: "CODIGO", coluna: 0 },
  { campo: "CPF_CNPJ", coluna: 2 },
  { campo: "NOME", coluna: 3 },
  { campo: "EMAIL", coluna: 4 },
  { campo: "CELULAR", coluna: 5 },
  { campo: "TELEFONE", coluna: 6 },
  { campo: "ENDERECO_COMPOSTO", coluna: 7 },
];

function workbookBytes(): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([
    CABECALHOS,
    [
      "SINT-PF-ROUTE-001",
      "RN-SINT-ROUTE-001",
      CPF_SINTETICO,
      "Profissional Sintetico Route",
      "route@example.test",
      "71999990001",
      "7133330001",
      "Rua Alfa, 101 - Centro - Salvador/BA - 40020-000",
      "2026-09-21",
      "",
      "",
      "",
      "",
    ],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "PF");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function cookieValue(setCookie: string | undefined): string {
  return setCookie?.split(";")[0] ?? "";
}

async function login(): Promise<string> {
  process.env.OPERATOR_TOKEN = TOKEN;
  const resposta = await despachar("POST", "/api/operator/session", {
    headers: { "content-type": "application/json" },
    corpo: Buffer.from(JSON.stringify({ token: TOKEN })),
  });
  expect(resposta.status).toBe(200);
  return cookieValue(resposta.headers["set-cookie"]);
}

describe("intake route — contrato real da UI com XLSX institucional PF", () => {
  it("POST /api/intake/preflight aceita XLSX CRT sem ORIGEM e mapping codificado pela UI", async () => {
    const cookie = await login();
    const resposta = await despachar("POST", "/api/intake/preflight", {
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("PF Sintetico Hard Gate B.xlsx"),
        "x-mapping": encodeURIComponent(JSON.stringify(MAPEAMENTO_PF)),
      },
      corpo: workbookBytes(),
    });

    expect(resposta.status).toBe(200);
    const corpo = JSON.parse(resposta.corpo) as {
      total: number;
      aptosContato: number;
      registros: { aptoContato: boolean }[];
    };
    expect(corpo.total).toBe(1);
    expect(corpo.aptosContato).toBe(1);
    expect(corpo.registros[0]?.aptoContato).toBe(true);
  });

  it("mapping duplicado retorna 400 com diagnóstico seguro em vez de 422 opaco", async () => {
    const cookie = await login();
    const mappingComDuplicidade = [
      { campo: "ORIGEM", coluna: 0 },
      ...MAPEAMENTO_PF,
    ];
    const resposta = await despachar("POST", "/api/intake/preflight", {
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("PF Sintetico Hard Gate B.xlsx"),
        "x-mapping": encodeURIComponent(JSON.stringify(mappingComDuplicidade)),
      },
      corpo: workbookBytes(),
    });

    expect(resposta.status).toBe(400);
    const corpo = JSON.parse(resposta.corpo) as {
      codigo?: string;
      detalhes?: string[];
    };
    expect(corpo.codigo).toBe("MAPPING_INVALID");
    expect(corpo.detalhes?.some((item) => item.includes("coluna 0"))).toBe(true);
    expect(resposta.corpo).not.toContain(CPF_SINTETICO);
    expect(resposta.corpo).not.toContain("route@example.test");
  });
});
