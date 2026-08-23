import type { WhatsAppTemplateApproval } from "../_shared/whatsapp.ts";

export const ANNOUNCEMENT_SERIES_ID = "mabel_is_yeri_adres_guncellemesi_v1";
export const ANNOUNCEMENT_TEMPLATE_NAME = "is_yeri_adres_guncellemesi";
export const ANNOUNCEMENT_TEMPLATE_LANGUAGE = "tr";
export const ANNOUNCEMENT_TEMPLATE_CATEGORY = "UTILITY";
export const ANNOUNCEMENT_TEMPLATE_HEADER = "Adres Bilgisi Güncellemesi";
export const ANNOUNCEMENT_ADDRESS =
  "Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir";
export const ANNOUNCEMENT_TEMPLATE_BODY =
  "Mabel Hair Art iş yeri adresimiz değişmiştir.\n\n" +
  "Güncel adresimiz:\n{{1}}\n\n" +
  "Güncel konum bilgisine aşağıdaki bağlantı üzerinden ulaşabilirsiniz.";
export const ANNOUNCEMENT_BUTTON_TEXT = "Konumu Görüntüle";
export const ANNOUNCEMENT_MAPS_QUERY = "38.801010673611486,26.974653153176668";
export const ANNOUNCEMENT_MAPS_URL =
  "https://www.google.com/maps/search/?api=1&query=38.801010673611486%2C26.974653153176668";

export type AnnouncementTemplatePolicyResult = {
  eligible: boolean;
  reason:
    | "eligible"
    | "name"
    | "status"
    | "category"
    | "language"
    | "components";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedType(value: unknown) {
  return String(value || "").toUpperCase();
}

function hasDynamicExample(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

export function isExpectedStaticMapsUrl(value: unknown) {
  if (typeof value !== "string" || value.includes("{{")) return false;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hostname !== "www.google.com" ||
      !["/maps/search", "/maps/search/"].includes(url.pathname) ||
      url.hash
    ) {
      return false;
    }

    const keys = [...url.searchParams.keys()].sort();
    return keys.length === 2 && keys[0] === "api" && keys[1] === "query" &&
      url.searchParams.getAll("api").length === 1 &&
      url.searchParams.get("api") === "1" &&
      url.searchParams.getAll("query").length === 1 &&
      url.searchParams.get("query") === ANNOUNCEMENT_MAPS_QUERY;
  } catch {
    return false;
  }
}

function hasExactComponents(components: unknown[]) {
  const records = components.filter(isRecord);
  if (components.length !== 3 || records.length !== 3) return false;

  const header = records.find((component) =>
    normalizedType(component.type) === "HEADER"
  );
  const body = records.find((component) =>
    normalizedType(component.type) === "BODY"
  );
  const buttonsComponent = records.find((component) =>
    normalizedType(component.type) === "BUTTONS"
  );
  if (!header || !body || !buttonsComponent) return false;

  if (
    normalizedType(header.format) !== "TEXT" ||
    header.text !== ANNOUNCEMENT_TEMPLATE_HEADER ||
    body.text !== ANNOUNCEMENT_TEMPLATE_BODY
  ) {
    return false;
  }

  const bodyVariables = ANNOUNCEMENT_TEMPLATE_BODY.match(/{{[0-9]+}}/g) || [];
  if (bodyVariables.length !== 1 || bodyVariables[0] !== "{{1}}") return false;

  const buttons = buttonsComponent.buttons;
  if (
    !Array.isArray(buttons) || buttons.length !== 1 || !isRecord(buttons[0])
  ) {
    return false;
  }

  const button = buttons[0];
  return normalizedType(button.type) === "URL" &&
    button.text === ANNOUNCEMENT_BUTTON_TEXT &&
    isExpectedStaticMapsUrl(button.url) &&
    !hasDynamicExample(button.example);
}

export function evaluateAnnouncementTemplate(
  approval: WhatsAppTemplateApproval | null,
): AnnouncementTemplatePolicyResult {
  if (approval?.name !== ANNOUNCEMENT_TEMPLATE_NAME) {
    return { eligible: false, reason: "name" };
  }
  if (approval?.status !== "APPROVED") {
    return { eligible: false, reason: "status" };
  }
  if (approval.category !== ANNOUNCEMENT_TEMPLATE_CATEGORY) {
    return { eligible: false, reason: "category" };
  }
  if (approval.language !== ANNOUNCEMENT_TEMPLATE_LANGUAGE) {
    return { eligible: false, reason: "language" };
  }
  if (!hasExactComponents(approval.components)) {
    return { eligible: false, reason: "components" };
  }
  return { eligible: true, reason: "eligible" };
}
