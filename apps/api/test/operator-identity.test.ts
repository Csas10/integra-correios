import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { despachar } from "../src/server.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const ORIGINAL_OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;

function firstCookie(header: string | undefined): string {
  return header?.split("\n")[0]?.split(";")[0] ?? "";
}

afterEach(() => {
  if (ORIGINAL_OPERATOR_TOKEN === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = ORIGINAL_OPERATOR_TOKEN;
});

describeDb("Identidade operacional — API E2E sem campanha/lote", () => {
  it("login individual → /me; suspensão invalida a mesma sessão imediatamente", async () => {
    process.env.OPERATOR_TOKEN = "admin-tecnico-sintetico-identidade";
    const operatorId = randomUUID();
    const suffix = operatorId.replace(/-/g, "").slice(0, 8);
    const individualToken = `IndividuaL_abcdefghijklmnopqrstuvwxyz0123456789${suffix}`;

    const provision = await despachar("POST", "/api/operator/admin/provision", {
      headers: {
        authorization: "Bearer admin-tecnico-sintetico-identidade",
        "content-type": "application/json",
      },
      corpo: Buffer.from(JSON.stringify({
        operatorId, code: `OP-${suffix}`, displayName: "Operador API Sintético",
        roles: ["PREPARADOR", "REVISOR"], token: individualToken,
      })),
    });
    expect(provision.status).toBe(201);
    expect(provision.corpo).not.toContain(individualToken);

    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: individualToken })),
    });
    expect(login.status).toBe(200);
    expect(login.corpo).not.toContain(individualToken);
    const setCookie = login.headers["set-cookie"];
    expect(setCookie).toContain("__Host-ic_campaign_operator_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = firstCookie(setCookie);

    const me = await despachar("GET", "/api/operator/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const meBody = JSON.parse(me.corpo) as { operatorId: string; roles: string[]; status: string };
    expect(meBody.operatorId).toBe(operatorId);
    expect(meBody.status).toBe("ATIVO");
    expect(meBody.roles).toEqual(["PREPARADOR", "REVISOR"]);

    const workspace = await despachar("GET", "/api/operator/workspace/status", { headers: { cookie } });
    expect(workspace.status).toBe(200);
    const workspaceBody = JSON.parse(workspace.corpo) as {
      campaign: { canPersistImport: boolean; canCreateBatch: boolean; canExecute: boolean };
    };
    expect(workspaceBody.campaign.canPersistImport).toBe(false);
    expect(workspaceBody.campaign.canCreateBatch).toBe(false);
    expect(workspaceBody.campaign.canExecute).toBe(false);

    const sharedFallback = await despachar("GET", "/api/operator/me", {
      headers: { authorization: "Bearer admin-tecnico-sintetico-identidade" },
    });
    expect(sharedFallback.status).toBe(401);

    const suspend = await despachar("POST", "/api/operator/admin/suspend", {
      headers: {
        authorization: "Bearer admin-tecnico-sintetico-identidade",
        "content-type": "application/json",
      },
      corpo: Buffer.from(JSON.stringify({ operatorId })),
    });
    expect(suspend.status).toBe(200);
    expect((await despachar("GET", "/api/operator/me", { headers: { cookie } })).status).toBe(401);
  });

  it("papel exclusivamente técnico vê /me mas recebe 403 no workspace", async () => {
    process.env.OPERATOR_TOKEN = "admin-tecnico-sintetico-identidade";
    const operatorId = randomUUID();
    const suffix = operatorId.replace(/-/g, "").slice(0, 8);
    const individualToken = `TecnicoOnly_abcdefghijklmnopqrstuvwxyz0123456789${suffix}`;

    expect((await despachar("POST", "/api/operator/admin/provision", {
      headers: {
        authorization: "Bearer admin-tecnico-sintetico-identidade",
        "content-type": "application/json",
      },
      corpo: Buffer.from(JSON.stringify({
        operatorId, code: `ADM-${suffix}`, displayName: "Administrador Técnico Sintético",
        roles: ["ADMIN_TECNICO"], token: individualToken,
      })),
    })).status).toBe(201);

    const login = await despachar("POST", "/api/operator/identity/session", {
      headers: { "content-type": "application/json" },
      corpo: Buffer.from(JSON.stringify({ token: individualToken })),
    });
    const cookie = firstCookie(login.headers["set-cookie"]);
    expect((await despachar("GET", "/api/operator/me", { headers: { cookie } })).status).toBe(200);
    expect((await despachar("GET", "/api/operator/workspace/status", { headers: { cookie } })).status).toBe(403);
  });
});
