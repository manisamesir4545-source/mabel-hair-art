import {
  adminCorsHeaders,
  createAdminSessionToken,
  isAdminOriginAllowed,
  verifyAdminPin,
  verifyAdminSessionToken,
} from "./admin-session.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("admin session signs and verifies only untampered short-lived tokens", async () => {
  Deno.env.set(
    "ADMIN_SESSION_SECRET",
    "test-only-secret-with-more-than-thirty-two-bytes",
  );
  Deno.env.set("ADMIN_SESSION_TTL_SECONDS", "600");

  const session = await createAdminSessionToken();
  assert(
    await verifyAdminSessionToken(session.token),
    "fresh token should verify",
  );
  assert(session.expiresAt.endsWith("Z"), "expiry should be an ISO timestamp");

  const tampered = `${session.token.slice(0, -1)}${
    session.token.endsWith("a") ? "b" : "a"
  }`;
  assert(
    !await verifyAdminSessionToken(tampered),
    "tampered token must fail verification",
  );
  assert(
    !await verifyAdminSessionToken("v1.invalid.invalid"),
    "malformed token must fail verification",
  );
});

Deno.test("admin PIN comparison accepts only the configured server-side value", async () => {
  Deno.env.set("ADMIN_PIN", "test-only-admin-pin");
  assert(
    await verifyAdminPin("test-only-admin-pin"),
    "configured PIN should verify",
  );
  assert(
    !await verifyAdminPin("wrong-pin"),
    "wrong PIN must fail verification",
  );
});

Deno.test("admin CORS is an explicit allowlist and permits the session header", () => {
  Deno.env.set("ADMIN_ALLOWED_ORIGINS", "https://mabelhairart.com.tr");
  const allowedRequest = new Request("https://edge.example.test", {
    headers: { Origin: "https://mabelhairart.com.tr" },
  });
  const deniedRequest = new Request("https://edge.example.test", {
    headers: { Origin: "https://evil.example" },
  });

  assert(
    isAdminOriginAllowed(allowedRequest),
    "configured origin should be allowed",
  );
  assert(
    !isAdminOriginAllowed(deniedRequest),
    "unknown origin should be denied",
  );
  const headers = adminCorsHeaders(allowedRequest);
  assert(
    headers["Access-Control-Allow-Headers"].includes("x-admin-session"),
    "preflight should allow x-admin-session",
  );
  assert(
    headers["Access-Control-Allow-Origin"] === "https://mabelhairart.com.tr",
    "allowed origin should be echoed exactly",
  );
});
