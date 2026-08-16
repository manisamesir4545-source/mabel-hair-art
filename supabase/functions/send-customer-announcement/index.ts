import {
  adminCorsHeaders,
  adminJson,
  isAdminOriginAllowed,
  verifyAdminSessionToken,
} from "../_shared/admin-session.ts";
import {
  getSupabaseAdmin,
  getTemplateApproval,
  normalizePhone,
  sendTemplateMessage,
  WhatsAppTemplateApproval,
} from "../_shared/whatsapp.ts";

const CAMPAIGN_ID = "mabel_reopening_2026_08_18_v2";
const TEMPLATE_NAME = "mabel_calisma_bilgisi_v2";
const ANNOUNCEMENT_DATE = "18 Ağustos 2026";
const LEASE_SECONDS = 15 * 60;
const MAX_BODY_LENGTH = 1024;
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

type Recipient = {
  phone: string;
  name: string;
};

type RecipientData = {
  recipients: Recipient[];
  invalidRecipientCount: number;
  optedOutCount: number;
};

type CampaignLog = {
  phone: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
};

type CampaignSummary = {
  recipientCount: number;
  sent: number;
  failed: number;
  pending: number;
  processing: number;
};

type CampaignRow = {
  state: string;
  locked_until: string | null;
};

function firstRow<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] || null : value;
}

function isValidPhone(phone: string) {
  return /^[1-9][0-9]{7,14}$/.test(phone);
}

function safeName(value: unknown) {
  const withoutControls = [...String(value || "")].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const name = withoutControls.replace(/\s+/g, " ").trim();
  return (name || "Müşterimiz").slice(0, 80);
}

async function loadRecipients(supabase: SupabaseAdmin): Promise<RecipientData> {
  const recipients = new Map<string, Recipient>();
  let invalidRecipientCount = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("broadcast_recipients")
      .select("phone, customer_name")
      .eq("campaign_id", CAMPAIGN_ID)
      .order("phone", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data || []) as Array<Record<string, unknown>>;
    for (const row of batch) {
      const phone = normalizePhone(String(row.phone || ""));
      if (!isValidPhone(phone)) {
        invalidRecipientCount += 1;
        continue;
      }
      recipients.set(phone, {
        phone,
        name: safeName(row.customer_name),
      });
    }
    if (batch.length < PAGE_SIZE) {
      return {
        recipients: [...recipients.values()],
        invalidRecipientCount,
        optedOutCount: 0,
      };
    }
  }
  throw new Error("Broadcast recipient snapshot exceeded the safety limit");
}

async function loadCampaignLogs(supabase: SupabaseAdmin) {
  const logs: CampaignLog[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("message_logs")
      .select("phone, status")
      .eq("campaign_id", CAMPAIGN_ID)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data || []) as CampaignLog[];
    logs.push(...batch);
    if (batch.length < PAGE_SIZE) return logs;
  }
  throw new Error("Campaign log scan exceeded the safety limit");
}

async function loadCampaign(supabase: SupabaseAdmin) {
  const { data, error } = await supabase
    .from("broadcast_campaigns")
    .select("state, locked_until")
    .eq("campaign_id", CAMPAIGN_ID)
    .maybeSingle();
  if (error) throw error;
  return data as CampaignRow | null;
}

async function campaignSummary(
  supabase: SupabaseAdmin,
  recipients: Recipient[],
) {
  const logs = await loadCampaignLogs(supabase);
  const recipientPhones = new Set(
    recipients.map((recipient) => recipient.phone),
  );
  const sentPhones = new Set<string>();
  const failedPhones = new Set<string>();
  const processingPhones = new Set<string>();

  for (const log of logs) {
    const phone = normalizePhone(log.phone || "");
    if (!recipientPhones.has(phone)) continue;
    if (log.status === "sent") sentPhones.add(phone);
    if (log.status === "failed" || log.status === "skipped") {
      failedPhones.add(phone);
    }
    if (log.status === "pending") processingPhones.add(phone);
  }

  const sent = sentPhones.size;
  const failed = failedPhones.size;
  const processing = processingPhones.size;

  return {
    recipientCount: recipients.length,
    sent,
    failed,
    processing,
    pending: Math.max(0, recipients.length - sent - failed - processing),
  } satisfies CampaignSummary;
}

function campaignLocked(campaign: CampaignRow | null) {
  return campaign?.state === "running" && Boolean(campaign.locked_until) &&
    new Date(String(campaign.locked_until)).getTime() > Date.now();
}

