require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function normalizePhone(number) {
  if (!number) return "";
  number = String(number).replace(/\D/g, "");
  if (number.length === 10) number = "1" + number;
  return "+" + number;
}

function displayPhone(normalized) {
  const digits = normalized.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return normalized;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function todayLabel() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Chicago",
  });
}

function readableTime(isoString) {
  const slotDate = new Date(isoString);
  const tz = "America/Chicago";
  const toDateKey = (d) =>
    d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const timeStr = slotDate.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  if (toDateKey(slotDate) === toDateKey(new Date())) return `today at ${timeStr}`;
  if (toDateKey(slotDate) === toDateKey(tomorrow)) return `tomorrow at ${timeStr}`;
  return slotDate.toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz,
  });
}

function readableDay(isoString) {
  return new Date(isoString).toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago",
  });
}

function readableHour(isoString) {
  return new Date(isoString).toLocaleString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });
}

function noSlotsMessage() {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const ct = new Date(now);
  const day = ct.getDay();
  const totalMinutes = ct.getHours() * 60 + ct.getMinutes();
  const withinResponseWindow =
    (day >= 1 && day <= 4 && totalMinutes < 16 * 60 + 30) ||
    (day === 5 && totalMinutes < 14 * 60 + 30);
  if (withinResponseWindow) {
    return "There are no available slots on the calendar right now, but the intake team will see your information and reach out within the next 15 minutes or so.";
  }
  return "There are no available slots on the calendar right now, but rest assured the intake team will be in touch with you first thing when the office opens.";
}

// ─────────────────────────────────────────────
// SUPABASE LEAD HELPERS
// ─────────────────────────────────────────────
async function createLead(data) {
  const lead = {
    name: data.name || data.first_name || "Unknown",
    phone: normalizePhone(data.phone || data.number || ""),
    email: data.email || "",
    source: data.source || "facebook",
    call_status: "pending",
    call_attempts: 0,
    appointment_booked: false,
    appointment_time: null,
    form_data: data,
  };
  const { data: row, error } = await supabase
    .from("blg_outbound_leads")
    .insert(lead)
    .select()
    .single();
  if (error) {
    console.error("Error creating lead:", error.message);
    // Return a local object so the call can still proceed
    return { ...lead, id: Date.now().toString() };
  }
  return row;
}

async function updateLead(id, fields) {
  const { error } = await supabase.from("blg_outbound_leads").update(fields).eq("id", id);
  if (error) console.error("Error updating lead:", error.message);
}

async function getLeadByCallId(callId) {
  if (!callId) return null;
  const { data } = await supabase
    .from("blg_outbound_leads")
    .select("*")
    .eq("call_id", callId)
    .maybeSingle();
  return data || null;
}

async function getLeadByPhone(phone) {
  if (!phone) return null;
  const { data } = await supabase
    .from("blg_outbound_leads")
    .select("*")
    .eq("phone", normalizePhone(phone))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function getLeadByMulti({ callId, phone }) {
  if (callId) {
    const lead = await getLeadByCallId(callId);
    if (lead) return lead;
  }
  if (phone) {
    const lead = await getLeadByPhone(phone);
    if (lead) return lead;
  }
  return null;
}

// ─────────────────────────────────────────────
// CALENDLY
// ─────────────────────────────────────────────
async function getCalendlyUserUri() {
  const response = await axios.get("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`, "Content-Type": "application/json" },
  });
  return response.data.resource.current_organization;
}

async function getEventTypeUri(orgUri) {
  const response = await axios.get("https://api.calendly.com/event_types", {
    headers: { Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`, "Content-Type": "application/json" },
    params: { organization: orgUri, count: 100 },
  });
  const slug = process.env.CALENDLY_EVENT_SLUG;
  const eventType = response.data.collection.find((e) => e.scheduling_url.includes(slug));
  if (!eventType) throw new Error(`Event type with slug "${slug}" not found`);
  console.log("Event type found:", eventType.uri);
  return eventType.uri;
}

async function getAvailableSlots() {
  const orgUri = await getCalendlyUserUri();
  const eventTypeUri = await getEventTypeUri(orgUri);
  const startTime = new Date(Date.now() + 60 * 1000).toISOString();
  const endTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const response = await axios.get("https://api.calendly.com/event_type_available_times", {
    headers: { Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`, "Content-Type": "application/json" },
    params: { event_type: eventTypeUri, start_time: startTime, end_time: endTime },
  });
  const grouped = {};
  for (const slot of response.data.collection) {
    const dayLabel = new Date(slot.start_time).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago",
    });
    if (!grouped[dayLabel]) grouped[dayLabel] = [];
    if (grouped[dayLabel].length < 4) {
      grouped[dayLabel].push({ readable: readableTime(slot.start_time), start_time: slot.start_time });
    }
  }
  return grouped;
}

