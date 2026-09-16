function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Token(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createWebTokenService(): import("./model.js").TokenService {
  return {
    async issue() {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      const plainToken = bytesToBase64Url(bytes);
      return { plainToken, tokenHash: await sha256Token(plainToken) };
    },
    hash: sha256Token,
  };
}
