import { describe, expect, it } from "vitest";

describe("PILOT_DOMAIN — módulo neutro de segregação", () => {
  it("código reservado único e sem dependências (arquivo autossuficiente)", async () => {
    const fonte = (await import("node:fs")).readFileSync(
      new URL("../src/pilot-domain.ts", import.meta.url),
      "utf-8",
    );
    expect(fonte).not.toMatch(/^import /m);
    expect(fonte.match(/CONTROLLED_GMAIL_TEST/g)?.length).toBe(1);
    const { RESERVED_PILOT_BATCH_CODE } = await import("../src/pilot-domain.js");
    expect(RESERVED_PILOT_BATCH_CODE).toBe("CONTROLLED_GMAIL_TEST");
  });
});
