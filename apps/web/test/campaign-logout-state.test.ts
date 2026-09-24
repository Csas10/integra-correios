import { describe, expect, it } from "vitest";
import { campaignLogoutDisposition } from "../src/pages/campaign-logout-state.js";

describe("CampaignWorkspace — estado visual de logout", () => {
  it("trata 401 como sessão já encerrada", () => {
    expect(campaignLogoutDisposition(401)).toBe("SIGNED_OUT");
  });

  it("trata sucesso 2xx como sessão encerrada", () => {
    expect(campaignLogoutDisposition(200)).toBe("SIGNED_OUT");
    expect(campaignLogoutDisposition(204)).toBe("SIGNED_OUT");
  });

  it("mantém estado visual para erro de persistência", () => {
    expect(campaignLogoutDisposition(503)).toBe("UNKNOWN");
    expect(campaignLogoutDisposition(500)).toBe("UNKNOWN");
  });
});
