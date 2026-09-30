import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`ERROR [vercel-runtime] ${message}`);
  process.exit(1);
}

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

const packageJson = await json("package.json");
if (packageJson.dependencies?.["@integra-correios/api"] !== "*") {
  fail("root package must explicitly depend on @integra-correios/api for the /api function workspace graph");
}

const vercel = await json("vercel.json");
if (vercel.buildCommand !== "npm run build:vercel") {
  fail("vercel.json must use the same backend+web build command exercised by CI");
}

const operacaoRewrite = vercel.rewrites?.find(
  (r) => r.source === "/operacao/email" && r.destination === "/index.html",
);
if (!operacaoRewrite) {
  fail("vercel.json must rewrite /operacao/email to /index.html so the direct deep link serves the SPA");
}

const entry = await readFile(path.join(root, "api/index.ts"), "utf8");
if (!entry.includes('from "@integra-correios/api"')) {
  fail("api/index.ts must enter the backend through the declared @integra-correios/api workspace package");
}
if (entry.includes("../apps/api/src/server")) {
  fail("api/index.ts must not bypass the workspace dependency graph with a relative source import");
}

const requiredArtifacts = [
  "apps/api/dist/index.js",
  "apps/api/dist/server.js",
  "apps/worker/dist/index.js",
  "packages/domain/dist/index.js",
  "packages/importers/dist/index.js",
  "packages/mail/dist/index.js",
  "packages/persistence/dist/index.js",
  "packages/pf-workflow/dist/index.js",
];

for (const artifact of requiredArtifacts) {
  try {
    await access(path.join(root, artifact));
  } catch {
    fail(`missing backend runtime artifact after build: ${artifact}`);
  }
}

const api = await import("@integra-correios/api");
if (typeof api.despachar !== "function") {
  fail("@integra-correios/api does not export despachar()");
}

const response = await api.despachar("GET", "/api/health");
if (response.status !== 200) {
  fail(`headless /api/health smoke returned HTTP ${response.status}`);
}

let body;
try {
  body = JSON.parse(response.corpo);
} catch {
  fail("headless /api/health did not return JSON");
}
if (body?.status !== "ok") {
  fail("headless /api/health JSON did not report status=ok");
}

console.log("PASS [vercel-runtime] explicit workspace graph, backend artifacts and /api/health smoke verified");
