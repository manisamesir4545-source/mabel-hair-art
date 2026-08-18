import {
  extractStatusEvents,
  PhoneNumberMismatchError,
  verifyMetaSignature,
} from "./index.ts";

const encoder = new TextEncoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function signatureFor(body: Uint8Array, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, bodyBuffer),
  );
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

Deno.test("validates the Meta signature against the original bytes", async () => {
  const secret = "test-app-secret";
  const body = encoder.encode('{"unicode":"\\u00e7"}');
  const signature = await signatureFor(body, secret);

  assert(
    await verifyMetaSignature(body, signature, secret),
    "expected a valid signature",
  );
  assert(
    !await verifyMetaSignature(encoder.encode("{}"), signature, secret),
    "a changed body must not validate",
  );
});

Deno.test("extracts only delivery statuses for the configured phone number", () => {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const result = extractStatusEvents({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "1159594253901556" },
          statuses: [
            { id: "wamid.test-1", status: "read", timestamp },
            { id: "wamid.test-1", status: "sent", timestamp },
            { id: "wamid.test-1", status: "sent", timestamp },
            { id: "wamid.test-1", status: "deleted", timestamp },
          ],
          messages: [{ from: "905000000000" }],
        },
      }],
    }],
  }, "1159594253901556");

  assert(result.events.length === 3, "duplicate status events must collapse");
  assert(result.events[0].status === "read", "read status should be retained");
  assert(result.events[1].status === "sent", "sent status should be retained");
  assert(
    result.events[2].status === "deleted",
    "deleted status should be retained",
  );
  assert(result.ignored === 1, "the duplicate should be counted as ignored");
});

Deno.test("rejects status payloads for a different phone number id", () => {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  let rejected = false;

  try {
    extractStatusEvents({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "999999" },
            statuses: [{ id: "wamid.test-2", status: "sent", timestamp }],
          },
        }],
      }],
    }, "1159594253901556");
  } catch (error) {
    rejected = error instanceof PhoneNumberMismatchError;
  }

  assert(rejected, "a mismatched phone number id must be rejected");
});

Deno.test("bounds and strips control characters from failure details", () => {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const result = extractStatusEvents({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "1159594253901556" },
          statuses: [{
            id: "wamid.test-3",
            status: "failed",
            timestamp,
            errors: [{
              code: "131047<script>",
              title: "Delivery\nfailed",
              message: `Reason\u0000${"x".repeat(2_000)}`,
            }],
          }],
        },
      }],
    }],
  }, "1159594253901556");

  const event = result.events[0];
  assert(
    event.errorCode === "131047script",
    "error code should be allow-listed",
  );
  assert(
    event.errorTitle === "Delivery failed",
    "controls should become spaces",
  );
  assert(
    event.errorMessage?.length === 1_000,
    "error message should be bounded",
  );
  assert(!event.errorMessage?.includes("\u0000"), "controls must be removed");
});