function statusPayload(
  summary: CampaignSummary,
  recipientData: RecipientData,
  approval: WhatsAppTemplateApproval | null,
  campaign: CampaignRow | null,
) {
  const templateStatus = approval?.status || "UNAVAILABLE";
  const locked = campaignLocked(campaign);
  return {
    campaign: CAMPAIGN_ID,
    campaignId: CAMPAIGN_ID,
    template: TEMPLATE_NAME,
    templateName: TEMPLATE_NAME,
    templateStatus,
    templateLanguage: approval?.language || null,
    templateCheckedAt: approval?.checkedAt || null,
    recipientCount: summary.recipientCount,
    invalidRecipientCount: recipientData.invalidRecipientCount,
    optedOutCount: recipientData.optedOutCount,
    sent: summary.sent,
    failed: summary.failed,
    pending: summary.pending,
    processing: summary.processing,
    campaignState: campaign?.state || "idle",
    locked,
    canSend: templateStatus === "APPROVED" && summary.pending > 0 && !locked,
  };
}

async function finalizeMessage(
  supabase: SupabaseAdmin,
  logId: number,
  status: "sent" | "failed",
  providerResponse: unknown,
  errorMessage: string | null,
) {
  const { data, error } = await supabase.rpc("finalize_broadcast_message", {
    p_log_id: logId,
    p_status: status,
    p_provider_response: status === "sent" ? providerResponse : null,
    p_error_message: status === "failed" ? errorMessage : null,
  });
  if (error) throw error;
  return data === true;
}

