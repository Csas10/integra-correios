// Contrato de frontmatter das skills — validação mínima e fail-closed.
// Sem dependência YAML: parsing de linhas `chave: valor` simples, apenas
// o suficiente para o contrato de skills (sem conteúdo semântico).
//
// Regras (rejeita qualquer violação):
//   - abre com `---` na linha 1 e fecha com `---`;
//   - exatamente um `name` e exatamente um `description`;
//   - `name` segue formato permitido e é igual ao diretório;
//   - `description` é texto simples, single-line e não vazio;
//   - valores estruturais YAML ([, ], {, }, |, >) são rejeitados;
//   - chaves duplicadas são rejeitadas;
//   - campos inesperados são rejeitados (contrato: name + description apenas);
//   - fechamento `---` é obrigatório.

const NAME_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set(["name", "description"]);
const STRUCTURAL_PREFIX = /^[{[|>]|[\]}]\s*$/;

/**
 * Valida o frontmatter de um SKILL.md. Retorna { name, description } ou
 * null quando inválido (o chamador registra a violação — fail-closed).
 */
export function parseSkillFrontmatter(content, expectedDirectory) {
  const openMatch = /^---\r?\n/.exec(content);
  if (!openMatch) return null;
  const rest = content.slice(openMatch[0].length);
  const closeIndex = rest.search(/^---\r?(?:\n|$)/m);
  if (closeIndex < 0) return null; // fechamento --- obrigatório

  const lines = rest.slice(0, closeIndex).split(/\r?\n/);
  const seen = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const keyValue = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!keyValue) return null; // linha fora do formato chave: valor
    const key = keyValue[1].toLowerCase();
    const valueRaw = keyValue[2];
    if (!ALLOWED_KEYS.has(key)) return null; // campo inesperado
    if (seen.has(key)) return null; // chave duplicada
    if (key === "name") {
      const name = valueRaw.trim();
      if (!NAME_FORMAT.test(name)) return null;
      if (name !== expectedDirectory) return null;
      seen.set(key, name);
      continue;
    }
    // description: texto simples, single-line, não vazio
    const value = valueRaw.trim();
    if (!value) return null; // description: ""
    if (STRUCTURAL_PREFIX.test(value)) return null; // estruturas YAML
    if (/["'[\]{}|>]/.test(value)) return null; // aspas/metacaracteres estruturais
    seen.set(key, value);
  }

  const name = seen.get("name");
  const description = seen.get("description");
  if (!name || !description) return null; // exatamente um de cada, ambos presentes
  return { name, description };
}

export const REQUIRED_SKILLS = [
  "agent-operating-model",
  "correios-golden-profile",
  "gmail-integration",
  "intake-mapping-engine",
  "legacy-regression",
  "operational-persistence",
  "pf-workflow",
  "ppn-orchestration",
  "quality-gate",
  "repo-governance",
  "security-privacy",
  "web-operational-flow",
];
