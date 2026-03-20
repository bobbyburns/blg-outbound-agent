require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

app.use((req, res, next) => {
  express.json({ limit: "10mb" })(req, res, (err) => {
    if (err) {
      console.error("JSON parse error:", err.message);
      console.error("Raw body (first 500 chars):", req.body);
      return res.status(400).json({ message: "Invalid JSON", error: err.message });
    }
    next();
  });
});
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─────────────────────────────────────────────
// IN-MEMORY LEAD STORE
// ─────────────────────────────────────────────
const leads = [];

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
  // +17737101160 → (773) 710-1160
  const digits = normalized.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return normalized;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function logLead(data) {
  // Strip system fields so only form data ends up in formData
  const { phone, number, source, ...rest } = data;
  const lead = {
    id: Date.now().toString(),
    firstName: data.first_name || data.name || "Unknown",
    phone: normalizePhone(phone || number || ""),
    source: source || "facebook",
    formData: rest,           // all raw form fields preserved here
    receivedAt: new Date().toISOString(),
    callStatus: "pending",
    callId: null,
    qualificationData: {},
    appointmentBooked: false,
    appointmentTime: null,
  };
  leads.unshift(lead);
  return lead;
}

function readableTime(isoString) {
  const slotDate = new Date(isoString);
  const tz = "America/Chicago";

  const toDateKey = (d) =>
    d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" });

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeStr = slotDate.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });

  if (toDateKey(slotDate) === toDateKey(new Date())) return `today at ${timeStr}`;
  if (toDateKey(slotDate) === toDateKey(tomorrow)) return `tomorrow at ${timeStr}`;

  return slotDate.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
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

function readableDay(isoString) {
  return new Date(isoString).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });
}

