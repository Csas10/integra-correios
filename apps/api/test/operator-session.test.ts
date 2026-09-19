import { describe, expect, it } from "vitest";
import { despachar, parseMappingHeader, parseFileNameHeader } from "../src/server.js";

// F12/F15 — Regressões de contrato browser→API via `despachar` (o MESMO
// dispatcher do servidor Node e do adapter serverless do Preview):
// sessão operacional por cookie HttpOnly, rotas operacionais protegidas,
// matching EXATO de rotas e headers de mapping/file-name simétricos.

function parseSetCookie(header: string | undefined): string {
  // Múltiplos cookies são acumulados por "\n"; pega o primeiro completo
  // (valor + atributos) — o corte de múltiplos cookies NÃO remove HttpOnly.
  return header?.split("\n")[0] ?? "";
}

describe("F15 — matching exato de rotas", () => {
  it("/api/health responde 200 e /api/health-foo é 404", async () => {
    expect((await despachar("GET", "/api/health")).status).toBe(200);
    expect((await despachar("GET", "/api/health-foo")).status).toBe(404);
  });

  it("/api/confirmation sem token → 400 (rota correta); /api/confirmation-admin → 404", async () => {
    expect((await despachar("GET", "/api/confirmation")).status).toBe(400);
    expect((await despachar("GET", "/api/confirmation-admin")).status).toBe(404);
  });

  it("/api/oauth/gmail/start operacional → 401 sem sessão; /api/oauth/gmail/start-foo → 404", async () => {
    const inicio = await despachar("GET", "/api/oauth/gmail/start");
    expect(inicio.status).toBe(401);
    expect((await despachar("GET", "/api/oauth/gmail/start-foo")).status).toBe(404);
  });
});

describe("F12 — sessão operacional (token trocado UMA vez por cookie HttpOnly)", () => {
  it("POST /api/operator/session sem OPERATOR_TOKEN no ambiente → fail-closed (503)", async () => {
    const antes = process.env.OPERATOR_TOKEN;
    delete process.env.OPERATOR_TOKEN;
    const resposta = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "qualquer" })),
    });
    expect(resposta.status).toBe(503);
    process.env.OPERATOR_TOKEN = antes;
  });

  it("token incorreto → 401; token correto → sessão emitida (cookie HttpOnly, token NUNCA na resposta)", async () => {
    process.env.OPERATOR_TOKEN = "token-operacional-sintetico-f12";
    const negado = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "errado" })),
    });
    expect(negado.status).toBe(401);

    const ok = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "token-operacional-sintetico-f12" })),
    });
    expect(ok.status).toBe(200);
    const corpo = JSON.parse(ok.corpo) as { status?: string };
    expect(corpo.status).toBe("OPERATOR_SESSION_ACTIVE");
    const cookie = parseSetCookie(ok.headers["set-cookie"]);
    expect(cookie).toContain("ic_operator_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(ok.corpo).not.toContain("token-operacional-sintetico-f12");
  });

  it("rota operacional sem sessão → 401; com cookie de sessão → 200", async () => {
    process.env.OPERATOR_TOKEN = "token-operacional-sintetico-f12";
    const semSessao = await despachar("GET", "/api/readiness");
    expect(semSessao.status).toBe(401);

    const login = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "token-operacional-sintetico-f12" })),
    });
    const cookie = parseSetCookie(login.headers["set-cookie"]);
    const comSessao = await despachar("GET", "/api/readiness", { headers: { cookie } });
    expect(comSessao.status).toBe(200);
  });

  it("Bearer técnico continua aceito; cookie inválido/expirado → 401", async () => {
    process.env.OPERATOR_TOKEN = "token-operacional-sintetico-f12";
    const bearer = await despachar("GET", "/api/readiness", {
      headers: { authorization: "Bearer token-operacional-sintetico-f12" },
    });
    expect(bearer.status).toBe(200);

    const falsificado = await despachar("GET", "/api/readiness", {
      headers: { cookie: "ic_operator_session=valor-inexistente" },
    });
    expect(falsificado.status).toBe(401);
  });

  it("logout (DELETE) invalida a sessão", async () => {
    process.env.OPERATOR_TOKEN = "token-operacional-sintetico-f12";
    const login = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "token-operacional-sintetico-f12" })),
    });
    const cookie = parseSetCookie(login.headers["set-cookie"]);
    expect((await despachar("GET", "/api/readiness", { headers: { cookie } })).status).toBe(200);
    const saida = await despachar("DELETE", "/api/operator/session", { headers: { cookie } });
    expect(saida.status).toBe(200);
    const aposSaida = await despachar("GET", "/api/readiness", { headers: { cookie } });
    expect(aposSaida.status).toBe(401);
  });
});

describe("F13-contrato — headers x-mapping / x-file-name simétricos browser↔API", () => {
  it("formato EXATO produzido pela UI (encodeURIComponent(JSON.stringify)) é aceito", () => {
    const mapping = [
      { campo: "ORIGEM", coluna: 0 },
      { campo: "CODIGO", coluna: 1 },
      { campo: "NOME", coluna: 2 },
    ];
    const header = encodeURIComponent(JSON.stringify(mapping));
    expect(parseMappingHeader(header)).toEqual(mapping);
  });

  it("JSON malformado, schema inválido e tamanho excessivo → 400 sanitizado (nunca 500)", () => {
    expect(() => parseMappingHeader(encodeURIComponent("{not json"))).toThrow();
    expect(() => parseMappingHeader(encodeURIComponent(JSON.stringify({ campo: "NOME" })))).toThrow();
    expect(() => parseMappingHeader(encodeURIComponent(JSON.stringify([{ campo: "", coluna: 0 }])))).toThrow();
    expect(() => parseMappingHeader(encodeURIComponent(JSON.stringify([{ campo: "NOME", coluna: -1 }])))).toThrow();
    expect(() => parseMappingHeader(`${"a".repeat(70_000)}`)).toThrow();
  });

  it("x-file-name: encode no browser → decode seguro na API", () => {
    expect(parseFileNameHeader(encodeURIComponent("Base Institucional 2026.xlsx"))).toBe(
      "Base Institucional 2026.xlsx",
    );
    expect(parseFileNameHeader(undefined)).toBe("entrada.xlsx");
    expect(() => parseFileNameHeader(encodeURIComponent("quebra\nlinha.xlsx"))).toThrow();
  });

  it("contrato completo browser→API: preflight com headers da UI (sem banco)", async () => {
    process.env.OPERATOR_TOKEN = "token-operacional-sintetico-f12";
    const login = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "token-operacional-sintetico-f12" })),
    });
    const cookie = parseSetCookie(login.headers["set-cookie"]);

    const bytesXlsx = Buffer.from(
      "PK\u0003\u0004fixture-sintetica-nao-e-um-zip-valido",
      "utf8",
    );
    const resposta = await despachar("POST", "/api/intake/preflight", {
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("Base Sintetica.xlsx"),
        "x-mapping": encodeURIComponent(
          JSON.stringify([{ campo: "CODIGO", coluna: 1 }]),
        ),
      },
      corpo: bytesXlsx,
    });
    // XLSX inválido por construção → 422 sanitizado; NUNCA 500 (contrato
    // parsing correto até o executor, autenticado pela sessão).
    expect(resposta.status).toBe(422);
  });
});
