import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { OauthStateSigner, OAUTH_BINDING_COOKIE } from "@integra-correios/mail";
import {
  concluirFluxoOauth,
  hashOperadorGmail,
  iniciarFluxoOauth,
  validarBindingState,
  OauthFlowError,
} from "../src/oauth.js";
import type {
  ConsumeOauthFlowBindingCommand,
  OauthFlowBindingConsumeResult,
  PostgresOperationalRepository,
  RegisterOauthFlowBindingCommand,
} from "@integra-correios/persistence";
import { Aes256GcmSecretBox } from "@integra-correios/persistence";

// F13/F14/F18/F19 + FINAL CLOSURE GATE — Regressões do fluxo OAuth Gmail:
// binding one-time start↔callback PERSISTIDO (serverless-safe) com o
// code_verifier PKCE CIFRADO NO BANCO (nunca no state/browser) e sessão
// ancorada pelo hash do operador. 100% sintético: transportes e store
// injetados, sem rede, sem conta real, sem secret real.

// Credenciais OAuth SINTÉTICAS apenas para satisfazer o gate de configuração
// (o teste não toca a rede — transportes trocados por stubs).
process.env.GMAIL_OAUTH_CLIENT_ID = "client-sintetico.apps.googleusercontent.com";
process.env.GMAIL_OAUTH_CLIENT_SECRET = "secret-sintetico-nao-real";
process.env.GMAIL_OAUTH_REDIRECT_URI = "https://preview.exemplo.test/api/oauth/gmail/callback";
process.env.GMAIL_OAUTH_STATE_KEY = Buffer.from(new Uint8Array(32).fill(5)).toString("base64");
// Mesma chave do env acima: o signer do teste emite states que o módulo
// verifica (a instalação real deriva o signer do ambiente).
const signer = new OauthStateSigner(new Uint8Array(32).fill(5), 60_000);

/** Cofre sintético com a MESMA chave usada pelo START do teste. */
const caixa = new Aes256GcmSecretBox(new Uint8Array(32).fill(9), "v1");
const OPERADOR_HASH = hashOperadorGmail("token-operador-sintetico");

/**
 * F19 — Store de binding SINTÉTICA que implementa o MESMO contrato
 * persistido (OauthFlowBindingStore): registra hash+verifier cifrado,
 * distingue MISSING/EXPIRED/CONSUMED/REPLAY/SESSION_MISMATCH e permite
 * inspecionar consumos nos testes de ordem (state inválido NUNCA consome).
 */
function criarStoreSintetica() {
  const registros = new Map<
    string,
    { expiraEm: number; consumidaEm: number | null; operadorHash: string; verifierSealed: unknown }
  >();
  const consumos: ConsumeOauthFlowBindingCommand[] = [];
  return {
    registros,
    consumos,
    async registrarBindingOauthFlow(command: RegisterOauthFlowBindingCommand): Promise<void> {
      registros.set(command.nonceHash, {
        expiraEm: new Date(command.expiresAt).getTime(),
        consumidaEm: null,
        operadorHash: command.operadorHash,
        verifierSealed: command.codeVerifier,
      });
    },
    async consumirBindingOauthFlow(
      command: ConsumeOauthFlowBindingCommand,
    ): Promise<OauthFlowBindingConsumeResult> {
      consumos.push(command);
      const registro = registros.get(command.nonceHash);
      if (!registro) return { status: "MISSING" };
      const agoraMs = new Date(command.now).getTime();
      if (registro.consumidaEm !== null) return { status: "REPLAY" };
      if (registro.expiraEm <= agoraMs) return { status: "EXPIRED" };
      if (registro.operadorHash !== command.operadorHash) return { status: "SESSION_MISMATCH" };
      registro.consumidaEm = agoraMs;
      return { status: "CONSUMED", codeVerifierSealed: registro.verifierSealed as never };
    },
  };
}

const agora = new Date();

/** MESMA derivação do módulo: apenas o SHA-256 hex do nonce é persistido. */
function sha256Hex(valor: string): string {
  return createHash("sha256").update(valor, "utf8").digest("hex");
}

/**
 * FINAL CLOSURE GATE item 1 — o state carrega APENAS o nonce (opaco,
 * assinado). O verifier PKCE não existe mais no state/cookie.
 */
function estadoValido(): { state: string; nonce: string } {
  const nonce = `nonce-${Math.random().toString(36).slice(2)}-sintetico`;
  const { state } = signer.issue(agora, nonce);
  return { state, nonce };
}

