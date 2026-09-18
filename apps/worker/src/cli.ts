import { executarWorkerUmaVez } from "./outbox.js";

/**
 * CLI do worker da outbox — UMA iteração por invocação.
 * Uso: npm run worker:run-once -w @integra-correios/worker
 * Sem daemon/loop: o piloto é one-time e supervisionado.
 */
const { readiness, resultado, motivo } = await executarWorkerUmaVez({ dryRun: false });
if (!resultado) {
  process.stdout.write(
    `${JSON.stringify({ executado: false, motivo, modo: readiness.executionMode })}\n`,
  );
} else {
  process.stdout.write(`${JSON.stringify({ executado: true, ...resultado })}\n`);
}
