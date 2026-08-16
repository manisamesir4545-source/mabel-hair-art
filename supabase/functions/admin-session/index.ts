import {
  adminCorsHeaders,
  adminJson,
  adminRateLimitKey,
  adminRateLimitSettings,
  createAdminSessionToken,
  isAdminOriginAllowed,
  verifyAdminPin,
} from "../_shared/admin-session.ts";
import { getSupabaseAdmin } from "../_shared/whatsapp.ts";

const MAX_BODY_LENGTH = 2048;

type RateLimitResult = {
  allowed: boolean;
  retry_after_seconds: number;
};

async function consumeAttempt(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  attemptKey: string,
  maxAttempts: number,
  windowSeconds: number,
) {
  const { data, error } = await supabase.rpc("consume_admin_session_attempt", {
    p_attempt_key: attemptKey,
    p_max_attempts: maxAttempts,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as RateLimitResult | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    if (!isAdminOriginAllowed(req)) {
      return new Response(null, {
        status: 403,
        headers: adminCorsHeaders(req),
      });
    }
    return new Response(null, { status: 204, headers: adminCorsHeaders(req) });
  }

  if (!isAdminOriginAllowed(req)) {
    return adminJson(req, {
      ok: false,
      error: "İstek kaynağına izin verilmiyor.",
    }, 403);
  }
  if (req.method !== "POST") {
    return adminJson(
      req,
      { ok: false, error: "Yönteme izin verilmiyor." },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  try {
    const contentLength = Number(req.headers.get("content-length") || "0");
    if (contentLength > MAX_BODY_LENGTH) {
      return adminJson(req, { ok: false, error: "Giriş doğrulanamadı." }, 400);
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error("Supabase service role secret missing");

    const settings = adminRateLimitSettings();
    const clientKey = await adminRateLimitKey(req);
    const [clientLimit, globalLimit] = await Promise.all([
      consumeAttempt(
        supabase,
        clientKey,
        settings.clientMaxAttempts,
        settings.windowSeconds,
      ),
      consumeAttempt(
        supabase,
        "global",
        settings.globalMaxAttempts,
        settings.windowSeconds,
      ),
    ]);

    if (!clientLimit?.allowed || !globalLimit?.allowed) {
      const retryAfter = Math.max(
        Number(clientLimit?.retry_after_seconds || 0),
        Number(globalLimit?.retry_after_seconds || 0),
        1,
      );
      return adminJson(
        req,
        { ok: false, error: "Giriş doğrulanamadı." },
        429,
        { "Retry-After": String(retryAfter) },
      );
    }

    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_LENGTH) {
      return adminJson(req, { ok: false, error: "Giriş doğrulanamadı." }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return adminJson(req, { ok: false, error: "Giriş doğrulanamadı." }, 400);
    }

    if (
      !body || Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "pin" ||
      typeof body.pin !== "string" || body.pin.length > 128
    ) {
      return adminJson(req, { ok: false, error: "Giriş doğrulanamadı." }, 400);
    }

    if (!await verifyAdminPin(body.pin)) {
      return adminJson(req, { ok: false, error: "Giriş doğrulanamadı." }, 401);
    }

    const [clearClient, clearGlobal] = await Promise.all([
      supabase.rpc("clear_admin_session_attempt", { p_attempt_key: clientKey }),
      supabase.rpc("clear_admin_session_attempt", { p_attempt_key: "global" }),
    ]);
    if (clearClient.error) throw clearClient.error;
    if (clearGlobal.error) throw clearGlobal.error;

    const session = await createAdminSessionToken();
    return adminJson(req, { ok: true, ...session });
  } catch (error) {
    console.error(
      "admin-session failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return adminJson(req, {
      ok: false,
      error: "Giriş hizmeti şu anda kullanılamıyor.",
    }, 503);
  }
});
