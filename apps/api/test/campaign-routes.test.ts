import { describe, expect, it } from "vitest";
import { despachar } from "../src/server.js";

describe("Campanha PF — rotas segregadas e fail-closed", () => {
  it("status da campanha exige sessão individual", async () => {
    process.env.OPERATOR_TOKEN = "legacy-campaign-route-test";
    expect((await despachar("GET", "/api/campaigns/status")).status).toBe(401);
  });

  it("Bearer técnico compartilhado não é fallback da nova interface", async () => {
    process.env.OPERATOR_TOKEN = "legacy-campaign-route-test";
    const headers = { authorization: "Bearer legacy-campaign-route-test" };
    expect((await despachar("GET", "/api/campaigns/status", { headers })).status).toBe(401);
    expect((await despachar("GET", "/api/operator/workspace/status", { headers })).status).toBe(401);
    expect((await despachar("GET", "/api/operator/me", { headers })).status).toBe(401);
  });

  it("login individual rejeita credencial curta antes de consultar banco", async () => {
    const resposta = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: "curto" })),
    });
    expect(resposta.status).toBe(401);
    expect(resposta.corpo).not.toContain("curto");
  });

  it("matching permanece exato; prefixos/sufixos não ganham autoridade", async () => {
    process.env.OPERATOR_TOKEN = "legacy-campaign-route-test";
    const resposta = await despachar("GET", "/api/campaigns/status-extra", {
      headers: { authorization: "Bearer legacy-campaign-route-test" },
    });
    expect(resposta.status).toBe(404);
  });
});