/** Cookie do fluxo: <nonce>:<operadorHash> (HttpOnly, SameSite=Lax). */
function cookieValido(nonce: string): string {
  return `${nonce}:${OPERADOR_HASH}`;
}

describe("F19 — semântica real do binding one-time (MESMA store/persistência)", () => {
  it("nonce nunca registrado → MISSING", async () => {
    const store = criarStoreSintetica();
    expect(
      await store.consumirBindingOauthFlow({ nonceHash: "a".repeat(64), operadorHash: OPERADOR_HASH, now: agora.toISOString() }),
    ).toMatchObject({ status: "MISSING" });
  });

  it("nonce registrado e fora do TTL → EXPIRED (mesma store)", async () => {
    const store = criarStoreSintetica();
    await store.registrarBindingOauthFlow({
      nonceHash: "b".repeat(64),
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() - 1_000).toISOString(),
    });
    expect(
      await store.consumirBindingOauthFlow({ nonceHash: "b".repeat(64), operadorHash: OPERADOR_HASH, now: agora.toISOString() }),
    ).toMatchObject({ status: "EXPIRED" });
  });

  it("primeira tentativa válida → CONSUMED; segunda → REPLAY", async () => {
    const store = criarStoreSintetica();
    await store.registrarBindingOauthFlow({
      nonceHash: "c".repeat(64),
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() + 60_000).toISOString(),
    });
    expect(
      await store.consumirBindingOauthFlow({ nonceHash: "c".repeat(64), operadorHash: OPERADOR_HASH, now: agora.toISOString() }),
    ).toMatchObject({ status: "CONSUMED" });
    expect(
      await store.consumirBindingOauthFlow({ nonceHash: "c".repeat(64), operadorHash: OPERADOR_HASH, now: agora.toISOString() }),
    ).toMatchObject({ status: "REPLAY" });
  });
});

describe("F18 — ordem de validação do callback (nada é consumido antes da prova)", () => {
  it("state com assinatura inválida → STATE_INVALID e binding NÃO consumido", async () => {
    const store = criarStoreSintetica();
    const { state, nonce } = estadoValido();
    await store.registrarBindingOauthFlow({
      nonceHash: sha256Hex(nonce),
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() + 60_000).toISOString(),
    });
    const partes = state.split(".");
    const adulterado = `${partes[0]}.${partes[1]}.assinatura-falsa`;
    await expect(
      validarBindingState(cookieValido(nonce), adulterado, store, caixa, agora),
    ).rejects.toThrow(OauthFlowError);
    expect(store.consumos).toHaveLength(0);
  });

  it("cookie divergente do nonce do state → STATE_BINDING_MISMATCH e binding NÃO consumido", async () => {
    const store = criarStoreSintetica();
    const { state, nonce } = estadoValido();
    await store.registrarBindingOauthFlow({
      nonceHash: sha256Hex(nonce),
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() + 60_000).toISOString(),
    });
    await expect(
      validarBindingState(`cookie-divergente:${OPERADOR_HASH}`, state, store, caixa, agora),
    ).rejects.toThrow(/corresponde/i);
    expect(store.consumos).toHaveLength(0);
  });

  it("callback válido consome exatamente uma vez e devolve o verifier DO BANCO; replay → STATE_REPLAY", async () => {
    const store = criarStoreSintetica();
    const { state, nonce } = estadoValido();
    const nonceHash = sha256Hex(nonce);
    await store.registrarBindingOauthFlow({
      nonceHash,
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() + 60_000).toISOString(),
    });
    await expect(validarBindingState(cookieValido(nonce), state, store, caixa, agora)).resolves.toBe(
      "verificador-pkce-sintetico",
    );
    expect(store.consumos.map((c) => c.nonceHash)).toEqual([nonceHash]);
    await expect(validarBindingState(cookieValido(nonce), state, store, caixa, agora)).rejects.toThrow(
      /utilizado/i,
    );
    expect(store.consumos.map((c) => c.nonceHash)).toEqual([nonceHash, nonceHash]);
  });

  it("binding registrado mas expirado → STATE_EXPIRED (state ainda assinado/válido)", async () => {
    const store = criarStoreSintetica();
    const { state, nonce } = estadoValido();
    await store.registrarBindingOauthFlow({
      nonceHash: sha256Hex(nonce),
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() - 1_000).toISOString(),
    });
    await expect(validarBindingState(cookieValido(nonce), state, store, caixa, agora)).rejects.toThrow(
      /expirado/i,
    );
  });

  it("state nunca originado por START (nonce ausente no banco) → STATE_BINDING_MISSING", async () => {
    const store = criarStoreSintetica();
    const { state, nonce } = estadoValido();
    await expect(validarBindingState(cookieValido(nonce), state, store, caixa, agora)).rejects.toThrow(
      /originado/i,
    );
  });
});

