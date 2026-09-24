export type CampaignLogoutDisposition = "SIGNED_OUT" | "UNKNOWN";

export function campaignLogoutDisposition(status: number): CampaignLogoutDisposition {
  if (status === 401) return "SIGNED_OUT";
  if (status >= 200 && status < 300) return "SIGNED_OUT";
  return "UNKNOWN";
}
