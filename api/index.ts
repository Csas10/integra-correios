/**
 * F1 — Adapter serverless (Vercel) da API operacional.
 *
 * NÃO duplica regras: delega 100% do roteamento, autenticação e lógica para
 * `despachar()` de apps/api/src/server.ts, que usa as MESMAS ROTAS do
 * servidor Node local. O Preview passa a ter backend real:
 *   /api/health · /api/readiness · intake · cockpit · worker DRY_RUN
 * O browser em Preview NUNCA depende de localhost.
 *
 * bodyParser desativado: o corpo bruto (XLSX) é lido aqui e repassado ao
 * despachador, exatamente como o servidor Node local faz.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { despachar } from "@integra-correios/api";

export const config = { api: { bodyParser: false } };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const metodo = (req.method ?? "GET").toUpperCase();
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const corpo = Buffer.concat(chunks);
  const resultado = await despachar(metodo, req.url ?? "/api/health", {
    headers: req.headers as Record<string, string | undefined>,
    corpo,
  });
  res.statusCode = resultado.status;
  for (const [chave, valor] of Object.entries(resultado.headers)) {
    res.setHeader(chave, valor);
  }
  res.end(resultado.corpo);
}
