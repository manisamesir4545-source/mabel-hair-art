import { createClient } from "@supabase/supabase-js";

const MAX_BODY_BYTES = 1_048_576;
const MAX_ENTRIES = 100;
const MAX_CHANGES_PER_ENTRY = 100;
const MAX_STATUSES_PER_CHANGE = 1_000;
const MAX_STATUS_EVENTS = 1_000;
const RPC_BATCH_SIZE = 20;
const encoder = new TextEncoder();

const responseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

const webhookStatuses = new Set([
  "sent",
  "delivered",
  "read",
  "failed",
  "deleted",
]);

type JsonRecord = Record<string, unknown>;

export type WhatsAppStatusEvent = {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed" | "deleted";
  eventAt: string;
  errorCode: string | null;
  errorTitle: string | null;
  errorMessage: string | null;
};

export class InvalidWebhookPayloadError extends Error {}
export class PhoneNumberMismatchError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: JsonRecord, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

function toArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isControlCharacter(character: string) {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
}

function containsControlCharacter(value: string) {
  return [...value].some(isControlCharacter);
}

function replaceControlCharacters(value: string) {
  return [...value]
    .map((character) => isControlCharacter(character) ? " " : character)
    .join("");
}

export function constantTimeEqualText(left: string, right: string) {
  return constantTimeEqual(encoder.encode(left), encoder.encode(right));
}

function decodeHex(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

export async function verifyMetaSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  appSecret: string,
) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader || "");
  if (!match || !appSecret) return false;

  const receivedSignature = decodeHex(match[1]);
  if (!receivedSignature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedSignature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, toArrayBuffer(rawBody)),
  );

  return constantTimeEqual(expectedSignature, receivedSignature);
}

function sanitizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const sanitized = replaceControlCharacters(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return sanitized || null;
}

function sanitizeErrorCode(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const sanitized = String(value).replace(/[^0-9A-Za-z_.:-]/g, "").slice(0, 64);
  return sanitized || null;
}

function normalizeProviderMessageId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 512 ||
    /\s/u.test(normalized) ||
    containsControlCharacter(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseEventTimestamp(value: unknown) {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^\d{9,12}$/.test(raw)) return null;

  const seconds = Number(raw);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 946_684_800 ||
    seconds > nowSeconds + 86_400
  ) {
    return null;
  }

  return new Date(seconds * 1_000).toISOString();
}

function extractFailure(status: JsonRecord) {
  if (status.status !== "failed" || !Array.isArray(status.errors)) {
    return { errorCode: null, errorTitle: null, errorMessage: null };
  }

  const firstError = status.errors.find(isRecord);
  if (!firstError) {
    return { errorCode: null, errorTitle: null, errorMessage: null };
  }

  const errorData = isRecord(firstError.error_data)
    ? firstError.error_data
    : null;

  return {
    errorCode: sanitizeErrorCode(firstError.code),
    errorTitle: sanitizeText(firstError.title, 256),
    errorMessage: sanitizeText(
      firstError.message ?? errorData?.details,
      1_000,
    ),
  };
}

export function extractStatusEvents(
  payload: unknown,
  expectedPhoneNumberId: string,
) {
  if (!isRecord(payload)) {
    throw new InvalidWebhookPayloadError("payload must be an object");
  }

  if (payload.object !== "whatsapp_business_account") {
    return { events: [] as WhatsAppStatusEvent[], ignored: 0 };
  }

  if (!Array.isArray(payload.entry)) {
    throw new InvalidWebhookPayloadError("entry must be an array");
  }
  if (payload.entry.length > MAX_ENTRIES) {
    throw new InvalidWebhookPayloadError("too many entries");
  }

  const events: WhatsAppStatusEvent[] = [];
  let ignored = 0;

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) {
      ignored += 1;
      continue;
    }
    if (entry.changes.length > MAX_CHANGES_PER_ENTRY) {
      throw new InvalidWebhookPayloadError("too many changes");
    }

    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages") {
        ignored += 1;
        continue;
      }

      const value = isRecord(change.value) ? change.value : null;
      if (!value || value.messaging_product !== "whatsapp") {
        ignored += 1;
        continue;
      }

      if (!Array.isArray(value.statuses) || value.statuses.length === 0) {
        ignored += 1;
        continue;
      }
      if (value.statuses.length > MAX_STATUSES_PER_CHANGE) {
        throw new InvalidWebhookPayloadError("too many statuses");
      }

      const metadata = isRecord(value.metadata) ? value.metadata : null;
      if (metadata?.phone_number_id !== expectedPhoneNumberId) {
        throw new PhoneNumberMismatchError("phone number id mismatch");
      }

      for (const rawStatus of value.statuses) {
        if (!isRecord(rawStatus)) {
          ignored += 1;
          continue;
        }

        const providerMessageId = normalizeProviderMessageId(rawStatus.id);
        const status = typeof rawStatus.status === "string"
          ? rawStatus.status.toLowerCase()
          : "";
        const eventAt = parseEventTimestamp(rawStatus.timestamp);

        if (!providerMessageId || !webhookStatuses.has(status) || !eventAt) {
          ignored += 1;
          continue;
        }

        const failure = extractFailure(rawStatus);
        events.push({
          providerMessageId,
          status: status as WhatsAppStatusEvent["status"],
          eventAt,
          ...failure,
        });
        if (events.length > MAX_STATUS_EVENTS) {
          throw new InvalidWebhookPayloadError("too many status events");
        }
      }
    }
  }

  const uniqueEvents = new Map<string, WhatsAppStatusEvent>();
  for (const event of events) {
    const key =
      `${event.providerMessageId}\u0000${event.status}\u0000${event.eventAt}`;
    if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
  }

  return {
    events: [...uniqueEvents.values()],
    ignored: ignored + events.length - uniqueEvents.size,
  };
}

function getServiceRoleKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeys) return "";

  try {
    const parsed = JSON.parse(secretKeys);
    return isRecord(parsed) && typeof parsed.default === "string"
      ? parsed.default
      : "";
  } catch {
    return "";
  }
}

async function recordEvents(events: WhatsAppStatusEvent[]) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = getServiceRoleKey();
  if (!/^https:\/\/[^\s]+$/.test(supabaseUrl) || !serviceRoleKey) {
    throw new Error("webhook storage is not configured");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  let matched = 0;
  for (let offset = 0; offset < events.length; offset += RPC_BATCH_SIZE) {
    const batch = events.slice(offset, offset + RPC_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((event) =>
        supabase.rpc("record_whatsapp_status_event", {
          p_provider_message_id: event.providerMessageId,
          p_status: event.status,
          p_event_at: event.eventAt,
          p_error_code: event.errorCode,
          p_error_title: event.errorTitle,
          p_error_message: event.errorMessage,
        })
      ),
    );

    for (const result of results) {
      if (result.error) throw new Error("delivery event storage failed");
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (isRecord(row) && row.matched === true) matched += 1;
    }
  }

  return matched;
}

function handleVerification(req: Request) {
  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") || "";
  if (!verifyToken) {
    return jsonResponse({ ok: false, error: "webhook_not_configured" }, 503);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode") || "";
  const suppliedToken = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";

  if (
    mode !== "subscribe" ||
    !challenge ||
    challenge.length > 256 ||
    containsControlCharacter(challenge) ||
    !constantTimeEqualText(suppliedToken, verifyToken)
  ) {
    return jsonResponse({ ok: false, error: "forbidden" }, 403);
  }

  return new Response(challenge, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleNotification(req: Request) {
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") || "";
  const expectedPhoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "";
  if (!appSecret || !/^\d{5,32}$/.test(expectedPhoneNumberId)) {
    return jsonResponse({ ok: false, error: "webhook_not_configured" }, 503);
  }

  const contentType = req.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return jsonResponse({ ok: false, error: "unsupported_media_type" }, 415);
  }

  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }

  const rawBody = new Uint8Array(await req.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }

  const signatureIsValid = await verifyMetaSignature(
    rawBody,
    req.headers.get("x-hub-signature-256"),
    appSecret,
  );
  if (!signatureIsValid) {
    return jsonResponse({ ok: false, error: "invalid_signature" }, 401);
  }

  let payload: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
  }

  try {
    const { events, ignored } = extractStatusEvents(
      payload,
      expectedPhoneNumberId,
    );
    const matched = events.length > 0 ? await recordEvents(events) : 0;

    return jsonResponse({
      ok: true,
      processed: events.length,
      matched,
      ignored,
    });
  } catch (error) {
    if (error instanceof PhoneNumberMismatchError) {
      return jsonResponse({ ok: false, error: "forbidden" }, 403);
    }
    if (error instanceof InvalidWebhookPayloadError) {
      return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
    }
    return jsonResponse({ ok: false, error: "temporary_failure" }, 500);
  }
}

export async function handler(req: Request) {
  if (req.method === "GET") return await handleVerification(req);
  if (req.method === "POST") return await handleNotification(req);

  return new Response(null, {
    status: 405,
    headers: {
      ...responseHeaders,
      Allow: "GET, POST",
    },
  });
}

if (import.meta.main) {
  Deno.serve(handler);
}
