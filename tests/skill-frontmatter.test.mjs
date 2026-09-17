import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter, REQUIRED_SKILLS } from "../scripts/lib/skill-frontmatter.mjs";

const valida = (corpo, dir = "skill-exemplo") =>
  parseSkillFrontmatter(corpo, dir);

describe("contrato de frontmatter das skills", () => {
  it("aceita frontmatter válido", () => {
    const result = valida("---\nname: skill-exemplo\ndescription: Descrição simples.\n---\n\n# Título\n");
    expect(result).toEqual({ name: "skill-exemplo", description: "Descrição simples." });
  });

  it("rejeita ausência de abertura ou fechamento ---", () => {
    expect(valida("name: skill-exemplo\ndescription: x\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription: x\n")).toBeNull();
  });

  it("rejeita name duplicado, description duplicada e campos inesperados", () => {
    expect(valida("---\nname: skill-exemplo\nname: outra\ndescription: x\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription: x\ndescription: y\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription: x\nextra: y\n---\n")).toBeNull();
  });

  it("rejeita casing não canônico nas chaves", () => {
    expect(valida("---\nName: skill-exemplo\ndescription: x\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\nDESCRIPTION: x\n---\n")).toBeNull();
    expect(valida("---\nNAME: skill-exemplo\nDescription: x\n---\n")).toBeNull();
  });

  it("rejeita name com formato inválido ou divergente do diretório", () => {
    expect(valida("---\nname: Skill_Exemplo\ndescription: x\n---\n")).toBeNull();
    expect(valida("---\nname: -skill\ndescription: x\n---\n")).toBeNull();
    expect(valida("---\nname: outro-nome\ndescription: x\n---\n")).toBeNull();
  });

  it("rejeita description vazia, com aspas ou com estruturas YAML", () => {
    expect(valida("---\nname: skill-exemplo\ndescription: \"\"\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription:\n---\n")).toBeNull();
    expect(valida('---\nname: skill-exemplo\ndescription: "citado"\n---\n')).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription: |\n  bloco\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription: >\n  dobrado\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription: [a, b]\n---\n")).toBeNull();
    expect(valida("---\nname: skill-exemplo\ndescription: {a: b}\n---\n")).toBeNull();
  });

  it("baseline canônica tem exatamente 12 skills", () => {
    expect(REQUIRED_SKILLS).toHaveLength(12);
  });
});
