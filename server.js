const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const QRCode = require("qrcode");
const db = require("./db");

const app = express();
app.use(express.json());

// Serve the website files from the "public" folder
app.use(express.static(require("path").join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET. Create a .env file and start with npm start.");
  process.exit(1);
}


// Edit this list to match your college's departments
const DEPARTMENTS = ["IT", "CSE", "AIDS", "ECE", "EEE", "MECH", "CIVIL", "OTHER"];

app.get("/api/departments", (req, res) => {
  res.json(DEPARTMENTS);
});

// ---- Sign up ----
app.post("/api/signup", (req, res) => {
  const { name, email, password, role, department } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const dept = department ? String(department).trim().toUpperCase() : null;
  if (dept && !DEPARTMENTS.includes(dept)) {
    return res.status(400).json({ error: "Please choose a valid department" });
  }

  const userRole = role === "organizer" ? "organizer" : "student";
  const cleanEmail = email.trim().toLowerCase();
  const hash = bcrypt.hashSync(password, 10);

  try {
    const result = db
      .prepare("INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)")
      .run(name.trim(), cleanEmail, hash, userRole, dept);

    res.status(201).json({
      id: Number(result.lastInsertRowid),
      name: name.trim(),
      email: cleanEmail,
      role: userRole,
      department: dept,
    });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ---- Login ----
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.trim().toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: "7d",
  });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department },
  });
});

// ---- Protect routes: check the token ----
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Please log in first" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/api/me", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, email, role, department FROM users WHERE id = ?")
    .get(req.user.id);
  res.json(user);
});

// ---- Only allow one role ----
function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can do this` });
    }
    next();
  };
}

// Event details plus how many seats are left
const EVENT_SELECT = `
  SELECT e.id, e.title, e.description, e.venue, e.event_date,
         e.seat_limit, e.organizer_id, e.allowed_departments, e.form_url,
         e.seat_limit - (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS seats_left
  FROM events e
`;

// Checks the optional "open to departments" list and Google Form link
function parseEventExtras(body) {
  const out = { departments: undefined, formUrl: undefined };

  if (body.allowed_departments !== undefined && body.allowed_departments !== null) {
    const list = Array.isArray(body.allowed_departments)
      ? body.allowed_departments
      : String(body.allowed_departments).split(",");
    const clean = [...new Set(list.map((d) => String(d).trim().toUpperCase()).filter(Boolean))];
    if (clean.some((d) => !DEPARTMENTS.includes(d))) {
      return { error: "Unknown department in allowed_departments" };
    }
    out.departments = clean.join(",");
  }

  if (body.form_url !== undefined) {
    const url = String(body.form_url || "").trim();
    if (url && (!/^https:\/\/\S+$/i.test(url) || url.length > 500)) {
      return { error: "form_url must be a valid https:// link" };
    }
    out.formUrl = url || null; // only https links are accepted, so nobody can store a javascript: link
  }
  return out;
}

// ---- Create an event (organizers only) ----
app.post("/api/events", requireAuth, requireRole("organizer"), (req, res) => {
  const { title, description, venue, event_date, seat_limit } = req.body;
  const extras = parseEventExtras(req.body);
  if (extras.error) {
    return res.status(400).json({ error: extras.error });
  }
  const seats = Number(seat_limit);

  if (!title || !venue || !event_date || !Number.isInteger(seats) || seats <= 0) {
    return res.status(400).json({
      error: "Title, venue, event_date and a positive whole-number seat_limit are required",
    });
  }
  if (Number.isNaN(Date.parse(event_date))) {
    return res.status(400).json({ error: "event_date must be a valid date" });
  }

  const result = db
    .prepare(
      "INSERT INTO events (title, description, venue, event_date, seat_limit, organizer_id, allowed_departments, form_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      title.trim(),
      description ? description.trim() : null,
      venue.trim(),
      event_date,
      seats,
      req.user.id,
      extras.departments || "",
      extras.formUrl || null
    );

  const event = db
    .prepare(EVENT_SELECT + " WHERE e.id = ?")
    .get(Number(result.lastInsertRowid));
  res.status(201).json(event);
});

// ---- List all events (logged-in users) ----
app.get("/api/events", requireAuth, (req, res) => {
  const events = db.prepare(EVENT_SELECT + " ORDER BY e.event_date ASC").all();
  res.json(events);
});

// ---- One event ----
app.get("/api/events/:id", requireAuth, (req, res) => {
  const event = db
    .prepare(EVENT_SELECT + " WHERE e.id = ?")
    .get(Number(req.params.id));
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  res.json(event);
});

// ---- Edit your own event ----
app.put("/api/events/:id", requireAuth, requireRole("organizer"), (req, res) => {
  const id = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);

  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  if (event.organizer_id !== req.user.id) {
    return res.status(403).json({ error: "You can only edit your own events" });
  }

  const title = req.body.title ?? event.title;
  const description = req.body.description ?? event.description;
  const venue = req.body.venue ?? event.venue;
  const eventDate = req.body.event_date ?? event.event_date;
  const seats =
    req.body.seat_limit !== undefined ? Number(req.body.seat_limit) : event.seat_limit;

  if (!Number.isInteger(seats) || seats <= 0) {
    return res.status(400).json({ error: "seat_limit must be a positive whole number" });
  }
  if (Number.isNaN(Date.parse(eventDate))) {
    return res.status(400).json({ error: "event_date must be a valid date" });
  }

  const registered = db
    .prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?")
    .get(id).n;
  if (seats < registered) {
    return res.status(400).json({
      error: `${registered} students have already registered, so seat_limit can't go below that`,
    });
  }

  const extras = parseEventExtras(req.body);
  if (extras.error) {
    return res.status(400).json({ error: extras.error });
  }
  const departments = extras.departments !== undefined ? extras.departments : event.allowed_departments;
  const formUrl = extras.formUrl !== undefined ? extras.formUrl : event.form_url;

  db.prepare(
    "UPDATE events SET title = ?, description = ?, venue = ?, event_date = ?, seat_limit = ?, allowed_departments = ?, form_url = ? WHERE id = ?"
  ).run(String(title).trim(), description, String(venue).trim(), eventDate, seats, departments, formUrl, id);

  res.json(db.prepare(EVENT_SELECT + " WHERE e.id = ?").get(id));
});

