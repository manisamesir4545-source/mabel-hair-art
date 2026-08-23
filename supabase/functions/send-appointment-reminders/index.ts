import {
  type AppointmentPayload,
  customerTemplateParams,
  getSupabaseAdmin,
  getTemplateApproval,
  normalizePhone,
  sendTemplateMessage,
  templateNameFor,
} from "../_shared/whatsapp.ts";

const ISTANBUL_TIME_ZONE = "Europe/Istanbul";
const DEFAULT_REMINDER_HOURS = 2;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 100;
const MAX_SCAN_ROWS = 1_000;
const MAX_SEND_CONCURRENCY = 10;
const MIN_CRON_SECRET_BYTES = 32;
const MAX_CRON_SECRET_BYTES = 512;

const responseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

type AppointmentRow = {
  id: unknown;
  customer_name: unknown;
  phone: unknown;
  service: unknown;
  appointment_date: unknown;
  appointment_time: unknown;
};

type EligibleAppointment = {
  id: number;
  phone: string;
  dedupeKey: string;
  payload: AppointmentPayload;
};

type ReminderCounters = {
  eligible: number;
  claimed: number;
  accepted: number;
  failed: number;
  alreadyReserved: number;
  invalid: number;
  invalidPhone: number;
  invalidDate: number;
};

type Reservation = {
  claimed: boolean;
  log_id: number;
  log_status: string;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function emptyCounters(): ReminderCounters {
  return {
    eligible: 0,
    claimed: 0,
    accepted: 0,
    failed: 0,
    alreadyReserved: 0,
    invalid: 0,
    invalidPhone: 0,
    invalidDate: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isRecord(candidate) ? candidate : null;
}

function parseReservation(value: unknown): Reservation | null {
  const row = firstRecord(value);
  if (!row || typeof row.claimed !== "boolean") return null;

  const logId = Number(row.log_id);
  return {
    claimed: row.claimed,
    log_id: Number.isSafeInteger(logId) && logId > 0 ? logId : 0,
    log_status: typeof row.log_status === "string" ? row.log_status : "",
  };
}

function isoDateInIstanbul(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ISTANBUL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function parseAppointmentDateTime(
  dateValue: unknown,
  timeValue: unknown,
): { at: Date; date: string; time: string } | null {
  const date = typeof dateValue === "string" ? dateValue.trim() : "";
  const time = typeof timeValue === "string" ? timeValue.trim() : "";
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || "0");

  if (
    year < 2000 || year > 9999 || month < 1 || month > 12 || day < 1 ||
    day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    return null;
  }

  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(0, 0, 0, 0);
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }

  // Turkey has used UTC+03:00 year-round since 2016. Appointment records are
  // local wall-clock values, so subtract three hours to obtain the UTC instant.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour - 3, minute, second, 0);
  if (!Number.isFinite(at.getTime())) return null;

  return {
    at,
    date,
    time: `${timeMatch[1]}:${timeMatch[2]}`,
  };
}

function isValidPhone(phone: string) {
  return /^[1-9][0-9]{7,14}$/.test(phone);
}

function safeTemplateText(value: unknown, fallback: string) {
  const withoutControls = [...String(value || "")].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  const result = withoutControls.replace(/\s+/g, " ").trim();
  return (result || fallback).slice(0, 80);
}

function reminderHoursFromEnvironment() {
  const raw = Deno.env.get("WHATSAPP_REMINDER_HOURS") ??
    String(DEFAULT_REMINDER_HOURS);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 168) return null;
  return value;
}

function batchLimitFromEnvironment() {
  const raw = Deno.env.get("WHATSAPP_REMINDER_BATCH_LIMIT");
  if (raw === undefined || raw === "") return DEFAULT_BATCH_LIMIT;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_BATCH_LIMIT;
  return Math.min(Math.floor(value), MAX_BATCH_LIMIT);
}

function hasPlausibleCronSecret(value: string | null): value is string {
  if (value === null) return false;
  const byteLength = new TextEncoder().encode(value).byteLength;
  return byteLength >= MIN_CRON_SECRET_BYTES &&
    byteLength <= MAX_CRON_SECRET_BYTES;
}

async function verifyCronSecret(
  supabase: SupabaseAdmin,
  presentedSecret: string,
) {
  const { data, error } = await supabase.rpc(
    "verify_appointment_reminder_cron_secret",
    { p_secret: presentedSecret },
  );
  if (error) return "unavailable" as const;
  return data === true ? "authorized" as const : "unauthorized" as const;
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out|abort/i.test(message)) {
    return "WhatsApp transport timeout";
  }
  if (/secrets missing/i.test(message)) {
    return "WhatsApp provider configuration unavailable";
  }

  const status = /^WhatsApp API error:\s*(\d{3})$/i.exec(message)?.[1];
  return status
    ? `WhatsApp API error: ${status}`
    : "WhatsApp provider request failed";
}

