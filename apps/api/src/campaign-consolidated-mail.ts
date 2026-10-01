/**
 * GF5.1 — CAMPAIGN → CONSOLIDATED MAIL PLATFORM INTEGRATION SEAM.
 *
 * ÚNICO ponto de composição entre a execução da Campanha PF e a plataforma
 * de e-mail CONSOLIDADA do repositório. Este módulo NÃO implementa Gmail,
 * NÃO implementa OAuth, NÃO implementa refresh de token e NÃO implementa
 * transporte HTTP — ele COMBINA exclusivamente primitivas canônicas:
 *
 *   · `criarCampanhaGmailRuntime` (campaign-gmail-runtime.ts) — composição
 *     canônica de runtime: loadGmailOauthConfig + fingerprint de conta +
 *     PostgresOperationalRepository (oauth_connection) + Aes256GcmSecretBox
 *     (decrypt/refresh cifrado) + GmailHttpTransport;
 *   · `GmailMailGateway` (packages/mail) — gateway canônico consolidado
 *     (contrato MailGateway: send/getStatus), com a taxonomia de erros
 *     Gmail* de packages/mail;
 *   · `ProvedorGmailCampanha` (campaign-canary.ts) — provider canônico da
 *     campanha (render do snapshot congelado + template registrado +
 *     classificação de erros → ResultadoProvedorCampanha, AUTO_RETRY=false).
 *
 * Anti-duplicação (GF5.1): NENHUMA segunda implementação de transporte,
 * OAuth, refresh, seletor de provider ou outbox executável paralela. O
 * worker consolidado (apps/worker/src/outbox.ts) permanece a autoridade da
 * outbox_email do piloto; outbox_campanha permanece a ÚNICA fila executável
 * da campanha — nenhum item de campanha é materializado em outbox_email.
 *
 * Autoridade da campanha preservada: o caminho de execução NUNCA bypassa
 * executeAttemptCampanha() → ProvedorEnvioCampanha. Este seam apenas monta
 * o provider sobre a plataforma consolidada. O MESMO adapter (um runtime +
 * um gateway compartilhados) serve o canário e o futuro lote — convergência
 * de transporte canário/lote ANTES do Gmail.
 *
 * BATCH (contrato CONGELADO — NÃO implementado neste gate): um campanhaId,
 * lote ATIVO resolvido server-side, itens PREPARADO em ordem
 * outbox_campanha.ordem ASC, execução sequencial via executeAttemptCampanha,
 * item ENVIADO excluído automaticamente, corpo do cliente { campanhaId } e
 * NADA mais, sem paralelismo/cron/scheduler/retry automático.
 *
 * STRICT ZERO SEND: nenhuma chamada de rede é feita por este módulo; o envio
 * real continua fail-closed pelas políticas de produção (flags ausentes ou
 * false) e exige adjudicação própria do owner.
 */
import {
  GmailMailGateway,
  type GmailOauthConfig,
  type MailReceipt,
  type OutboundMail,
} from "@integra-correios/mail";
import type { SqlPool } from "@integra-correios/persistence";
import { criarCampanhaGmailRuntime } from "./campaign-gmail-runtime.js";
import { ProvedorGmailCampanha } from "./campaign-canary.js";

/** Ambiente de leitura leve (mesma forma das fronteiras existentes). */
type AmbienteLeve = Readonly<Record<string, string | undefined>>;

export interface DependenciasConsolidatedMailAdapter {
  /** Ambiente para loadGmailOauthConfig/conta esperada/chaves (NUNCA do browser). */
  readonly env: AmbienteLeve;
  /** Pool canônico (oauth_connection + tabelas de campanha). */
  readonly pool: SqlPool;
  /** Porta de transporte injetável (testes usam fake; default = GmailHttpTransport canônico). */
  readonly portaTransporte?: (message: OutboundMail, accessToken: string) => Promise<MailReceipt>;
  /** Porta de refresh injetável (testes usam fake; default = GmailHttpTransport canônico). */
  readonly portaRefresh?: (
    config: GmailOauthConfig,
    refreshToken: string,
  ) => Promise<{ access_token: string; expires_in: number }>;
}

