import { describe, expect, it } from "vitest";
import {
  carregarPoliticaCampanhaAtualizacao,
  codigoCampanhaAtualizacao,
  RESERVED_PILOT_BATCH_CODE,
} from "../src/campaigns.js";

describe("Campanha PF — fundação segregada", () => {
  it("nasce desabilitada e incapaz de persistir/criar/executar lote", () => {
    const policy = carregarPoliticaCampanhaAtualizacao({ REAL_SEND_ENABLED: "false" });
    expect(policy.enabled).toBe(false);
    expect(policy.individualOperatorIdentityRequired).toBe(true);
    expect(policy.canPersistImport).toBe(false);
    expect(policy.canCreateBatch).toBe(false);
    expect(policy.canExecute).toBe(false);
    expect(policy.realSendEnabled).toBe(false);
  });

  it("feature flag isolada não arma execução nem Gmail real", () => {
    const policy = carregarPoliticaCampanhaAtualizacao({
      PF_CAMPAIGN_ENABLED: "true",
      REAL_SEND_ENABLED: "false",
    });
    expect(policy.enabled).toBe(true);
    expect(policy.canExecute).toBe(false);
    expect(policy.realSendEnabled).toBe(false);
  });

  it("gera namespace próprio e nunca reutiliza CONTROLLED_GMAIL_TEST", () => {
    expect(codigoCampanhaAtualizacao(2026, 1)).toBe("PF_ATUALIZACAO_CADASTRAL_2026_01");
    expect(codigoCampanhaAtualizacao(2026, 1)).not.toBe(RESERVED_PILOT_BATCH_CODE);
  });
});