function containsWhitespaceOrControl(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return /\s/.test(character) || code < 32 || code === 127;
  });
}

function sanitizedProviderResponse(value: unknown) {
  if (!isRecord(value)) return null;

  const sourceMessages = Array.isArray(value.messages) ? value.messages : [];
  const message = sourceMessages[0];
  if (!isRecord(message)) return null;

  const id = typeof message.id === "string" ? message.id.trim() : "";
  if (!id || id.length > 512 || containsWhitespaceOrControl(id)) return null;

  const status = typeof message.message_status === "string" &&
      /^[A-Za-z_]{1,64}$/.test(message.message_status)
    ? message.message_status
    : undefined;

  return {
    messaging_product: "whatsapp",
    messages: [{ id, ...(status ? { message_status: status } : {}) }],
  };
}

async function finalizeReminder(
  supabase: SupabaseAdmin,
  logId: number,
  status: "sent" | "failed",
  providerResponse: Record<string, unknown> | null,
  errorMessage: string | null,
) {
  const { data, error } = await supabase.rpc(
    "finalize_appointment_reminder",
    {
      p_log_id: logId,
      p_status: status,
      p_provider_response: status === "sent" ? providerResponse : null,
      p_error_message: status === "failed" ? errorMessage : null,
    },
  );
  return !error && data === true;
}

