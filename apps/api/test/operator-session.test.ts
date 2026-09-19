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

  it("logout (DELETE) emite Max-Age=0; browser sem o cookie → 401", async () => {
    process.env.OPERATOR_TOKEN = "token-operacional-sintetico-f12";
    const login = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "token-operacional-sintetico-f12" })),
    });
    const cookie = parseSetCookie(login.headers["set-cookie"]);
    expect((await despachar("GET", "/api/readiness", { headers: { cookie } })).status).toBe(200);
    const saida = await despachar("DELETE", "/api/operator/session", { headers: { cookie } });
    expect(saida.status).toBe(200);
    const cookieRemovido = parseSetCookie(saida.headers["set-cookie"]);
    expect(cookieRemovido).toContain("Max-Age=0");
    // Sessão stateless (F16): o logout limpa o cookie no browser — a
    // requisição seguinte sem ele falha fechada. Revogação server-side do
    // valor capturado exigiria estado (Map/banco), vetado pelo F16.
    const aposSaida = await despachar("GET", "/api/readiness");
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

describe("F16/F17 — sessão STATELESS assinada (serverless-safe) + restore via GET", () => {
  const TOKEN = "token-operacional-sintetico-f16";

  function valorCookie(header: string | undefined): string {
    const cookie = parseSetCookie(header);
    const idx = cookie.indexOf("=");
    return idx > 0 ? cookie.slice(idx + 1, cookie.indexOf(";") > 0 ? cookie.indexOf(";") : undefined) : "";
  }

  async function login(token = TOKEN): Promise<string> {
    const resposta = await despachar("POST", "/api/operator/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token })),
    });
    expect(resposta.status).toBe(200);
    return valorCookie(resposta.headers["set-cookie"]);
  }

  it("sessão emitida é válida em uma 'nova instância' (mesma chave derivada, sem memória de processo)", async () => {
    process.env.OPERATOR_TOKEN = TOKEN;
    const valor = await login();
    // O cookie carrega payload.versionado.assinatura — NENHUM estado server-side.
    expect(valor.split(".")).toHaveLength(5);
    // Qualquer requisição posterior valida apenas o cookie assinado:
    // funciona em qualquer instância do processo/pod serverless.
    const readiness = await despachar("GET", "/api/readiness", {
      headers: { cookie: `ic_operator_session=${valor}` },
    });
    expect(readiness.status).toBe(200);
  });

  it("cookie adulterado (assinatura inválida) → 401", async () => {
    process.env.OPERATOR_TOKEN = TOKEN;
    const valor = await login();
    const partes = valor.split(".");
    const adulterado = `${partes[0]}.${partes[1]}.${partes[2]}.${partes[3]}.assinatura-falsa`;
    const resposta = await despachar("GET", "/api/readiness", {
      headers: { cookie: `ic_operator_session=${adulterado}` },
    });
    expect(resposta.status).toBe(401);
  });

  it("cookie com expiração no passado → 401 (validação server-side)", async () => {
    process.env.OPERATOR_TOKEN = TOKEN;
    const valor = await login();
    const partes = valor.split(".");
    const expirado = `${partes[0]}.${Number(partes[1]) - 10_000}.${Number(partes[2]) - 5_000}.${partes[3]}.${partes[4]}`;
    const resposta = await despachar("GET", "/api/readiness", {
      headers: { cookie: `ic_operator_session=${expirado}` },
    });
    expect(resposta.status).toBe(401);
  });

  it("rotação de OPERATOR_TOKEN invalida sessões emitidas pelo token anterior", async () => {
    process.env.OPERATOR_TOKEN = TOKEN;
    const valor = await login();
    process.env.OPERATOR_TOKEN = "token-rotacionado-f16";
    const resposta = await despachar("GET", "/api/readiness", {
      headers: { cookie: `ic_operator_session=${valor}` },
    });
    expect(resposta.status).toBe(401);
    process.env.OPERATOR_TOKEN = TOKEN;
  });

  it("GET /api/operator/session sem sessão → 401; com sessão → 200 sanitizado", async () => {
    process.env.OPERATOR_TOKEN = TOKEN;
    const semSessao = await despachar("GET", "/api/operator/session");
    expect(semSessao.status).toBe(401);

    const valor = await login();
    const comSessao = await despachar("GET", "/api/operator/session", {
      headers: { cookie: `ic_operator_session=${valor}` },
    });
    expect(comSessao.status).toBe(200);
    const corpo = JSON.parse(comSessao.corpo) as { status?: string; expiraEm?: string };
    expect(corpo.status).toBe("OPERATOR_SESSION_ACTIVE");
    expect(typeof corpo.expiraEm).toBe("string");
    // Sanitizado: NENHUM token, assinatura, nonce ou valor do cookie na resposta.
    expect(comSessao.corpo).not.toContain(TOKEN);
    expect(comSessao.corpo).not.toContain(valor);
  });

  it("refresh lógico da UI: login → GET session 200 → rota operacional 200 → logout limpa cookie → GET session 401", async () => {
    process.env.OPERATOR_TOKEN = TOKEN;
    const valor = await login();
    const headers = { cookie: `ic_operator_session=${valor}` };
    expect((await despachar("GET", "/api/operator/session", { headers })).status).toBe(200);
    expect((await despachar("GET", "/api/readiness", { headers })).status).toBe(200);
    await despachar("DELETE", "/api/operator/session", { headers });
    // Após o logout o browser não envia mais o cookie (Max-Age=0):
    const semCookie = await despachar("GET", "/api/operator/session");
    expect(semCookie.status).toBe(401);
  });
});
