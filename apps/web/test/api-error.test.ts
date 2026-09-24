import { describe, expect, it } from "vitest";
import { mensagemErroApi } from "../src/api-error.js";

describe("mensagemErroApi", () => {
  it("expõe somente os detalhes estruturais seguros do mapping inválido", () => {
    expect(
      mensagemErroApi(
        {
          erro: "Mapeamento inválido.",
          codigo: "MAPPING_INVALID",
          detalhes: [
            "Campo obrigatório não mapeado (PF): TELEFONE.",
            "Campo EMAIL: coluna 2 já mapeada por outro campo.",
          ],
        },
        400,
      ),
    ).toBe(
      "Mapeamento inválido. Campo obrigatório não mapeado (PF): TELEFONE. Campo EMAIL: coluna 2 já mapeada por outro campo.",
    );
  });

  it("não concatena detalhes de outros tipos de erro", () => {
    expect(
      mensagemErroApi(
        { erro: "Falha na importação.", codigo: "OTHER", detalhes: ["valor sensível"] },
        422,
      ),
    ).toBe("Falha na importação.");
  });

  it("usa o status HTTP quando o backend não fornece mensagem", () => {
    expect(mensagemErroApi({}, 500)).toBe("HTTP 500");
  });
});
