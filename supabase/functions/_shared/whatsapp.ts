import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") || "v25.0";
const LANGUAGE_CODE = Deno.env.get("WHATSAPP_TEMPLATE_LANGUAGE") || "tr";
const META_REQUEST_TIMEOUT_MS = 20_000;

export type AppointmentPayload = {
  id?: string | number | null;
  customerName?: string;
  phone?: string;
  serviceId?: string;
  serviceName?: string;
  staffId?: string;
  staffKey?: string;
  staffName?: string;
  date?: string;
  time?: string;
};

export function getServiceRoleKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeys) return "";

  try {
    return JSON.parse(secretKeys).default || "";
  } catch {
    return "";
  }
}

export function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = getServiceRoleKey();
  if (!url || !key) return null;
  return createClient(url, key);
}

export function normalizePhone(phone?: string) {
  let value = String(phone || "").replace(/[^0-9]/g, "");
  if (value.startsWith("00")) value = value.slice(2);
  if (value.startsWith("0")) value = `9${value}`;
  if (value.startsWith("5")) value = `90${value}`;
  return value;
}

export function prettyDate(iso?: string) {
  if (!iso) return "";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function templateNameFor(event: string) {
  const defaults: Record<string, string> = {
    appointment_created: "appointment_confirmed",
    appointment_reminder: "appointment_reminder",
    appointment_cancelled: "appointment_cancelled",
    admin_new_appointment: "admin_new_appointment",
  };

  const envKey = `WHATSAPP_TEMPLATE_${event.toUpperCase()}`;
  return Deno.env.get(envKey) || defaults[event];
}

export function customerTemplateParams(appointment: AppointmentPayload) {
  return [
    appointment.customerName || "Musterimiz",
    prettyDate(appointment.date),
    appointment.time || "",
    appointment.serviceName || "Randevu",
  ];
}

export function adminTemplateParams(appointment: AppointmentPayload) {
  return [
    appointment.customerName || "Musteri",
    prettyDate(appointment.date),
    appointment.time || "",
    appointment.serviceName || "Randevu",
    normalizePhone(appointment.phone),
  ];
}

export type WhatsAppTemplateApproval = {
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: unknown[];
  checkedAt: string;
};

type WhatsAppTemplateApiResult = {
  data?: Array<Record<string, unknown>>;
  paging?: { next?: string };
  error?: { message?: string };
};

export async function getTemplateApproval(
  templateName: string,
): Promise<WhatsAppTemplateApproval> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const businessAccountId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
  if (!token || !businessAccountId) {
    throw new Error(
      "WhatsApp secrets missing: WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID",
    );
  }
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
    throw new Error("Invalid WhatsApp template name");
  }

  const firstUrl = new URL(
    `https://graph.facebook.com/${GRAPH_VERSION}/${businessAccountId}/message_templates`,
  );
  firstUrl.searchParams.set("name", templateName);
  firstUrl.searchParams.set(
    "fields",
    "name,status,language,category,components",
  );
  firstUrl.searchParams.set("limit", "100");

  let nextUrl: URL | null = firstUrl;
  for (let page = 0; nextUrl && page < 10; page += 1) {
    const response: Response = await fetch(nextUrl.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
    });
    const result: WhatsAppTemplateApiResult = await response.json().catch(
      () => ({}),
    );
    if (!response.ok) {
      throw new Error(
        result?.error?.message ||
          `WhatsApp template API error: ${response.status}`,
      );
    }

    const templates = Array.isArray(result?.data) ? result.data : [];
    const matchingTemplate = templates.find((
      template: Record<string, unknown>,
    ) =>
      template?.name === templateName && template?.language === LANGUAGE_CODE
    );
    if (matchingTemplate) {
      return {
        name: templateName,
        language: LANGUAGE_CODE,
        status: String(matchingTemplate.status || "UNKNOWN").toUpperCase(),
        category: matchingTemplate.category
          ? String(matchingTemplate.category).toUpperCase()
          : null,
        components: Array.isArray(matchingTemplate.components)
          ? matchingTemplate.components
          : [],
        checkedAt: new Date().toISOString(),
      };
    }

    const candidate: string = typeof result.paging?.next === "string"
      ? result.paging.next
      : "";
    if (!candidate) break;
    const parsed: URL = new URL(candidate);
    nextUrl =
      parsed.protocol === "https:" && parsed.hostname === "graph.facebook.com"
        ? parsed
        : null;
  }

  return {
    name: templateName,
    language: LANGUAGE_CODE,
    status: "NOT_FOUND",
    category: null,
    components: [],
    checkedAt: new Date().toISOString(),
  };
}

export async function sendTemplateMessage(
  to: string,
  templateName: string,
  params: string[],
) {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

  if (!token || !phoneNumberId) {
    throw new Error(
      "WhatsApp secrets missing: WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID",
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: normalizePhone(to),
        type: "template",
        template: {
          name: templateName,
          language: { code: LANGUAGE_CODE },
          components: [
            {
              type: "body",
              parameters: params.map((text) => ({
                type: "text",
                text: String(text || "-"),
              })),
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
    },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result?.error?.message || `WhatsApp API error: ${response.status}`,
    );
  }

  return result;
}

export async function logMessage(input: {
  appointmentId?: string | number | null;
  event: string;
  phone?: string;
  templateName?: string;
  status: "sent" | "failed" | "skipped";
  response?: unknown;
  error?: string;
  dedupeKey?: string;
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  await supabase.from("message_logs").insert({
    appointment_id: input.appointmentId || null,
    event: input.event,
    phone: normalizePhone(input.phone),
    template_name: input.templateName || null,
    status: input.status,
    provider_response: input.response || null,
    error_message: input.error || null,
    dedupe_key: input.dedupeKey || null,
  });
}