async function processRecipient(
  supabase: SupabaseAdmin,
  runToken: string,
  recipient: Recipient,
) {
  let reservation:
    | { claimed: boolean; log_id: number; log_status: string }
    | null = null;
  try {
    const { data, error } = await supabase.rpc("reserve_broadcast_message", {
      p_campaign_id: CAMPAIGN_ID,
      p_run_token: runToken,
      p_phone: recipient.phone,
      p_template_name: TEMPLATE_NAME,
    });
    if (error) throw error;
    reservation = firstRow(data);
  } catch (error) {
    console.error(
      "announcement reservation failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return "pending" as const;
  }

  if (!reservation?.claimed) return "skipped" as const;

  try {
    const providerResponse = await sendTemplateMessage(
      recipient.phone,
      TEMPLATE_NAME,
      [recipient.name, ANNOUNCEMENT_DATE],
    );
    return await finalizeMessage(
        supabase,
        reservation.log_id,
        "sent",
        providerResponse,
        null,
      )
      ? "sent" as const
      : "pending" as const;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unknown WhatsApp error";
    try {
      return await finalizeMessage(
          supabase,
          reservation.log_id,
          "failed",
          null,
          message,
        )
        ? "failed" as const
        : "pending" as const;
    } catch (finalizeError) {
      console.error(
        "announcement failure finalization failed",
        finalizeError instanceof Error
          ? finalizeError.message
          : "unknown error",
      );
      return "pending" as const;
    }
  }
}

async function completeCampaign(
  supabase: SupabaseAdmin,
  runToken: string,
  summary: CampaignSummary,
  skipped: number,
  lastError: string | null,
) {
  const { data, error } = await supabase.rpc("complete_broadcast_campaign", {
    p_campaign_id: CAMPAIGN_ID,
    p_run_token: runToken,
    p_sent_count: summary.sent,
    p_failed_count: summary.failed,
    p_pending_count: summary.pending,
    p_processing_count: summary.processing,
    p_skipped_count: skipped,
    p_last_error: lastError,
  });
  if (error) throw error;
  return data === true;
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
  if (!await verifyAdminSessionToken(req.headers.get("x-admin-session"))) {
    return adminJson(req, {
      ok: false,
      error: "Admin oturumu geçersiz veya süresi dolmuş.",
    }, 401);
  }

  const contentLength = Number(req.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_LENGTH) {
    return adminJson(req, { ok: false, error: "Geçersiz istek." }, 400);
  }

  let body: Record<string, unknown>;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_LENGTH) throw new Error("body too large");
    body = JSON.parse(rawBody);
  } catch {
    return adminJson(req, { ok: false, error: "Geçersiz istek." }, 400);
  }

  if (
    !body || Array.isArray(body) ||
    Object.keys(body).sort().join(",") !== "action" ||
    !["status", "send"].includes(String(body.action || ""))
  ) {
    return adminJson(req, { ok: false, error: "Geçersiz istek." }, 400);
  }

  const action = String(body.action) as "status" | "send";
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return adminJson(req, {
      ok: false,
      error: "Duyuru hizmeti yapılandırılmamış.",
    }, 503);
  }

  try {
    const recipientData = await loadRecipients(supabase);
    const [summary, campaign] = await Promise.all([
      campaignSummary(supabase, recipientData.recipients),
      loadCampaign(supabase),
    ]);

    let approval: WhatsAppTemplateApproval;
    try {
      approval = await getTemplateApproval(TEMPLATE_NAME);
    } catch (error) {
      console.error(
        "announcement template status failed",
        error instanceof Error ? error.message : "unknown error",
      );
      return adminJson(req, {
        ok: false,
        ...statusPayload(summary, recipientData, null, campaign),
        message: "WhatsApp şablon durumu doğrulanamadı. Gönderim yapılmadı.",
      }, 502);
    }

    const currentStatus = statusPayload(
      summary,
      recipientData,
      approval,
      campaign,
    );
    if (action === "status") {
      return adminJson(req, { ok: true, ...currentStatus });
    }

    if (approval.status !== "APPROVED") {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message:
          "WhatsApp şablonu APPROVED durumunda değil. Gönderim yapılmadı.",
      }, 409);
    }
    if (summary.recipientCount === 0) {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message: "Gönderilecek uygun müşteri bulunamadı.",
      }, 422);
    }
    if (summary.pending === 0) {
      return adminJson(req, {
        ok: true,
        ...currentStatus,
        message: summary.processing > 0
          ? "Bu kampanyada sonucu belirsiz rezervasyonlar var; güvenlik için bu müşterilere yeniden gönderim yapılmaz."
          : "Bu kampanya için tüm müşteriler daha önce işlendi.",
      });
    }

    const { data: claimData, error: claimError } = await supabase.rpc(
      "claim_broadcast_campaign",
      {
        p_campaign_id: CAMPAIGN_ID,
        p_template_name: TEMPLATE_NAME,
        p_template_parameters: ["customer_name", ANNOUNCEMENT_DATE],
        p_recipient_count: recipientData.recipients.length,
        p_lease_seconds: LEASE_SECONDS,
      },
    );
    if (claimError) throw claimError;
    const claim = firstRow(claimData) as {
      acquired: boolean;
      run_token: string;
      campaign_state: string;
      lock_expires_at: string;
    } | null;

    if (!claim?.acquired || !claim.run_token) {
      const latestSummary = await campaignSummary(
        supabase,
        recipientData.recipients,
      );
      const latestCampaign = await loadCampaign(supabase);
      return adminJson(req, {
        ok: false,
        ...statusPayload(
          latestSummary,
          recipientData,
          approval,
          latestCampaign,
        ),
        message: "Bu kampanya için başka bir gönderim halen devam ediyor.",
      }, 409);
    }

    const runToken = claim.run_token;
    const configuredBatchSize = Number(
      Deno.env.get("WHATSAPP_BROADCAST_BATCH_SIZE") || "5",
    );
    const batchSize = Number.isInteger(configuredBatchSize)
      ? Math.min(10, Math.max(1, configuredBatchSize))
      : 5;
    let skipped = 0;

    try {
      for (
        let index = 0;
        index < recipientData.recipients.length;
        index += batchSize
      ) {
        const { data: renewed, error: renewError } = await supabase.rpc(
          "renew_broadcast_campaign",
          {
            p_campaign_id: CAMPAIGN_ID,
            p_run_token: runToken,
            p_lease_seconds: LEASE_SECONDS,
          },
        );
        if (renewError || renewed !== true) {
          throw renewError || new Error("Broadcast lease was lost");
        }

        const batch = recipientData.recipients.slice(index, index + batchSize);
        const results = await Promise.all(
          batch.map((recipient) =>
            processRecipient(supabase, runToken, recipient)
          ),
        );
        skipped += results.filter((result) => result === "skipped").length;
      }

      const finalSummary = await campaignSummary(
        supabase,
        recipientData.recipients,
      );
      if (
        !await completeCampaign(supabase, runToken, finalSummary, skipped, null)
      ) {
        throw new Error("Campaign completion rejected");
      }
      const finalCampaign = await loadCampaign(supabase);
      return adminJson(req, {
        ok: true,
        ...statusPayload(finalSummary, recipientData, approval, finalCampaign),
        skipped,
        message: finalSummary.processing > 0
          ? "Duyuru gönderimi durdu; sonucu belirsiz alıcılara güvenlik için yeniden gönderim yapılmaz."
          : finalSummary.failed > 0
          ? "Duyuru gönderimi tamamlandı; bazı alıcılarda hata oluştu."
          : "Duyuru gönderimi tamamlandı.",
      });
    } catch (error) {
      console.error(
        "announcement send failed",
        error instanceof Error ? error.message : "unknown error",
      );
      const failedSummary = await campaignSummary(
        supabase,
        recipientData.recipients,
      ).catch(() => summary);
      await completeCampaign(
        supabase,
        runToken,
        failedSummary,
        skipped,
        "Broadcast processing failed",
      ).catch(() => false);
      const failedCampaign = await loadCampaign(supabase).catch(() => campaign);
      return adminJson(req, {
        ok: false,
        ...statusPayload(
          failedSummary,
          recipientData,
          approval,
          failedCampaign,
        ),
        skipped,
        message:
          "Duyuru işlemi güvenli biçimde durduruldu. Gönderilmiş alıcılara yeniden gönderim yapılmaz.",
      }, 500);
    }
  } catch (error) {
    console.error(
      "send-customer-announcement failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return adminJson(req, {
      ok: false,
      error: "Duyuru hizmeti şu anda kullanılamıyor.",
    }, 503);
  }
});