export interface ConsolidatedMailAdapter {
  /**
   * Provider canônico da campanha (ProvedorEnvioCampanha) montado sobre a
   * plataforma de e-mail consolidada, vinculado ao campanhaId da execução.
   * Todos os providers criados por ESTE adapter compartilham o MESMO runtime
   * (token resolver + transporte) e o MESMO gateway — canário e futuro lote
   * convergem aqui, sem segunda implementação de rede.
   */
  readonly provedorParaCampanha: (campanhaId: string) => ProvedorGmailCampanha;
  /** Runtime canônico subjacente (token resolver + transporte + métricas). */
  readonly runtime: ReturnType<typeof criarCampanhaGmailRuntime>;
  /** Instrumentação read-only para testes (contadores compartilhados). */
  readonly metricas: {
    readonly gatewayConcretizado: () => boolean;
    readonly chamadasTransporte: () => number;
    readonly leiturasConexao: () => number;
    readonly refreshes: () => number;
  };
}

/**
 * Monta o SEAM canônico campanha → plataforma de e-mail consolidada:
 * campaign provider/adapter → runtime OAuth/transport canônico →
 * GmailMailGateway. Fail-closed: sem OAuth config/conta esperada/chaves o
 * resolver de token retorna undefined e o provider classifica
 * TOKEN_RESOLUTION_INDISPONIVEL (FALHA_PRE_PROVIDER) — nunca rede, nunca
 * segredo exposto, nunca segundo Gmail.
 */
export function montarConsolidatedMailAdapter(
  dependencias: DependenciasConsolidatedMailAdapter,
): ConsolidatedMailAdapter {
  const runtime = criarCampanhaGmailRuntime({
    env: dependencias.env,
    pool: dependencias.pool,
    ...(dependencias.portaTransporte ? { portaTransporte: dependencias.portaTransporte } : {}),
    ...(dependencias.portaRefresh ? { portaRefresh: dependencias.portaRefresh } : {}),
  });

  let gatewayConcretizado = false;
  // Lazy e ÚNICO: o GmailMailGateway é construído no primeiro envio armado
  // (executeAttemptCampanha → provider.enviar) e REUTILIZADO por todos os
  // providers deste adapter — nenhuma construção em caminhos read-only.
  let gateway: GmailMailGateway | undefined;
  const obterGateway = (): GmailMailGateway => {
    if (!gateway) {
      gatewayConcretizado = true;
      gateway = new GmailMailGateway(
        runtime.transport,
        runtime.loadAccessToken,
        undefined,
        dependencias.env,
      );
    }
    return gateway;
  };

  return {
    provedorParaCampanha: (campanhaId: string) =>
      new ProvedorGmailCampanha({
        pool: dependencias.pool,
        campanhaId,
        get gateway() {
          return obterGateway();
        },
      }),
    runtime,
    metricas: {
      gatewayConcretizado: () => gatewayConcretizado,
      chamadasTransporte: runtime.metricas.chamadasTransporte,
      leiturasConexao: runtime.metricas.leiturasConexao,
      refreshes: runtime.metricas.refreshes,
    },
  };
}

/**
 * Contrato CONGELADO do futuro lote controlado (GF5.2) — definido aqui para
 * que canário e lote convirjam no MESMO seam antes do Gmail. NADA é
 * implementado/executado neste gate: sem rota, sem loop, sem paralelismo,
 * sem retry, sem scheduler.
 */
export interface ContratoBatchFuturo {
  /** Corpo do cliente: EXATAMENTE este campo e nada mais. */
  readonly corpo: { readonly campanhaId: string };
  /** Pré-condições server-side obrigatórias (nenhuma autoridade do browser). */
  readonly precondicoes: {
    readonly loteEstado: "ATIVO";
    readonly itensSomente: "PREPARADO";
    readonly ordem: "outbox_campanha.ordem ASC";
    readonly execucao: "sequencial via executeAttemptCampanha()";
    readonly excluidos: "itens ENVIADO (terminal) não reclamáveis";
    readonly paralelismo: false;
    readonly cronOuScheduler: false;
    readonly retryAutomatico: false;
  };
}
