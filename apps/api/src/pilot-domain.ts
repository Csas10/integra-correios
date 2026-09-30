/**
 * Constante compartilhada de segregação de domínio (SLICE-03A.1).
 *
 * Módulo NEUTRO — sem dependências de runtime — para que a fundação de
 * execução da Campanha PF reconheça o código reservado do piloto sem
 * importar apps/api/src/pilot.ts (que carrega OAuth, gateway e fluxo de
 * envio do piloto). Nenhum literal duplicado: única fonte de verdade.
 */

/**
 * Código de lote RESERVADO ao piloto Gmail controlado. Qualquer uso fora do
 * piloto é rejeitado — em especial pelo domínio de execução da Campanha PF.
 */
export const RESERVED_PILOT_BATCH_CODE = "CONTROLLED_GMAIL_TEST" as const;
