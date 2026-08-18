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

const SERIES_ID = "mabel_reopening_2026_08_18_v2";
const TEMPLATE_NAME = "mabel_calisma_bilgisi_v2";
const ANNOUNCEMENT_DATE = "19 Ağustos 2026";
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

type DeliverySummary = {
  providerSent: number;
  delivered: number;
  read: number;
  deleted: number;
  deliveryFailed: number;
  deliveryUnknown: number;
};

type CampaignRow = {
  campaign_id: string;
  round_number: number;
  state: string;
  locked_until: string | null;
  recipient_count: number;
};

type PreparedRound = {
  campaign_id: string;
  round_number: number;
  recipient_count: number;
  created: boolean;
};

type RequestBody =
  | { action: "status" }
  | { action: "new-round"; requestId: string }
  | { action: "send"; roundId: string };

function firstRow<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] || null : value;
}

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function isRoundId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-z0-9_:-]{1,128}$/.test(value);
}

function parseRequestBody(value: unknown): RequestBody | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;

  const keys = Object.keys(value).sort().join(",");
  if (value.action === "status" && keys === "action") {
    return { action: "status" };
  }
  if (
    value.action === "new-round" && keys === "action,requestId" &&
    isUuid(value.requestId)
  ) {
    return { action: "new-round", requestId: value.requestId };
  }
  if (
    value.action === "send" && keys === "action,roundId" &&
    isRoundId(value.roundId)
  ) {
    return { action: "send", roundId: value.roundId };
  }
  return null;
}

