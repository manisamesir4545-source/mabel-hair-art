import {
  AppointmentPayload,
  corsHeaders,
  customerTemplateParams,
  getSupabaseAdmin,
  logMessage,
  normalizePhone,
  sendTemplateMessage,
  templateNameFor,
} from "../_shared/whatsapp.ts";

function appointmentDateTime(appointment: AppointmentPayload) {
  return new Date(`${appointment.date}T${appointment.time}:00+03:00`);
}

function isoDateInIstanbul(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return Response.json({ ok: false, error: "Supabase service role secret missing" }, { status: 500, headers: corsHeaders });
  }

  try {
    const now = new Date();
    const reminderHours = Number(Deno.env.get("WHATSAPP_REMINDER_HOURS") || "2");
    const windowStart = new Date(now.getTime() + (reminderHours * 60 - 10) * 60 * 1000);
    const windowEnd = new Date(now.getTime() + (reminderHours * 60 + 10) * 60 * 1000);
    const startDate = isoDateInIstanbul(windowStart);
    const endDate = isoDateInIstanbul(windowEnd);

    const { data: rows, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("status", "active")
      .gte("appointment_date", startDate)
      .lte("appointment_date", endDate);

    if (error) throw error;

    const templateName = templateNameFor("appointment_reminder");
    let sent = 0;
    let skipped = 0;

    for (const row of rows || []) {
      const appointment: AppointmentPayload = {
        id: row.id,
        customerName: row.customer_name,
        phone: row.phone,
        serviceName: row.service,
        staffName: row.staff_key,
        date: row.appointment_date,
        time: row.appointment_time,
      };

      const dateTime = appointmentDateTime(appointment);
      if (dateTime < windowStart || dateTime > windowEnd) continue;

      const dedupeKey = `appointment_reminder:${appointment.id}:${appointment.date}:${appointment.time}`;
      const { data: existing } = await supabase
        .from("message_logs")
        .select("id")
        .eq("dedupe_key", dedupeKey)
        .eq("status", "sent")
        .maybeSingle();

      if (existing) {
        skipped += 1;
        continue;
      }

      try {
        const result = await sendTemplateMessage(normalizePhone(appointment.phone), templateName, customerTemplateParams(appointment));
        await logMessage({
          appointmentId: appointment.id,
          event: "appointment_reminder",
          phone: appointment.phone,
          templateName,
          status: "sent",
          response: result,
          dedupeKey,
        });
        sent += 1;
      } catch (sendError) {
        await logMessage({
          appointmentId: appointment.id,
          event: "appointment_reminder",
          phone: appointment.phone,
          templateName,
          status: "failed",
          error: sendError instanceof Error ? sendError.message : "Unknown error",
          dedupeKey,
        });
      }
    }

    return Response.json({ ok: true, sent, skipped }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await logMessage({ event: "reminder_function_error", status: "failed", error: message });
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