function responsePayload(
  ok: boolean,
  counters: ReminderCounters,
  templateStatus: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ok,
    ...counters,
    templateStatus,
    ...extra,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Allow": "OPTIONS, POST",
        "Cache-Control": "no-store",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      responsePayload(false, emptyCounters(), "NOT_CHECKED", {
        error: "method_not_allowed",
      }),
      405,
    );
  }

  const presentedSecret = req.headers.get("x-cron-secret");
  if (!hasPlausibleCronSecret(presentedSecret)) {
    return jsonResponse(
      responsePayload(false, emptyCounters(), "NOT_CHECKED", {
        error: "unauthorized",
      }),
      401,
    );
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return jsonResponse(
      responsePayload(false, emptyCounters(), "NOT_CHECKED", {
        error: "service_unavailable",
      }),
      503,
    );
  }

  const authorization = await verifyCronSecret(supabase, presentedSecret);
  if (authorization === "unavailable") {
    return jsonResponse(
      responsePayload(false, emptyCounters(), "NOT_CHECKED", {
        error: "authorization_unavailable",
      }),
      503,
    );
  }
  if (authorization !== "authorized") {
    return jsonResponse(
      responsePayload(false, emptyCounters(), "NOT_CHECKED", {
        error: "unauthorized",
      }),
      401,
    );
  }

  const counters = emptyCounters();
  let templateStatus = "NOT_CHECKED";

  try {
    const reminderHours = reminderHoursFromEnvironment();
    if (reminderHours === null) {
      return jsonResponse(
        responsePayload(false, counters, templateStatus, {
          error: "invalid_reminder_hours",
        }),
        500,
      );
    }

    const batchLimit = batchLimitFromEnvironment();
    const now = new Date();
    const horizon = new Date(
      now.getTime() + reminderHours * 60 * 60 * 1000,
    );
    const startDate = isoDateInIstanbul(now);
    const endDate = isoDateInIstanbul(horizon);

    const { data, error } = await supabase
      .from("appointments")
      .select(
        "id,customer_name,phone,service,appointment_date,appointment_time",
      )
      .eq("status", "active")
      .gte("appointment_date", startDate)
      .lte("appointment_date", endDate)
      .order("appointment_date", { ascending: true })
      .order("appointment_time", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_SCAN_ROWS);

    if (error) throw new Error("Appointment lookup failed");

    const eligibleAppointments: EligibleAppointment[] = [];
    for (const row of (data || []) as AppointmentRow[]) {
      if (eligibleAppointments.length >= batchLimit) break;

      const parsedDate = parseAppointmentDateTime(
        row.appointment_date,
        row.appointment_time,
      );
      const phone = normalizePhone(
        typeof row.phone === "string" ? row.phone : "",
      );
      const appointmentId = Number(row.id);
      const validPhone = isValidPhone(phone);
      const validId = Number.isSafeInteger(appointmentId) && appointmentId > 0;

      if (!parsedDate) counters.invalidDate += 1;
      if (!validPhone) counters.invalidPhone += 1;
      if (!parsedDate || !validPhone || !validId) {
        counters.invalid += 1;
        continue;
      }

      const appointmentTime = parsedDate.at.getTime();
      if (
        appointmentTime <= now.getTime() ||
        appointmentTime > horizon.getTime()
      ) {
        continue;
      }

      const payload: AppointmentPayload = {
        id: appointmentId,
        customerName: safeTemplateText(row.customer_name, "Müşterimiz"),
        phone,
        serviceName: safeTemplateText(row.service, "Randevu"),
        date: parsedDate.date,
        time: parsedDate.time,
      };
      eligibleAppointments.push({
        id: appointmentId,
        phone,
        payload,
        dedupeKey:
          `appointment_reminder:${appointmentId}:${parsedDate.date}:${parsedDate.time}`,
      });
    }

    counters.eligible = eligibleAppointments.length;
    if (eligibleAppointments.length === 0) {
      return jsonResponse(responsePayload(true, counters, templateStatus));
    }

    const templateName = templateNameFor("appointment_reminder");
    let approval;
    try {
      approval = await getTemplateApproval(templateName);
      templateStatus = approval.status;
    } catch {
      templateStatus = "UNAVAILABLE";
      return jsonResponse(
        responsePayload(false, counters, templateStatus, {
          error: "template_check_failed",
        }),
        503,
      );
    }

    if (
      approval.name !== templateName || approval.language !== "tr" ||
      approval.status !== "APPROVED" || approval.category !== "UTILITY"
    ) {
      return jsonResponse(
        responsePayload(false, counters, templateStatus, {
          error: "template_not_approved_for_utility",
          templateCategory: approval.category,
          templateLanguage: approval.language,
        }),
        503,
      );
    }

    let nextAppointmentIndex = 0;
    let persistenceFailure = false;

    const processAppointment = async (appointment: EligibleAppointment) => {
      let reservation: Reservation | null = null;
      try {
        const { data: reservationData, error: reservationError } =
          await supabase.rpc("reserve_appointment_reminder", {
            p_appointment_id: appointment.id,
            p_phone: appointment.phone,
            p_template_name: templateName,
            p_dedupe_key: appointment.dedupeKey,
          });
        if (reservationError) throw new Error("Reminder reservation failed");
        reservation = parseReservation(reservationData);
      } catch {
        counters.failed += 1;
        return;
      }

      if (!reservation) {
        counters.failed += 1;
        return;
      }
      if (!reservation.claimed) {
        counters.alreadyReserved += 1;
        return;
      }

      counters.claimed += 1;
      if (reservation.log_id < 1 || reservation.log_status !== "pending") {
        counters.failed += 1;
        persistenceFailure = true;
        return;
      }

      try {
        const providerResponse = await sendTemplateMessage(
          appointment.phone,
          templateName,
          customerTemplateParams(appointment.payload),
        );
        const sanitizedResponse = sanitizedProviderResponse(providerResponse);
        if (!sanitizedResponse) {
          counters.failed += 1;
          const finalized = await finalizeReminder(
            supabase,
            reservation.log_id,
            "failed",
            null,
            "WhatsApp response missing message id",
          );
          if (!finalized) persistenceFailure = true;
          return;
        }

        const finalized = await finalizeReminder(
          supabase,
          reservation.log_id,
          "sent",
          sanitizedResponse,
          null,
        );
        if (!finalized) {
          counters.failed += 1;
          persistenceFailure = true;
          return;
        }
        counters.accepted += 1;
      } catch (sendError) {
        counters.failed += 1;
        const finalized = await finalizeReminder(
          supabase,
          reservation.log_id,
          "failed",
          null,
          safeErrorMessage(sendError),
        );
        if (!finalized) persistenceFailure = true;
      }
    };

    const worker = async () => {
      while (true) {
        const appointmentIndex = nextAppointmentIndex;
        nextAppointmentIndex += 1;
        const appointment = eligibleAppointments[appointmentIndex];
        if (!appointment) return;
        await processAppointment(appointment);
      }
    };

    const workerCount = Math.min(
      MAX_SEND_CONCURRENCY,
      eligibleAppointments.length,
    );
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );

    const processingFailed = counters.failed > 0 || persistenceFailure;
    return jsonResponse(
      responsePayload(!processingFailed, counters, templateStatus),
      processingFailed ? 502 : 200,
    );
  } catch {
    return jsonResponse(
      responsePayload(false, counters, templateStatus, {
        error: "reminder_processing_failed",
      }),
      500,
    );
  }
});
