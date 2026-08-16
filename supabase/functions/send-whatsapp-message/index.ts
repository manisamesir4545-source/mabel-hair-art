import {
  adminTemplateParams,
  AppointmentPayload,
  corsHeaders,
  customerTemplateParams,
  getSupabaseAdmin,
  logMessage,
  normalizePhone,
  sendTemplateMessage,
  templateNameFor,
} from "../_shared/whatsapp.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const event = String(body.event || "");
    const appointment = (body.appointment || {}) as AppointmentPayload;

    if (!["appointment_created", "appointment_cancelled"].includes(event)) {
      return Response.json({ ok: false, error: "Unsupported event" }, { status: 400, headers: corsHeaders });
    }

    const phone = normalizePhone(appointment.phone);
    if (!phone) {
      return Response.json({ ok: false, error: "Appointment phone is required" }, { status: 400, headers: corsHeaders });
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return Response.json({ ok: false, error: "Supabase service role secret missing" }, { status: 500, headers: corsHeaders });
    }

    const expectedStatus = event === "appointment_cancelled" ? "cancelled" : "active";
    const staffKey = String(appointment.staffId || appointment.staffKey || "mabel");
    const serviceKey = String(appointment.serviceId || "");
    let validationQuery = supabase
      .from("appointments")
      .select("id, customer_name, phone, service, appointment_date, appointment_time, staff_key, status")
      .eq("phone", phone)
      .eq("appointment_date", appointment.date)
      .eq("appointment_time", appointment.time)
      .eq("staff_key", staffKey)
      .eq("status", expectedStatus)
      .limit(1);

    if (serviceKey) {
      validationQuery = validationQuery.eq("service", serviceKey);
    }

    const { data: matchingAppointments, error: validationError } = await validationQuery;
    if (validationError) throw validationError;

    const savedAppointment = matchingAppointments?.[0];
    if (!savedAppointment) {
      return Response.json({ ok: false, error: "Appointment could not be verified" }, { status: 403, headers: corsHeaders });
    }

    appointment.id = savedAppointment.id;
    appointment.customerName = appointment.customerName || savedAppointment.customer_name;
    appointment.phone = savedAppointment.phone;

    const customerTemplateName = templateNameFor(event);
    const customerResult = await sendTemplateMessage(phone, customerTemplateName, customerTemplateParams(appointment));
    await logMessage({
      appointmentId: appointment.id,
      event,
      phone,
      templateName: customerTemplateName,
      status: "sent",
      response: customerResult,
    });

    const adminPhone = normalizePhone(Deno.env.get("WHATSAPP_ADMIN_PHONE"));
    let adminErrorMessage = "";
    if (event === "appointment_created" && adminPhone) {
      const adminTemplateName = templateNameFor("admin_new_appointment");
      try {
        const adminResult = await sendTemplateMessage(adminPhone, adminTemplateName, adminTemplateParams(appointment));
        await logMessage({
          appointmentId: appointment.id,
          event: "admin_new_appointment",
          phone: adminPhone,
          templateName: adminTemplateName,
          status: "sent",
          response: adminResult,
        });
      } catch (adminError) {
        adminErrorMessage = adminError instanceof Error ? adminError.message : "Admin message failed";
        await logMessage({
          appointmentId: appointment.id,
          event: "admin_new_appointment",
          phone: adminPhone,
          templateName: adminTemplateName,
          status: "failed",
          error: adminErrorMessage,
        });
      }
    }

    return Response.json({ ok: true, adminError: adminErrorMessage || null }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await logMessage({ event: "function_error", status: "failed", error: message });
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