function safeDiagnostic(error: unknown) {
  const source = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const rawCode = typeof source.code === "string" ? source.code : "";
  const rawStatus = typeof source.status === "number" ? source.status : 0;

  return {
    code: /^[a-z0-9_]{1,32}$/i.test(rawCode) ? rawCode.toUpperCase() : null,
    status: Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : null,
  };
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

async function loadRecipients(
  supabase: SupabaseAdmin,
  roundId: string,
): Promise<RecipientData> {
  const recipients = new Map<string, Recipient>();
  let invalidRecipientCount = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("broadcast_recipients")
      .select("phone, customer_name")
      .eq("campaign_id", roundId)
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

async function loadCampaignLogs(supabase: SupabaseAdmin, roundId: string) {
  const logs: CampaignLog[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("message_logs")
      .select("phone, status")
      .eq("campaign_id", roundId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data || []) as CampaignLog[];
    logs.push(...batch);
    if (batch.length < PAGE_SIZE) return logs;
  }
  throw new Error("Campaign log scan exceeded the safety limit");
}

async function loadCampaign(supabase: SupabaseAdmin, roundId: string) {
  const { data, error } = await supabase
    .from("broadcast_campaigns")
    .select(
      "campaign_id, round_number, state, locked_until, recipient_count",
    )
    .eq("campaign_id", roundId)
    .eq("series_id", SERIES_ID)
    .maybeSingle();
  if (error) throw error;
  return data as CampaignRow | null;
}

async function loadLatestRound(supabase: SupabaseAdmin) {
  const { data, error } = await supabase
    .from("broadcast_campaigns")
    .select(
      "campaign_id, round_number, state, locked_until, recipient_count",
    )
    .eq("series_id", SERIES_ID)
    .order("round_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as CampaignRow | null;
}

async function campaignSummary(
  supabase: SupabaseAdmin,
  roundId: string,
  recipients: Recipient[],
) {
  const logs = await loadCampaignLogs(supabase, roundId);
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

async function loadDeliverySummary(
  supabase: SupabaseAdmin,
  roundId: string,
): Promise<DeliverySummary> {
  const { data, error } = await supabase.rpc(
    "get_broadcast_delivery_summary",
    { p_campaign_id: roundId },
  );
  if (error) throw error;

  const row = firstRow(data) as Record<string, unknown> | null;
  if (!row) {
    return {
      providerSent: 0,
      delivered: 0,
      read: 0,
      deleted: 0,
      deliveryFailed: 0,
      deliveryUnknown: 0,
    };
  }

  return {
    providerSent: safeCount(row.sent_count),
    delivered: safeCount(row.delivered_count),
    read: safeCount(row.read_count),
    deleted: safeCount(row.deleted_count),
    deliveryFailed: safeCount(row.delivery_failed_count),
    deliveryUnknown: safeCount(row.unknown_count),
  };
}

function campaignLocked(campaign: CampaignRow | null) {
  return campaign?.state === "running" && Boolean(campaign.locked_until) &&
    new Date(String(campaign.locked_until)).getTime() > Date.now();
}

function campaignTerminal(campaign: CampaignRow | null) {
  return campaign !== null &&
    ["completed", "partial", "failed"].includes(campaign.state);
}

function campaignSendable(campaign: CampaignRow | null) {
  return campaign !== null &&
    ["idle", "running", "partial", "failed"].includes(campaign.state);
}

function statusPayload(
  summary: CampaignSummary,
  recipientData: RecipientData,
  approval: WhatsAppTemplateApproval | null,
  campaign: CampaignRow | null,
  delivery: DeliverySummary | null = null,
) {
  const templateStatus = approval?.status || "UNAVAILABLE";
  const locked = campaignLocked(campaign);
  const roundId = campaign?.campaign_id || "";
  const completed = campaign?.state === "completed";
  return {
    campaign: roundId,
    campaignId: roundId,
    seriesId: SERIES_ID,
    roundId,
    roundNumber: campaign?.round_number || 0,
    template: TEMPLATE_NAME,
    templateName: TEMPLATE_NAME,
    templateStatus,
    templateCategory: approval?.category || null,
    templateLanguage: approval?.language || null,
    templateCheckedAt: approval?.checkedAt || null,
    recipientCount: summary.recipientCount,
    invalidRecipientCount: recipientData.invalidRecipientCount,
    optedOutCount: recipientData.optedOutCount,
    sent: summary.sent,
    providerSent: delivery?.providerSent || 0,
    delivered: delivery?.delivered || 0,
    read: delivery?.read || 0,
    deleted: delivery?.deleted || 0,
    deliveryFailed: delivery?.deliveryFailed || 0,
    deliveryUnknown: delivery?.deliveryUnknown ?? summary.sent,
    failed: summary.failed,
    pending: summary.pending,
    processing: summary.processing,
    campaignState: campaign?.state || "idle",
    locked,
    canSend: templateStatus === "APPROVED" && summary.pending > 0 && !locked &&
      !completed && campaignSendable(campaign),
    canStartNewRound: templateStatus === "APPROVED" &&
      summary.recipientCount > 0 && summary.pending === 0 &&
      summary.processing === 0 && !locked && campaignTerminal(campaign),
  };
}

async function prepareRound(
  supabase: SupabaseAdmin,
  requestId: string,
) {
  const { data, error } = await supabase.rpc("prepare_broadcast_round", {
    p_series_id: SERIES_ID,
    p_request_id: requestId,
    p_template_name: TEMPLATE_NAME,
    p_template_parameters: ["customer_name", ANNOUNCEMENT_DATE],
  });
  if (error) throw error;

  const prepared = firstRow(data) as PreparedRound | null;
  if (
    !prepared || !isRoundId(prepared.campaign_id) ||
    !Number.isInteger(prepared.round_number) || prepared.round_number < 1 ||
    !Number.isInteger(prepared.recipient_count) ||
    prepared.recipient_count < 1 || typeof prepared.created !== "boolean"
  ) {
    throw new Error("Invalid prepared broadcast round response");
  }
  return prepared;
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
  roundId: string,
  runToken: string,
  recipient: Recipient,
) {
  let reservation:
    | { claimed: boolean; log_id: number; log_status: string }
    | null = null;
  try {
    const { data, error } = await supabase.rpc("reserve_broadcast_message", {
      p_campaign_id: roundId,
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
  roundId: string,
  runToken: string,
  summary: CampaignSummary,
  skipped: number,
  lastError: string | null,
) {
  const { data, error } = await supabase.rpc("complete_broadcast_campaign", {
    p_campaign_id: roundId,
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

async function loadRoundContext(
  supabase: SupabaseAdmin,
  roundId: string,
) {
  const recipientData = await loadRecipients(supabase, roundId);
  const [summary, campaign, delivery] = await Promise.all([
    campaignSummary(supabase, roundId, recipientData.recipients),
    loadCampaign(supabase, roundId),
    loadDeliverySummary(supabase, roundId),
  ]);
  if (!campaign) throw new Error("Broadcast round not found");
  return { recipientData, summary, campaign, delivery };
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

  let parsedBody: unknown;
  try {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_LENGTH) throw new Error("body too large");
    parsedBody = JSON.parse(rawBody);
  } catch {
    return adminJson(req, { ok: false, error: "Geçersiz istek." }, 400);
  }

  const body = parseRequestBody(parsedBody);
  if (!body) {
    return adminJson(req, { ok: false, error: "Geçersiz istek." }, 400);
  }

  const action = body.action;
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return adminJson(req, {
      ok: false,
      error: "Duyuru hizmeti yapılandırılmamış.",
    }, 503);
  }

  let diagnosticStage = "load_latest_round";
  try {
    const latestRound = await loadLatestRound(supabase);
    let currentContext: Awaited<ReturnType<typeof loadRoundContext>> | null =
      null;
    if (latestRound) {
      diagnosticStage = "load_round_state";
      currentContext = await loadRoundContext(
        supabase,
        latestRound.campaign_id,
      );
    } else if (action !== "new-round") {
      throw new Error("Broadcast round not configured");
    }

    diagnosticStage = "template_approval";
    let approval: WhatsAppTemplateApproval;
    try {
      approval = await getTemplateApproval(TEMPLATE_NAME);
    } catch (error) {
      console.error(
        "announcement template status failed",
        error instanceof Error ? error.message : "unknown error",
      );
      const unavailableStatus = currentContext
        ? statusPayload(
          currentContext.summary,
          currentContext.recipientData,
          null,
          currentContext.campaign,
          currentContext.delivery,
        )
        : {
          campaign: "",
          campaignId: "",
          seriesId: SERIES_ID,
          roundId: "",
          roundNumber: 0,
          template: TEMPLATE_NAME,
          templateName: TEMPLATE_NAME,
          templateStatus: "UNAVAILABLE",
        };
      return adminJson(req, {
        ok: false,
        ...unavailableStatus,
        message: "WhatsApp şablon durumu doğrulanamadı. Gönderim yapılmadı.",
      }, 502);
    }

    if (body.action === "new-round") {
      const currentStatus = currentContext
        ? statusPayload(
          currentContext.summary,
          currentContext.recipientData,
          approval,
          currentContext.campaign,
          currentContext.delivery,
        )
        : null;

      if (approval.status !== "APPROVED") {
        return adminJson(req, {
          ok: false,
          ...(currentStatus || {
            seriesId: SERIES_ID,
            roundId: "",
            roundNumber: 0,
            template: TEMPLATE_NAME,
            templateName: TEMPLATE_NAME,
            templateStatus: approval.status,
          }),
          message:
            "WhatsApp şablonu APPROVED durumunda değil. Yeni gönderim turu hazırlanmadı.",
        }, 409);
      }

      if (
        currentContext &&
        ((currentContext.campaign.state !== "idle" &&
          !currentStatus?.canStartNewRound) ||
          (currentContext.campaign.state === "idle" &&
            currentContext.summary.processing > 0))
      ) {
        return adminJson(req, {
          ok: false,
          ...currentStatus,
          message: "Mevcut gönderim turu tamamlanmadan yeni tur başlatılamaz.",
        }, 409);
      }

      diagnosticStage = "prepare_round";
      const prepared = await prepareRound(supabase, body.requestId);
      diagnosticStage = "load_prepared_round";
      const preparedLatest = await loadLatestRound(supabase);
      if (
        !preparedLatest ||
        preparedLatest.campaign_id !== prepared.campaign_id ||
        preparedLatest.round_number !== prepared.round_number
      ) {
        throw new Error("Prepared broadcast round is not current");
      }

      const preparedContext = await loadRoundContext(
        supabase,
        prepared.campaign_id,
      );
      const preparedStatus = statusPayload(
        preparedContext.summary,
        preparedContext.recipientData,
        approval,
        preparedContext.campaign,
        preparedContext.delivery,
      );
      if (
        preparedContext.campaign.recipient_count !== prepared.recipient_count ||
        preparedContext.summary.recipientCount !== prepared.recipient_count
      ) {
        throw new Error("Prepared broadcast recipient count mismatch");
      }
      if (preparedContext.campaign.state !== "idle") {
        return adminJson(req, {
          ok: false,
          ...preparedStatus,
          created: prepared.created,
          message:
            "Hazırlanan gönderim turu başka bir işlem tarafından başlatılmış. Durumu yenileyin.",
        }, 409);
      }

      return adminJson(req, {
        ok: true,
        ...preparedStatus,
        created: prepared.created,
        message: prepared.created
          ? "Yeni gönderim turu hazırlandı. Mesaj gönderilmedi."
          : "Hazır bekleyen gönderim turu döndürüldü. Mesaj gönderilmedi.",
      });
    }

    if (!currentContext) throw new Error("Broadcast round not configured");
    const { recipientData, summary, campaign, delivery } = currentContext;
    const currentStatus = statusPayload(
      summary,
      recipientData,
      approval,
      campaign,
      delivery,
    );
    if (body.action === "status") {
      return adminJson(req, { ok: true, ...currentStatus });
    }

    const roundId = body.roundId;
    if (roundId !== campaign.campaign_id) {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message:
          "İstenen gönderim turu güncel değil. Durumu yenileyip tekrar onaylayın.",
      }, 409);
    }
    if (approval.status !== "APPROVED") {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message:
          "WhatsApp şablonu APPROVED durumunda değil. Gönderim yapılmadı.",
      }, 409);
    }
    if (campaign.state === "completed") {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message:
          "Tamamlanan gönderim turu yeniden başlatılamaz. Tekrar göndermek için yeni tur hazırlayın.",
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
    if (currentStatus.locked) {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message: "Bu gönderim turu için başka bir işlem halen devam ediyor.",
      }, 409);
    }
    if (!currentStatus.canSend) {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message: "Bu gönderim turu şu anda gönderime uygun değil.",
      }, 409);
    }

    diagnosticStage = "verify_latest_round";
    const verifiedLatest = await loadLatestRound(supabase);
    if (
      !verifiedLatest || verifiedLatest.campaign_id !== roundId ||
      verifiedLatest.round_number !== campaign.round_number
    ) {
      return adminJson(req, {
        ok: false,
        ...currentStatus,
        message:
          "Gönderim turu bu sırada değişti. Durumu yenileyip yeni turu tekrar onaylayın.",
      }, 409);
    }

    diagnosticStage = "claim_campaign";
    const { data: claimData, error: claimError } = await supabase.rpc(
      "claim_broadcast_campaign",
      {
        p_campaign_id: roundId,
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
        roundId,
        recipientData.recipients,
      );
      const [latestCampaign, latestDelivery] = await Promise.all([
        loadCampaign(supabase, roundId),
        loadDeliverySummary(supabase, roundId),
      ]);
      return adminJson(req, {
        ok: false,
        ...statusPayload(
          latestSummary,
          recipientData,
          approval,
          latestCampaign,
          latestDelivery,
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
            p_campaign_id: roundId,
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
            processRecipient(supabase, roundId, runToken, recipient)
          ),
        );
        skipped += results.filter((result) => result === "skipped").length;
      }

      const finalSummary = await campaignSummary(
        supabase,
        roundId,
        recipientData.recipients,
      );
      if (
        !await completeCampaign(
          supabase,
          roundId,
          runToken,
          finalSummary,
          skipped,
          null,
        )
      ) {
        throw new Error("Campaign completion rejected");
      }
      const [finalCampaign, finalDelivery] = await Promise.all([
        loadCampaign(supabase, roundId),
        loadDeliverySummary(supabase, roundId),
      ]);
      return adminJson(req, {
        ok: true,
        ...statusPayload(
          finalSummary,
          recipientData,
          approval,
          finalCampaign || campaign,
          finalDelivery,
        ),
        skipped,
        message: finalSummary.processing > 0
          ? "Duyuru gönderimi durdu; sonucu belirsiz alıcılara güvenlik için yeniden gönderim yapılmaz."
          : finalSummary.failed > 0
          ? "Duyuru gönderimi tamamlandı; bazı alıcılarda hata oluştu."
          : "Duyuru gönderimi tamamlandı.",
      });
    } catch (error) {
      console.error("announcement send failed", {
        action,
        stage: "process_recipients",
        ...safeDiagnostic(error),
      });
      const failedSummary = await campaignSummary(
        supabase,
        roundId,
        recipientData.recipients,
      ).catch(() => summary);
      await completeCampaign(
        supabase,
        roundId,
        runToken,
        failedSummary,
        skipped,
        "Broadcast processing failed",
      ).catch(() => false);
      const failedCampaign = await loadCampaign(supabase, roundId).catch(() =>
        campaign
      );
      const failedDelivery = await loadDeliverySummary(supabase, roundId)
        .catch(() => delivery);
      return adminJson(req, {
        ok: false,
        ...statusPayload(
          failedSummary,
          recipientData,
          approval,
          failedCampaign || campaign,
          failedDelivery,
        ),
        skipped,
        message:
          "Duyuru işlemi güvenli biçimde durduruldu. Gönderilmiş alıcılara yeniden gönderim yapılmaz.",
      }, 500);
    }
  } catch (error) {
    const diagnostic = safeDiagnostic(error);
    console.error("send-customer-announcement failed", {
      action,
      stage: diagnosticStage,
      ...diagnostic,
    });
    return adminJson(req, {
      ok: false,
      error: "Duyuru hizmeti şu anda kullanılamıyor.",
      diagnosticCode: diagnostic.code,
      diagnosticStage,
    }, 503);
  }
});
