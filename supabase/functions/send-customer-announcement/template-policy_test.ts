import type { WhatsAppTemplateApproval } from "../_shared/whatsapp.ts";
import {
  ANNOUNCEMENT_ADDRESS,
  ANNOUNCEMENT_BUTTON_TEXT,
  ANNOUNCEMENT_MAPS_URL,
  ANNOUNCEMENT_TEMPLATE_BODY,
  ANNOUNCEMENT_TEMPLATE_HEADER,
  ANNOUNCEMENT_TEMPLATE_NAME,
  evaluateAnnouncementTemplate,
  isExpectedStaticMapsUrl,
} from "./template-policy.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function exactApproval(): WhatsAppTemplateApproval {
  return {
    name: ANNOUNCEMENT_TEMPLATE_NAME,
    language: "tr",
    status: "APPROVED",
    category: "UTILITY",
    checkedAt: "2026-08-23T00:00:00.000Z",
    components: [
      {
        type: "HEADER",
        format: "TEXT",
        text: ANNOUNCEMENT_TEMPLATE_HEADER,
      },
      {
        type: "BODY",
        text: ANNOUNCEMENT_TEMPLATE_BODY,
        example: { body_text: [[ANNOUNCEMENT_ADDRESS]] },
      },
      {
        type: "BUTTONS",
        buttons: [{
          type: "URL",
          text: ANNOUNCEMENT_BUTTON_TEXT,
          url: ANNOUNCEMENT_MAPS_URL,
        }],
      },
    ],
  };
}

Deno.test("exact Utility address template is eligible", () => {
  const result = evaluateAnnouncementTemplate(exactApproval());
  assert(result.eligible, `expected eligible, got ${result.reason}`);
});

Deno.test("Maps URL comparison accepts comma encoding but rejects drift", () => {
  assert(isExpectedStaticMapsUrl(ANNOUNCEMENT_MAPS_URL), "encoded URL failed");
  assert(
    isExpectedStaticMapsUrl(ANNOUNCEMENT_MAPS_URL.replace("%2C", ",")),
    "equivalent comma URL failed",
  );
  assert(
    !isExpectedStaticMapsUrl(
      "https://www.google.com/maps/search/?api=1&query=38.801010673611486,26.974600000000000",
    ),
    "changed coordinate passed",
  );
  assert(
    !isExpectedStaticMapsUrl(
      `${ANNOUNCEMENT_MAPS_URL}&redirect=https://example.com`,
    ),
    "unexpected query parameter passed",
  );
});

Deno.test("status, category, language, and every component fail closed", () => {
  for (
    const mutate of [
      (approval: WhatsAppTemplateApproval) => approval.name = "wrong_template",
      (approval: WhatsAppTemplateApproval) => approval.status = "PENDING",
      (approval: WhatsAppTemplateApproval) => approval.category = "MARKETING",
      (approval: WhatsAppTemplateApproval) => approval.language = "en_US",
      (approval: WhatsAppTemplateApproval) => {
        (approval.components[0] as Record<string, unknown>).text = "Yeni adres";
      },
      (approval: WhatsAppTemplateApproval) => {
        (approval.components[1] as Record<string, unknown>).text =
          `${ANNOUNCEMENT_TEMPLATE_BODY} Randevu alın.`;
      },
      (approval: WhatsAppTemplateApproval) => {
        const component = approval.components[2] as Record<string, unknown>;
        const buttons = component.buttons as Array<Record<string, unknown>>;
        buttons[0].text = "Haritayı aç";
      },
      (approval: WhatsAppTemplateApproval) => {
        const component = approval.components[2] as Record<string, unknown>;
        const buttons = component.buttons as Array<Record<string, unknown>>;
        buttons[0].url =
          "https://www.google.com/maps/search/?api=1&query={{1}}";
        buttons[0].example = [ANNOUNCEMENT_MAPS_URL];
      },
      (approval: WhatsAppTemplateApproval) => {
        approval.components.push({ type: "FOOTER", text: "Mabel Hair Art" });
      },
    ]
  ) {
    const approval = exactApproval();
    mutate(approval);
    assert(
      !evaluateAnnouncementTemplate(approval).eligible,
      "drifted template unexpectedly passed",
    );
  }
});
