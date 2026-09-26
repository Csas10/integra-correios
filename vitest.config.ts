import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@integra-correios/audit": fileURLToPath(new URL("./packages/audit/src/index.ts", import.meta.url)),
      "@integra-correios/correios": fileURLToPath(new URL("./packages/correios/src/index.ts", import.meta.url)),
      "@integra-correios/domain": fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url)),
      "@integra-correios/importers": fileURLToPath(new URL("./packages/importers/src/index.ts", import.meta.url)),
      "@integra-correios/mail": fileURLToPath(new URL("./packages/mail/src/index.ts", import.meta.url)),
      "@integra-correios/persistence": fileURLToPath(new URL("./packages/persistence/src/index.ts", import.meta.url)),
      "@integra-correios/pf-workflow": fileURLToPath(new URL("./packages/pf-workflow/src/index.ts", import.meta.url)),
      "@integra-correios/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@integra-correios/worker": fileURLToPath(new URL("./apps/worker/src/index.ts", import.meta.url)),
      "@integra-correios/validation": fileURLToPath(new URL("./packages/validation/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // A CI compartilha um único PostgreSQL 16 entre todas as suítes DB-gated
    // (deltas antes/depois em contadores globais). Execução de arquivos em
    // paralelo torna esses deltas não determinísticos; serializar os arquivos
    // garante a prova de zero-escrita e o isolamento por operador.
    fileParallelism: false,
    include: [
      "apps/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
      "tests/**/*.test.mjs",
    ],
    passWithNoTests: false,
    reporters: ["default"],
  },
});