describe("FINAL CLOSURE GATE item 1 — PKCE server-side", () => {
  it("state NÃO contém o code_verifier (nem fragmento dele)", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const store = criarStoreSintetica();
    const { url } = await iniciarFluxoOauth("https://preview.exemplo.test", store, agora, {
      caixa,
      operadorHash: OPERADOR_HASH,
    });
    const stateParam = new URL(url).searchParams.get("state") ?? "";
    // Nenhum fragmento do verifier persistido aparece no state.
    for (const [, registro] of store.registros) {
      const verifier = new TextDecoder().decode(caixa.open(registro.verifierSealed as never, "oauth:pkce"));
      expect(stateParam).not.toContain(verifier);
      expect(stateParam).not.toContain(verifier.slice(0, 12));
      // E o state não tem o formato payload_old <nonce>:<verifier>.
      expect(stateParam.split(".")[0]).not.toContain(":");
    }
    // O verifier não aparece na authorization URL em nenhum parâmetro.
    expect(url).not.toContain("code_verifier=");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("code_challenge_method=S256");
  });

  it("callback de operador divergente do START → SESSION_MISMATCH", async () => {
    const store = criarStoreSintetica();
    const { state, nonce } = estadoValido();
    await store.registrarBindingOauthFlow({
      nonceHash: sha256Hex(nonce),
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() + 60_000).toISOString(),
    });
    const outroOperador = `${nonce}:${hashOperadorGmail("outro-token")}`;
    await expect(validarBindingState(outroOperador, state, store, caixa, agora)).rejects.toThrow(
      /divergente|sessão/i,
    );
    // Binding NÃO consumido pela sessão divergente: o consumo foi tentado
    // exatamente uma vez e não marcou o registro.
    expect(store.consumos).toHaveLength(1);
    for (const registro of store.registros.values()) {
      expect(registro.consumidaEm).toBeNull();
    }
  });
});

describe("F18 — iniciarFluxoOauth registra binding persistido (hash, nunca nonce bruto)", () => {
  it("start registra SHA-256 do nonce e devolve o nonce para o cookie", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const store = criarStoreSintetica();
    const { url, bindingNonce } = await iniciarFluxoOauth("https://preview.exemplo.test", store, agora, {
      caixa,
      operadorHash: OPERADOR_HASH,
    });
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("state=");
    expect(store.registros.size).toBe(1);
    const [nonceHash] = store.registros.keys();
    expect(nonceHash).toMatch(/^[0-9a-f]{64}$/);
    // O nonce bruto NUNCA vai para a persistência — só o hash.
    const hashDoNonce = createHash("sha256").update(bindingNonce).digest("hex");
    expect(nonceHash).toBe(hashDoNonce);
  });
});