// ---- Register for an event (students only) ----
app.post("/api/events/:id/register", requireAuth, requireRole("student"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);

  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  if (Date.parse(event.event_date) < Date.now()) {
    return res.status(400).json({ error: "This event has already started" });
  }

  // Department-restricted events
  if (event.allowed_departments) {
    const allowed = event.allowed_departments.split(",");
    const me = db.prepare("SELECT department FROM users WHERE id = ?").get(req.user.id);
    if (!me.department || !allowed.includes(me.department)) {
      return res.status(403).json({ error: "This event is only for: " + allowed.join(", ") });
    }
  }

  // Events with a Google Form: the student must say they filled it
  if (event.form_url && !(req.body && req.body.form_confirmed === true)) {
    return res.status(400).json({ error: "Please fill the registration form first", form_url: event.form_url });
  }

  // Unguessable ticket code (this is what the QR code will hold on Day 6)
  const ticketCode = crypto.randomBytes(16).toString("hex");

  try {
    // Transaction: counting the seats and saving the registration happen as ONE unit
    db.exec("BEGIN IMMEDIATE");

    const taken = db
      .prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?")
      .get(eventId).n;

    if (taken >= event.seat_limit) {
      db.exec("ROLLBACK");
      return res.status(409).json({ error: "Event is full" });
    }

    const result = db
      .prepare("INSERT INTO registrations (user_id, event_id, ticket_code) VALUES (?, ?, ?)")
      .run(req.user.id, eventId, ticketCode);

    db.exec("COMMIT");

    res.status(201).json({
      registration_id: Number(result.lastInsertRowid),
      event_id: eventId,
      ticket_code: ticketCode,
      status: "Registered",
    });
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no open transaction to roll back
    }
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "You are already registered for this event" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ---- My tickets (students only) ----
app.get("/api/my-tickets", requireAuth, requireRole("student"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id AS registration_id, r.ticket_code, r.checked_in_at, r.created_at,
              e.id AS event_id, e.title, e.venue, e.event_date
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ?
       ORDER BY e.event_date ASC`
    )
    .all(req.user.id);

  res.json(
    rows.map((row) => ({
      ...row,
      status: row.checked_in_at ? "Checked in" : "Registered",
    }))
  );
});

// ---- One ticket with its QR image (students, own tickets only) ----
app.get("/api/tickets/:registrationId", requireAuth, requireRole("student"), async (req, res) => {
  const ticket = db
    .prepare(
      `SELECT r.id AS registration_id, r.user_id, r.ticket_code, r.checked_in_at,
              e.id AS event_id, e.title, e.venue, e.event_date
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       WHERE r.id = ?`
    )
    .get(Number(req.params.registrationId));

  // Same answer whether it doesn't exist or belongs to someone else
  if (!ticket || ticket.user_id !== req.user.id) {
    return res.status(404).json({ error: "Ticket not found" });
  }

  try {
    const qr = await QRCode.toDataURL(ticket.ticket_code, { width: 300, margin: 2 });
    const { user_id, ...safe } = ticket;
    res.json({
      ...safe,
      status: ticket.checked_in_at ? "Checked in" : "Registered",
      qr,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create the QR code" });
  }
});

// ---- Check a student in by ticket code (organizers only) ----
app.post("/api/checkin", requireAuth, requireRole("organizer"), (req, res) => {
  const code =
    typeof req.body.ticket_code === "string" ? req.body.ticket_code.trim().toLowerCase() : "";

  if (!code) {
    return res.status(400).json({ error: "ticket_code is required" });
  }

  const ticket = db
    .prepare(
      `SELECT r.id, u.name AS student_name, e.title AS event_title, e.organizer_id
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       JOIN events e ON e.id = r.event_id
       WHERE r.ticket_code = ?`
    )
    .get(code);

  if (!ticket) {
    return res.status(404).json({ result: "invalid", error: "Invalid ticket" });
  }
  if (ticket.organizer_id !== req.user.id) {
    return res.status(403).json({ result: "wrong_event", error: "This ticket is for another organizer's event" });
  }

  // One statement does "check it is still empty" AND "write the time", so it can only succeed once
  const update = db
    .prepare("UPDATE registrations SET checked_in_at = CURRENT_TIMESTAMP WHERE id = ? AND checked_in_at IS NULL")
    .run(ticket.id);

  const row = db.prepare("SELECT checked_in_at FROM registrations WHERE id = ?").get(ticket.id);

  if (update.changes === 0) {
    return res.status(409).json({
      result: "already_checked_in",
      error: "Already checked in",
      student_name: ticket.student_name,
      checked_in_at: row.checked_in_at,
    });
  }

  res.json({
    result: "success",
    student_name: ticket.student_name,
    event_title: ticket.event_title,
    checked_in_at: row.checked_in_at,
  });
});

// ---- Attendance list for one of your events (organizers only) ----
app.get("/api/events/:id/attendance", requireAuth, requireRole("organizer"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);

  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  if (event.organizer_id !== req.user.id) {
    return res.status(403).json({ error: "You can only view your own events" });
  }

  const rows = db
    .prepare(
      `SELECT r.id AS registration_id, u.name, u.email, u.department, r.checked_in_at, r.created_at
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       WHERE r.event_id = ?
       ORDER BY u.name`
    )
    .all(eventId);

  const attendees = rows.map((row) => ({
    ...row,
    status: row.checked_in_at ? "Checked in" : "Registered",
  }));

  res.json({
    event: event.title,
    registered: attendees.length,
    checked_in: attendees.filter((a) => a.checked_in_at).length,
    attendees,
  });
});

// ---- Mark one student present or absent by hand (organizers, own events) ----
app.put("/api/events/:id/attendance/:registrationId", requireAuth, requireRole("organizer"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT organizer_id FROM events WHERE id = ?").get(eventId);

  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  if (event.organizer_id !== req.user.id) {
    return res.status(403).json({ error: "You can only manage your own events" });
  }

  const present = req.body && req.body.present === true;
  const sql = present
    ? "UPDATE registrations SET checked_in_at = COALESCE(checked_in_at, CURRENT_TIMESTAMP) WHERE id = ? AND event_id = ?"
    : "UPDATE registrations SET checked_in_at = NULL WHERE id = ? AND event_id = ?";
  const result = db.prepare(sql).run(Number(req.params.registrationId), eventId);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Registration not found for this event" });
  }
  res.json({ ok: true, status: present ? "Checked in" : "Registered" });
});

// One CSV cell. A leading = + - @ is neutralised so Excel can't run it as a formula
function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

// ---- Attendance report as a CSV download (organizers, own events) ----
app.get("/api/events/:id/attendance.csv", requireAuth, requireRole("organizer"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);

  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }
  if (event.organizer_id !== req.user.id) {
    return res.status(403).json({ error: "You can only view your own events" });
  }

  const rows = db
    .prepare(
      `SELECT u.name, u.email, u.department, r.created_at, r.checked_in_at
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       WHERE r.event_id = ?
       ORDER BY u.name`
    )
    .all(eventId);

  const lines = [["Name", "Email", "Department", "Registered at", "Status", "Checked in at"]];
  for (const r of rows) {
    lines.push([r.name, r.email, r.department, r.created_at, r.checked_in_at ? "Present" : "Absent", r.checked_in_at]);
  }
  const csv = "\uFEFF" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n");

  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="attendance-event-${eventId}.csv"`,
  });
  res.send(csv);
});

app.listen(3000, () => console.log("Server on http://localhost:3000"));