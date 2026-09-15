import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@integra-correios/audit": fileURLToPath(new URL("./packages/audit/src/index.ts", import.meta.url)),
      "@integra-correios/correios": fileURLToPath(new URL("./packages/correios/src/index.ts", import.meta.url)),
      "@integra-correios/domain": fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url)),
      "@integra-correios/importers": fileURLToPath(new URL("./packages/importers/src/index.ts", import.meta.url)),
      "@integra-correios/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@integra-correios/validation": fileURLToPath(new URL("./packages/validation/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});