describe("F14 — identidade da conta Gmail verificada", () => {
  interface RepositorioFalso extends PostgresOperationalRepository {
    capturado: unknown;
  }

  function repoFalso(store = criarStoreSintetica()): RepositorioFalso {
    const repositorio: RepositorioFalso = {
      capturado: undefined,
      saveOauthConnection: async (x: unknown) => {
        repositorio.capturado = x;
      },
      // F18: o repositório operacional REAL implementa a OauthFlowBindingStore;
      // o fake delega para a MESMA store sintética dos testes de binding.
      registrarBindingOauthFlow: (c: RegisterOauthFlowBindingCommand) => store.registrarBindingOauthFlow(c),
      consumirBindingOauthFlow: (c: ConsumeOauthFlowBindingCommand) => store.consumirBindingOauthFlow(c),
    } as unknown as RepositorioFalso;
    return repositorio;
  }

  /** Registra o binding do nonce (como o START autenticado faria no banco). */
  async function registrarBinding(store: ReturnType<typeof criarStoreSintetica>, nonce: string): Promise<void> {
    await store.registrarBindingOauthFlow({
      nonceHash: sha256Hex(nonce),
      codeVerifier: caixa.seal("verificador-pkce-sintetico", "oauth:pkce"),
      operadorHash: OPERADOR_HASH,
      expiresAt: new Date(agora.getTime() + 60_000).toISOString(),
    });
  }

  it("concluirFluxoOauth sem GMAIL_EXPECTED_ACCOUNT falha fechado antes de persistir", async () => {
    const envAntes = process.env.GMAIL_EXPECTED_ACCOUNT;
    delete process.env.GMAIL_EXPECTED_ACCOUNT;
    const store = criarStoreSintetica();
    const repo = repoFalso(store);
    const { state, nonce } = estadoValido();
    await registrarBinding(store, nonce);
    await expect(
      concluirFluxoOauth(
        "code-sintetico",
        state,
        cookieValido(nonce),
        repo,
        caixa as never,
        { fingerprint: () => "fp-sintetico" } as never,
        new Date(),
        async () => ({ accessToken: "tok-sintetico", expiresIn: 3600 }),
        async () => ({ status: 200, json: async () => ({ sub: "sub-1", email: "carteiras@crtba.org.br", email_verified: true }) }),
      ),
    ).rejects.toThrow(/GMAIL_EXPECTED_ACCOUNT/);
    expect(repo.capturado).toBeUndefined();
    process.env.GMAIL_EXPECTED_ACCOUNT = envAntes;
  });

  it("conta autorizada divergente da esperada → BLOCKED_ACCOUNT_MISMATCH, sem persistir token", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const store = criarStoreSintetica();
    const repo = repoFalso(store);
    const { state, nonce } = estadoValido();
    await registrarBinding(store, nonce);
    await expect(
      concluirFluxoOauth(
        "code-sintetico",
        state,
        cookieValido(nonce),
        repo,
        caixa as never,
        { fingerprint: () => "fp-sintetico" } as never,
        new Date(),
        async () => ({ accessToken: "tok-sintetico", expiresIn: 3600, refreshToken: "refresh-sintetico" }),
        async () => ({ status: 200, json: async () => ({ sub: "sub-2", email: "outra.conta@evil.test", email_verified: true }) }),
      ),
    ).rejects.toThrow(/esperada/i);
    expect(repo.capturado).toBeUndefined();
  });

  it("email_verified falso → FAIL antes de persistir qualquer token", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const store = criarStoreSintetica();
    const repo = repoFalso(store);
    const { state, nonce } = estadoValido();
    await registrarBinding(store, nonce);
    await expect(
      concluirFluxoOauth(
        "code-sintetico",
        state,
        cookieValido(nonce),
        repo,
        caixa as never,
        { fingerprint: () => "fp-sintetico" } as never,
        new Date(),
        async () => ({ accessToken: "tok-sintetico", expiresIn: 3600 }),
        async () => ({ status: 200, json: async () => ({ sub: "sub-3", email: "carteiras@crtba.org.br", email_verified: false }) }),
      ),
    ).rejects.toThrow(/verificado/i);
    expect(repo.capturado).toBeUndefined();
  });

  it("identidade correta + verificação OK → persiste conexão com fingerprint da CONTA (não do clientId)", async () => {
    process.env.GMAIL_EXPECTED_ACCOUNT = "carteiras@crtba.org.br";
    const store = criarStoreSintetica();
    const repo = repoFalso(store);
    const fingerprintEsperado = `fp-${"f".repeat(4)}`;
    const { state, nonce } = estadoValido();
    await registrarBinding(store, nonce);
    const resultado = await concluirFluxoOauth(
      "code-sintetico",
      state,
      cookieValido(nonce),
      repo,
      caixa as never,
      { fingerprint: () => fingerprintEsperado } as never,
      new Date(),
      async () => ({ accessToken: "tok-sintetico", expiresIn: 3600, refreshToken: "refresh-sintetico" }),
      async () => ({ status: 200, json: async () => ({ sub: "sub-4", email: "Carteiras@CRTBA.org.br", email_verified: true }) }),
    );
    expect(resultado.status).toBe("CONNECTED");
    const persistido = repo.capturado as { connection?: { accountFingerprint?: string; accessToken?: string } } | null;
    expect(persistido).not.toBeNull();
    // Fingerprint da conta verificada (normalizada), NUNCA do clientId.
    expect(persistido?.connection?.accountFingerprint).toBe(fingerprintEsperado);
    // Tokens vão cifrados.
    expect(persistido?.connection?.accessToken).not.toBe("tok-sintetico");
  });
});

// Contrato do cookie mantido (F13): nome e semântica HttpOnly/SameSite=Lax.
describe("F13 — cookie de binding", () => {
  it("nome do cookie é o contrato estável do fluxo", () => {
    expect(OAUTH_BINDING_COOKIE).toBe("ic_oauth_binding");
  });
});
