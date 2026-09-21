export { despachar } from "./server.js";

import { ORIGENS } from "@integra-correios/domain";

export interface HealthResponse {
  readonly status: "ok";
  readonly service: "integra-correios-api";
  readonly version: string;
  readonly dataAccess: "disabled";
  readonly ppnNetwork: "disabled";
  readonly origins: typeof ORIGENS;
}

export function health(): HealthResponse {
  return {
    status: "ok",
    service: "integra-correios-api",
    version: "2.0.0-alpha.1",
    dataAccess: "disabled",
    ppnNetwork: "disabled",
    origins: ORIGENS,
  };
}
