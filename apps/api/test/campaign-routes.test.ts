import { afterEach, describe, expect, it } from "vitest";
import { despachar } from "../src/server.js";

const ORIGINAL_OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
const ORIGINAL_CAMPAIGN_FLAG = process.env.PF_CAMPAIGN_ENABLED;
const ORIGINAL_REAL_SEND = process.env.REAL_SEND_ENABLED;

afterEach(() => {
  if (ORIGINAL_OPERATOR_TOKEN === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = ORIGINAL_OPERATOR_TOKEN;
  if (ORIGINAL_CAMPAIGN_FLAG === undefined) delete process.env.PF_CAMPAIGN_ENABLED;
  else process.env.PF_CAMPAIGN_ENABLED = ORIGINAL_CAMPAIGN_FLAG;
  if (ORIGINAL_REAL_SEND === undefined) delete process.env.REAL_SEND_ENABLED;
  else process.env.REAL_SEND_ENABLED = ORIGINAL_REAL_SEND;
});

describe("Campanha PF — rotas segregadas e fail-closed", () => {
  it("status da campanha exige autenticação operacional", async () => {
    process.env.OPERATOR_TOKEN = "campaign-route-test";
    expect((await despachar("GET", "/api/campaigns/status")).status).toBe(401);
  });

  it("status autenticado continua não executável mesmo com feature flag ativa", async () => {
    process.env.OPERATOR_TOKEN = "campaign-route-test";
    process.env.PF_CAMPAIGN_ENABLED = "true";
    process.env.REAL_SEND_ENABLED = "false";

    const resposta = await despachar("GET", "/api/campaigns/status", {
      headers: { authorization: "Bearer campaign-route-test" },
    });
    expect(resposta.status).toBe(200);
    const body = JSON.parse(resposta.corpo) as {
      enabled: boolean;
      canPersistImport: boolean;
      canCreateBatch: boolean;
      canExecute: boolean;
      realSendEnabled: boolean;
    };
    expect(body.enabled).toBe(true);
    expect(body.canPersistImport).toBe(false);
    expect(body.canCreateBatch).toBe(false);
    expect(body.canExecute).toBe(false);
    expect(body.realSendEnabled).toBe(false);
  });

  it("workspace declara identidade individual obrigatória e fila indisponível", async () => {
    process.env.OPERATOR_TOKEN = "campaign-route-test";
    const resposta = await despachar("GET", "/api/operator/workspace/status", {
      headers: { authorization: "Bearer campaign-route-test" },
    });
    expect(resposta.status).toBe(200);
    const body = JSON.parse(resposta.corpo) as {
      operatorIdentity: string;
      queueAvailable: boolean;
      nextAction: string;
    };
    expect(body.operatorIdentity).toBe("INDIVIDUAL_REQUIRED");
    expect(body.queueAvailable).toBe(false);
    expect(body.nextAction).toBe("CONFIGURE_INDIVIDUAL_OPERATOR_IDENTITY");
  });

  it("matching permanece exato; prefixos/sufixos não ganham autoridade", async () => {
    process.env.OPERATOR_TOKEN = "campaign-route-test";
    const resposta = await despachar("GET", "/api/campaigns/status-extra", {
      headers: { authorization: "Bearer campaign-route-test" },
    });
    expect(resposta.status).toBe(404);
  });
});