function readableHour(isoString) {
  return new Date(isoString).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

// ─────────────────────────────────────────────
// CALENDLY — GET ORG URI
// ─────────────────────────────────────────────
async function getCalendlyUserUri() {
  const response = await axios.get("https://api.calendly.com/users/me", {
    headers: {
      Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return response.data.resource.current_organization;
}

// ─────────────────────────────────────────────
// CALENDLY — GET EVENT TYPE URI from slug
// ─────────────────────────────────────────────
async function getEventTypeUri(orgUri) {
  const response = await axios.get("https://api.calendly.com/event_types", {
    headers: {
      Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`,
      "Content-Type": "application/json",
    },
    params: { organization: orgUri, count: 100 },
  });

  const slug = process.env.CALENDLY_EVENT_SLUG;
  const eventType = response.data.collection.find((e) =>
    e.scheduling_url.includes(slug)
  );

  if (!eventType) throw new Error(`Event type with slug "${slug}" not found`);
  console.log("Event type found:", eventType.uri);
  return eventType.uri;
}

// ─────────────────────────────────────────────
// CALENDLY — GET AVAILABLE SLOTS
// ─────────────────────────────────────────────
async function getAvailableSlots() {
  const userUri = await getCalendlyUserUri();
  const eventTypeUri = await getEventTypeUri(userUri);

  const startTime = new Date(Date.now() + 60 * 1000).toISOString(); // 60s buffer
  const endTime = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  const response = await axios.get(
    "https://api.calendly.com/event_type_available_times",
    {
      headers: {
        Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`,
        "Content-Type": "application/json",
      },
      params: {
        event_type: eventTypeUri,
        start_time: startTime,
        end_time: endTime,
      },
    }
  );

  // Group all slots by day (up to 4 slots per day, across all 5 days)
  const grouped = {};
  for (const slot of response.data.collection) {
    const dayLabel = new Date(slot.start_time).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "America/Chicago",
    });
    if (!grouped[dayLabel]) grouped[dayLabel] = [];
    if (grouped[dayLabel].length < 4) {
      grouped[dayLabel].push({
        readable: readableTime(slot.start_time),
        start_time: slot.start_time,
      });
    }
  }

  return grouped;
}

// ─────────────────────────────────────────────
// CALENDLY — BOOK APPOINTMENT
// ─────────────────────────────────────────────
async function bookAppointment({ name, email, start_time, phone }) {
  const userUri = await getCalendlyUserUri();
  const eventTypeUri = await getEventTypeUri(userUri);

  console.log("BOOKING INPUT:", { name, email, start_time, phone, eventTypeUri });

  const payload = {
    event_type: eventTypeUri,
    start_time,
    invitee: {
      name,
      email,
      timezone: "America/Chicago",
    },
    questions_and_answers: phone
      ? [{ question: "Phone Number", answer: String(phone), position: 0 }]
      : [],
  };

  console.log("BOOKING PAYLOAD:", JSON.stringify(payload, null, 2));

  const response = await axios.post(
    "https://api.calendly.com/invitees",
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const invitee = response.data?.resource;
  console.log("BOOKING SUCCESS:", JSON.stringify(response.data, null, 2));

  return {
    success: true,
    invitee_uri: invitee?.uri || null,
    event_uri: invitee?.event || null,
    reschedule_url: invitee?.reschedule_url || null,
    cancel_url: invitee?.cancel_url || null,
    start_time,
    name,
    email,
  };
}

// ─────────────────────────────────────────────
// RETELL — TRIGGER OUTBOUND CALL
// ─────────────────────────────────────────────
async function triggerRetellCall(lead) {
  const response = await axios.post(
    "https://api.retellai.com/v2/create-phone-call",
    {
      agent_id: process.env.RETELL_AGENT_ID,
      from_number: process.env.TWILIO_PHONE_NUMBER,
      to_number: lead.phone,
      retell_llm_dynamic_variables: {
        // Always-present system vars
        first_name: lead.firstName,
        phone_number: displayPhone(lead.phone),
        // Spread all raw form fields — every key becomes a [variable] in the prompt
        ...Object.fromEntries(
          Object.entries(lead.formData || {}).map(([k, v]) => [k, String(v ?? "")])
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
  res.json({ status: "BLG Outbound Agent running", leads: leads.length });
});

// ─────────────────────────────────────────────
// Manual test call
// GET /start-call?number=7737101160&name=Bobby
// ─────────────────────────────────────────────
app.get("/start-call", async (req, res) => {
  try {
    const { number, name } = req.query;
    if (!number) return res.status(400).json({ message: "Missing ?number=" });

    const lead = logLead({
      phone: number,
      first_name: name || "Test Lead",
      divorce_type: "uncontested",
      has_real_estate: false,
      has_children: false,
      description: "Test call",
    });

    const callResult = await triggerRetellCall(lead);
    lead.callId = callResult.call_id || callResult.id;
    lead.callStatus = "queued";

    res.json({ success: true, lead, callResult });
  } catch (error) {
    console.error("Start call error:", error.response?.data || error.message);
    res.status(500).json({ message: "Call failed", error: error.response?.data || error.message });
  }
});

// ─────────────────────────────────────────────
// Facebook / Zapier lead webhook
// POST /new-lead
// Expected fields: first_name, phone/number, divorce_type,
//                  has_real_estate, has_children, description
// ─────────────────────────────────────────────
app.post("/new-lead", async (req, res) => {
  try {
    const data = req.body;
    console.log("New lead received:", data);

    if (!data.phone && !data.number) {
      return res.status(400).json({ message: "Lead missing phone number" });
    }

    const isDebug = data.debug !== false && data.debug !== "false"; // handles both boolean and string
    const lead = logLead(data);
    console.log(`Lead created: ${lead.firstName} — ${lead.phone} | debug=${isDebug}`);

    if (isDebug) {
      lead.callStatus = "debug_skipped";
      console.log(`DEBUG MODE: skipping real call for ${lead.firstName}`);
      return res.json({ success: true, leadId: lead.id, message: "Lead received (debug mode — no call placed)" });
    }

    triggerRetellCall(lead)
      .then((callResult) => {
        lead.callId = callResult.call_id || callResult.id;
        lead.callStatus = "queued";
        console.log(`Call queued for ${lead.firstName}: ${lead.callId}`);
      })
      .catch((err) => {
        lead.callStatus = "call_failed";
        console.error("Call trigger failed:", err.response?.data || err.message);
      });

    res.json({ success: true, leadId: lead.id, message: "Lead received, call queued" });
  } catch (error) {
    console.error("Lead webhook error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// ─────────────────────────────────────────────
// Retell Tool: Get available Calendly slots
// POST /get-available-slots
// Returns time_slot_1, time_slot_2, next_available_time
// ─────────────────────────────────────────────
app.post("/get-available-slots", async (req, res) => {
  try {
    console.log("Fetching Calendly available slots...");
    const grouped = await getAvailableSlots();

    if (Object.keys(grouped).length === 0) {
      return res.json({
        result: noSlotsMessage(),
        days: [],
      });
    }

    const days = Object.entries(grouped).map(([day, slots]) => ({ day, slots }));
    const summary = days
      .map((d) => `${d.day}: ${d.slots.map((s) => s.readable.split(", ").pop()).join(", ")}`)
      .join(" | ");

    res.json({
      result: `Available times by day — ${summary}`,
      days,
    });
  } catch (error) {
    console.error("Get slots error:", error.response?.data || error.message);
    res.json({
      result: noSlotsMessage(),
      error: error.message,
    });
  }
});

// ─────────────────────────────────────────────
// Retell Tool: Book appointment
// POST /book-appointment
// Args: name, phone, start_time
// ─────────────────────────────────────────────
app.post("/book-appointment", async (req, res) => {
  const payload = req.body?.args || req.body || {};
  const callId = req.body?.call?.call_id || null;
  const { name, start_time, phone } = payload;

  // Auto-generate email from phone: intake+7737101160@buchananlaw.com
  const digits = String(phone || "").replace(/\D/g, "").slice(-10);
  const email = digits ? `intake+${digits}@${process.env.EMAIL_DOMAIN || "buchananlaw.com"}` : null;

  console.log("Book appointment payload:", payload, "callId:", callId, "email:", email);

  try {
    if (!name || !phone || !start_time) {
      return res.json({
        result: "I'm missing some details to complete the booking. The lead can book directly at " + process.env.CALENDLY_URL,
        appointment_day: "",
        appointment_time: "",
      });
    }

    const booking = await bookAppointment({ name, email, start_time, phone });

    const appointment_day = readableDay(start_time);
    const appointment_time = readableHour(start_time);

    // Find or create lead record
    let lead = leads.find(
      (l) => l.callId === callId || l.phone === normalizePhone(phone) || l.firstName === name
    );
    if (!lead) {
      lead = logLead({ first_name: name, phone, source: "outbound" });
    }
    lead.callId = callId || lead.callId;
    lead.appointmentBooked = true;
    lead.appointmentTime = start_time;

    res.json({
      result: `Booked: Appointment confirmed for ${appointment_day} at ${appointment_time}. Our Intake Specialist will call at that time.`,
      appointment_day,
      appointment_time,
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
// Retell call outcome webhook
// POST /retell-webhook
// ─────────────────────────────────────────────
app.post("/retell-webhook", async (req, res) => {
  try {
    const event = req.body;
    const eventType = event.event;
    const call = event.call || event.data || {};
    const callId = call.call_id;

    console.log(`Retell event: ${eventType} | Call: ${callId}`);

    const lead = leads.find((l) => l.callId === callId);

    if (eventType === "call_started" && lead) {
      lead.callStatus = "in_progress";
    }

    if (eventType === "call_ended") {
      const summary = call.call_analysis?.call_summary || "";
      const transcript = call.transcript || "";
      const endedReason = call.disconnection_reason || "";
      const duration = call.duration_ms || 0;

      if (lead) {
        lead.callStatus = "completed";
        lead.qualificationData = {
          summary,
          endedReason,
          duration,
          transcript: transcript.slice(0, 500),
        };

        if (
          summary.toLowerCase().includes("book") ||
          summary.toLowerCase().includes("confirmed") ||
          summary.toLowerCase().includes("schedul")
        ) {
          lead.appointmentBooked = true;
        }
      }

      // Derive result label
      const apptBooked = lead?.appointmentBooked || false;
      const apptTime = lead?.appointmentTime || null;
      let result = "no_appointment";
      if (apptBooked && apptTime) result = "appointment_scheduled";
      else if (endedReason === "user_hangup") result = "user_hangup";
      else if (endedReason === "customer_did_not_pick_up") result = "customer_did_not_pick_up";
      else if (
        summary.toLowerCase().includes("not interested") ||
        summary.toLowerCase().includes("no interest")
      )
        result = "not_interested";
      else if (
        summary.toLowerCase().includes("disqualif") ||
        summary.toLowerCase().includes("wrong geography") ||
        summary.toLowerCase().includes("not in illinois")
      )
        result = "disqualified";

      // Send call data to Zapier
      const zapierUrl = process.env.ZAPIER_WEBHOOK_URL;
      if (zapierUrl) {
        axios
          .post(zapierUrl, {
            call_id: callId,
            name: lead?.firstName || call.retell_llm_dynamic_variables?.first_name || "",
            phone: lead?.phone || call.to_number || "",
            from_number: call.from_number || "",
            to_number: call.to_number || "",
            result,
            appointment_booked: apptBooked,
            appointment_time: apptTime ? readableTime(apptTime) : "",
            appointment_time_iso: apptTime || "",
            // All original form fields passed back for CRM logging
            ...(lead?.formData || {}),
            summary,
            transcript,
            ended_reason: endedReason,
            duration_ms: duration,
            received_at: lead?.receivedAt || new Date().toISOString(),
          })
          .catch((e) => console.error("Zapier webhook failed:", e.message));
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(200);
  }
});

// ─────────────────────────────────────────────
// Leads dashboard
// ─────────────────────────────────────────────
app.get("/leads", (req, res) => {
  res.json({ total: leads.length, leads });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nBLG Outbound Agent running on port ${PORT}`);
  console.log(`Zapier lead webhook:  POST /new-lead`);
  console.log(`Retell webhook:       POST /retell-webhook`);
  console.log(`Calendly slots:       POST /get-available-slots`);
  console.log(`Calendly book:        POST /book-appointment`);
  console.log(`Test call:            GET  /start-call?number=XXXXXXXXXX&name=Test`);
  console.log(`Leads dashboard:      GET  /leads\n`);
});