async function bookAppointment({ name, email, start_time, phone }) {
  const orgUri = await getCalendlyUserUri();
  const eventTypeUri = await getEventTypeUri(orgUri);
  console.log("BOOKING INPUT:", { name, email, start_time, phone, eventTypeUri });
  const payload = {
    event_type: eventTypeUri,
    start_time,
    invitee: { name, email, timezone: "America/Chicago" },
    questions_and_answers: phone
      ? [{ question: "Phone Number", answer: String(phone), position: 0 }]
      : [],
  };
  console.log("BOOKING PAYLOAD:", JSON.stringify(payload, null, 2));
  const response = await axios.post("https://api.calendly.com/invitees", payload, {
    headers: { Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`, "Content-Type": "application/json" },
  });
  const invitee = response.data?.resource;
  console.log("BOOKING SUCCESS:", JSON.stringify(response.data, null, 2));
  return {
    success: true,
    invitee_uri: invitee?.uri || null,
    event_uri: invitee?.event || null,
    reschedule_url: invitee?.reschedule_url || null,
    cancel_url: invitee?.cancel_url || null,
    start_time, name, email,
  };
}

// ─────────────────────────────────────────────
// RETELL — TRIGGER OUTBOUND CALL
// ─────────────────────────────────────────────
async function triggerRetellCall(lead) {
  const firstName = lead.name?.split(" ")[0] || "there";
  const isRetry = (lead.call_attempts || 0) >= 2;

  const voicemailMessage = isRetry
    ? `Hi ${firstName} — this is Grace calling from Buchanan Law Group. You filled out a form about your situation and I just wanted to follow up. Give us a call back at your convenience at 312-757-4833 — again, that's 312-757-4833. Talk soon.`
    : null;

  const formData = lead.form_data || {};

  const response = await axios.post(
    "https://api.retellai.com/v2/create-phone-call",
    {
      agent_id: process.env.RETELL_AGENT_ID,
      from_number: process.env.TWILIO_PHONE_NUMBER,
      to_number: lead.phone,
      ...(voicemailMessage && { voicemail_message: voicemailMessage }),
      retell_llm_dynamic_variables: {
        first_name: firstName,
        phone_number: displayPhone(lead.phone),
        today: todayLabel(),
        // Spread all raw form fields as dynamic variables
        ...Object.fromEntries(
          Object.entries(formData).map(([k, v]) => [k, String(v ?? "")])
        ),
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
}

// ═════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════

// Health check
app.get("/", (req, res) => {
  res.json({ status: "BLG Outbound Agent running" });
});

// ─────────────────────────────────────────────
// Facebook / Zapier lead webhook
// POST /new-lead
// ─────────────────────────────────────────────
app.post("/new-lead", async (req, res) => {
  try {
    const data = req.body;
    console.log("New lead received:", data);

    if (!data.phone && !data.number) {
      return res.status(400).json({ message: "Lead missing phone number" });
    }

    const isDebug = data.debug === true || data.debug === "true";
    const lead = await createLead(data);
    console.log(`Lead created: ${lead.name} — ${lead.phone} | debug=${isDebug}`);

    if (isDebug) {
      await updateLead(lead.id, { call_status: "debug_skipped" });
      return res.json({ success: true, leadId: lead.id, message: "Lead received (debug mode — no call placed)" });
    }

    await updateLead(lead.id, { call_attempts: 1 });

    triggerRetellCall({ ...lead, call_attempts: 1 })
      .then(async (callResult) => {
        const callId = callResult.call_id || callResult.id;
        await updateLead(lead.id, { call_id: callId, call_status: "queued" });
        console.log(`Call queued for ${lead.name} (attempt 1): ${callId}`);
      })
      .catch(async (err) => {
        await updateLead(lead.id, { call_status: "call_failed" });
        console.error("Call trigger failed:", err.response?.data || err.message);
      });

    res.json({ success: true, leadId: lead.id, message: "Lead received, call queued" });
  } catch (error) {
    console.error("Lead webhook error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// ─────────────────────────────────────────────
// Manual test call
// GET /start-call?number=7737101160&name=Bobby
// ─────────────────────────────────────────────
app.get("/start-call", async (req, res) => {
  try {
    const { number, name } = req.query;
    if (!number) return res.status(400).json({ message: "Missing ?number=" });

    const lead = await createLead({
      phone: number,
      name: name || "Test Lead",
      source: "test",
    });

    const callResult = await triggerRetellCall(lead);
    const callId = callResult.call_id || callResult.id;
    await updateLead(lead.id, { call_id: callId, call_status: "queued", call_attempts: 1 });

    res.json({ success: true, lead, callResult });
  } catch (error) {
    console.error("Start call error:", error.response?.data || error.message);
    res.status(500).json({ message: "Call failed", error: error.response?.data || error.message });
  }
});

// ─────────────────────────────────────────────
// Retell Tool: Get available Calendly slots
// POST /get-available-slots
// ─────────────────────────────────────────────
app.post("/get-available-slots", async (req, res) => {
  try {
    console.log("Fetching Calendly available slots...");
    const grouped = await getAvailableSlots();

    if (Object.keys(grouped).length === 0) {
      return res.json({ result: noSlotsMessage(), days: [] });
    }

    const days = Object.entries(grouped).map(([day, slots]) => ({ day, slots }));
    const summary = days
      .map((d) => `${d.day}: ${d.slots.map((s) => s.readable.split(", ").pop()).join(", ")}`)
      .join(" | ");

    res.json({ result: `Available times by day — ${summary}`, days });
  } catch (error) {
    console.error("Get slots error:", error.response?.data || error.message);
    res.json({ result: noSlotsMessage(), error: error.message });
  }
});

// ─────────────────────────────────────────────
// Retell Tool: Book appointment
// POST /book-appointment
// ─────────────────────────────────────────────
app.post("/book-appointment", async (req, res) => {
  const payload = req.body?.args || req.body || {};
  const callId = req.body?.call?.call_id || null;
  const fromNumber = req.body?.call?.from_number || null;
  const { name, start_time, phone } = payload;

  // Resolve lead from DB
  const lead = await getLeadByMulti({ callId, phone: phone || fromNumber });

  // Resolve email: prefer form data, fall back to auto-generated
  const digits = String(phone || "").replace(/\D/g, "").slice(-10);
  const email =
    lead?.form_data?.email ||
    (digits ? `intake+${digits}@${process.env.EMAIL_DOMAIN || "buchananlaw.com"}` : null);

  console.log("Book appointment:", { name, start_time, phone, callId, email });

  try {
    if (!name || !phone || !start_time) {
      return res.json({
        result: "I'm missing some details to complete the booking. The lead can book directly at " + process.env.CALENDLY_URL,
        appointment_day: "",
        appointment_time: "",
      });
    }

    const booking = await bookAppointment({ name, email, start_time, phone });

    // Only mark booked on confirmed Calendly API success
    if (lead) {
      await updateLead(lead.id, {
        appointment_booked: true,
        appointment_time: start_time,
        call_id: callId || lead.call_id,
      });
    }

    res.json({
      result: `Booked: Appointment confirmed for ${readableDay(start_time)} at ${readableHour(start_time)}. Our Intake Specialist will call at that time.`,
      appointment_day: readableDay(start_time),
      appointment_time: readableHour(start_time),
      booking,
    });
  } catch (error) {
    console.error("Book appointment error:", error.response?.data || error.message);
    res.json({
      result: `I wasn't able to lock that in on my end. ${noSlotsMessage()}`,
      appointment_day: "",
      appointment_time: "",
      error: error.response?.data || error.message,
    });
  }
});

// ─────────────────────────────────────────────
// Retell webhook
// POST /retell-webhook
// ─────────────────────────────────────────────
app.post("/retell-webhook", async (req, res) => {
  try {
    const event = req.body;
    const eventType = event.event;
    const call = event.call || event.data || {};
    const callId = call.call_id;

    console.log(`Retell event: ${eventType} | Call: ${callId}`);

    if (eventType === "call_started") {
      const lead = await getLeadByCallId(callId);
      if (lead) await updateLead(lead.id, { call_status: "in_progress" });
    }

    if (eventType === "call_ended") {
      const summary = call.call_analysis?.call_summary || "";
      const transcript = call.transcript || "";
      const endedReason = call.disconnection_reason || "";
      const duration = call.duration_ms || 0;

      const lead = await getLeadByCallId(callId);
      const noAnswer =
        endedReason === "dial_no_answer" || endedReason === "customer_did_not_pick_up";

      if (lead) {
        await updateLead(lead.id, {
          call_status: "completed",
          ended_reason: endedReason,
          summary,
          transcript: transcript.slice(0, 2000),
          duration_ms: duration,
        });

        // Retry on no-answer, max 2 attempts total
        if (noAnswer && (lead.call_attempts || 1) < 2) {
          const newAttempts = (lead.call_attempts || 1) + 1;
          await updateLead(lead.id, { call_attempts: newAttempts, call_status: "queued" });
          console.log(`No answer — retrying (attempt ${newAttempts})`);
          triggerRetellCall({ ...lead, call_attempts: newAttempts })
            .then(async (callResult) => {
              const newCallId = callResult.call_id || callResult.id;
              await updateLead(lead.id, { call_id: newCallId });
              console.log(`Retry call queued: ${newCallId}`);
            })
            .catch((err) => console.error("Retry call failed:", err.response?.data || err.message));
          return res.sendStatus(200);
        }
      }

      // Derive result label
      const apptBooked = lead?.appointment_booked || false;
      const apptTime = lead?.appointment_time || null;
      let result = "no_appointment";
      if (apptBooked && apptTime) result = "appointment_scheduled";
      else if (endedReason === "user_hangup") result = "user_hangup";
      else if (noAnswer) result = "customer_did_not_pick_up";
      else if (summary.toLowerCase().includes("not interested") || summary.toLowerCase().includes("no interest"))
        result = "not_interested";
      else if (
        summary.toLowerCase().includes("disqualif") ||
        summary.toLowerCase().includes("wrong geography") ||
        summary.toLowerCase().includes("not in illinois")
      )
        result = "disqualified";

      // Zapier / Podio webhook
      const zapierPayload = {
        call_id: callId,
        agent_id: call.agent_id || "",
        call_type: call.call_type || "outbound",
        call_status: call.call_status || "",
        from_number: call.from_number || "",
        to_number: call.to_number || "",
        ended_reason: endedReason,
        duration_ms: duration,
        duration_seconds: Math.round(duration / 1000),
        start_timestamp: call.start_timestamp || "",
        end_timestamp: call.end_timestamp || "",

        lead_id: lead?.id || "",
        name: lead?.name || call.retell_llm_dynamic_variables?.first_name || "",
        phone: lead?.phone || call.to_number || "",
        source: lead?.source || "",
        email: lead?.form_data?.email || "",

        // All original form fields
        ...(lead?.form_data || {}),

        result,
        appointment_booked: apptBooked,
        appointment_time: apptTime ? readableTime(apptTime) : "",
        appointment_time_iso: apptTime || "",

        summary,
        transcript,
        call_successful: call.call_analysis?.call_successful ?? null,
        user_sentiment: call.call_analysis?.user_sentiment || "",
        agent_task_completion_rating: call.call_analysis?.agent_task_completion_rating || "",
      };

      const zapierUrl = process.env.ZAPIER_WEBHOOK_URL;
      if (zapierUrl) {
        axios.post(zapierUrl, zapierPayload)
          .catch((e) => console.error("Zapier webhook failed:", e.message));
      }

      const podioUrl = process.env.PODIO_WEBHOOK_URL;
      if (podioUrl) {
        axios.post(podioUrl, zapierPayload)
          .catch((e) => console.error("Podio webhook failed:", e.message));
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(200);
  }
});

module.exports = app;
