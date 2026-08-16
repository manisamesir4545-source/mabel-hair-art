const TOKEN_VERSION = "v1";
const TOKEN_AUDIENCE = "customer-announcement";
const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 30 * 60;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 2048;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://mabelhairart.com.tr",
  "https://www.mabelhairart.com.tr",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const encoder = new TextEncoder();

type AdminSessionPayload = {
  v: 1;
  aud: typeof TOKEN_AUDIENCE;
  iat: number;
  exp: number;
  nonce: string;
};

function clampInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function allowedOrigins() {
  const configured = String(Deno.env.get("ADMIN_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set(configured.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

export function isAdminOriginAllowed(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || allowedOrigins().has(origin);
}

export function adminCorsHeaders(req: Request) {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-admin-session",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };

  if (origin && allowedOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

export function adminJson(
  req: Request,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: { ...adminCorsHeaders(req), ...extraHeaders },
  });
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function base64UrlToBytes(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function signingSecret() {
  const secret = Deno.env.get("ADMIN_SESSION_SECRET") || "";
  if (encoder.encode(secret).byteLength < 32) {
    throw new Error("ADMIN_SESSION_SECRET must contain at least 32 bytes");
  }
  return secret;
}

function hmacKey() {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(message: string) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(),
    encoder.encode(message),
  );
  return new Uint8Array(signature);
}

export async function verifyAdminPin(candidate: unknown) {
  const expected = Deno.env.get("ADMIN_PIN") || "";
  const supplied = typeof candidate === "string" ? candidate : "";
  if (!expected) throw new Error("ADMIN_PIN is not configured");

  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);

  const expectedBytes = new Uint8Array(expectedDigest);
  const suppliedBytes = new Uint8Array(suppliedDigest);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index] ^ suppliedBytes[index];
  }
  return difference === 0;
}

export async function createAdminSessionToken() {
  const issuedAt = Math.floor(Date.now() / 1000);
  const ttl = clampInteger(
    Deno.env.get("ADMIN_SESSION_TTL_SECONDS"),
    DEFAULT_TTL_SECONDS,
    60,
    MAX_TTL_SECONDS,
  );
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const payload: AdminSessionPayload = {
    v: 1,
    aud: TOKEN_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + ttl,
    nonce: bytesToBase64Url(nonceBytes),
  };
  const encodedPayload = bytesToBase64Url(
    encoder.encode(JSON.stringify(payload)),
  );
  const signedValue = `${TOKEN_VERSION}.${encodedPayload}`;
  const signature = bytesToBase64Url(await hmac(signedValue));

  return {
    token: `${signedValue}.${signature}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

function isStrictPayload(value: unknown): value is AdminSessionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort().join(",");
  return keys === "aud,exp,iat,nonce,v" &&
    payload.v === 1 &&
    payload.aud === TOKEN_AUDIENCE &&
    Number.isInteger(payload.iat) &&
    Number.isInteger(payload.exp) &&
    typeof payload.nonce === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(payload.nonce);
}

export async function verifyAdminSessionToken(token: string | null) {
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;

  try {
    const payloadBytes = base64UrlToBytes(parts[1]);
    const signatureBytes = base64UrlToBytes(parts[2]);
    if (signatureBytes.byteLength !== 32 || payloadBytes.byteLength > 512) {
      return false;
    }

    const signatureValid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
      signatureBytes,
      encoder.encode(`${TOKEN_VERSION}.${parts[1]}`),
    );
    if (!signatureValid) return false;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!isStrictPayload(payload)) return false;

    const now = Math.floor(Date.now() / 1000);
    return payload.iat <= now + CLOCK_SKEW_SECONDS &&
      payload.exp > now &&
      payload.exp > payload.iat &&
      payload.exp - payload.iat <= MAX_TTL_SECONDS;
  } catch {
    return false;
  }
}

function clientAddress(req: Request) {
  const direct = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip");
  if (direct) return direct.trim().slice(0, 128);
  const forwarded = req.headers.get("x-forwarded-for");
  return String(forwarded?.split(",")[0] || "unknown").trim().slice(0, 128);
}

export async function adminRateLimitKey(req: Request) {
  const digest = await hmac(`admin-login-rate:${clientAddress(req)}`);
  return `client:${bytesToBase64Url(digest.slice(0, 18))}`;
}

export function adminRateLimitSettings() {
  return {
    clientMaxAttempts: clampInteger(
      Deno.env.get("ADMIN_LOGIN_MAX_ATTEMPTS"),
      5,
      2,
      20,
    ),
    globalMaxAttempts: clampInteger(
      Deno.env.get("ADMIN_LOGIN_GLOBAL_MAX_ATTEMPTS"),
      50,
      10,
      500,
    ),
    windowSeconds: clampInteger(
      Deno.env.get("ADMIN_LOGIN_WINDOW_SECONDS"),
      15 * 60,
      60,
      60 * 60,
    ),
  };
}
