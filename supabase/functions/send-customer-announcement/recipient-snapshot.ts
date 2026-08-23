export const MAX_CURRENT_RECIPIENTS = 1000;

export function isRecipientHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export async function hashRecipientPhones(phones: string[]) {
  const canonicalPhones = [...phones].sort().join(",");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalPhones),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
