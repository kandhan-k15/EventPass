const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const dns = require("dns").promises;
const path = require("path");
const db = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET. Create a .env file and start with npm start.");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// ---- Brevo SMTP Transporter ----
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: {
    name: process.env.SMTP_FROM_NAME || "EventPass",
    address: process.env.SMTP_FROM
},
      to,
      subject,
      text,
    });

    console.log("Email sent successfully to:", to);

  } catch (err) {
    console.error("Brevo email send error:", err);
    throw err;
  }
}

// ---- Rate Limiter ----
const rateLimitMap = new Map();
function rateLimiter(limitMs, maxHits) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const hits = rateLimitMap.get(ip).filter((t) => now - t < limitMs);
    if (hits.length >= maxHits) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    hits.push(now);
    rateLimitMap.set(ip, hits);
    next();
  };
}

// Names: letters (any language), spaces, and . ' - ; 2 to 60 characters
const NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'-]{1,59}$/u;

// Email format + MX-record check
async function isValidEmail(email) {
  const value = String(email || "").trim();
  if (
    value.length > 254 ||
    value.includes("..") ||
    !/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(value)
  ) {
    return false;
  }
  const domain = value.split("@")[1];
  try {
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "").trim().toLowerCase();
const ORGANIZER_CODE = (process.env.ORGANIZER_CODE || "").trim();
const DEPARTMENTS = ["IT", "CSE", "AIDS", "ECE", "EEE", "MECH", "CIVIL", "OTHER"];

app.get("/api/departments", (req, res) => {
  res.json(DEPARTMENTS);
});

// ---- Notifications ----
function addNotification(userId, message) {
  db.prepare("INSERT INTO notifications (user_id, message) VALUES (?, ?)").run(userId, message);
}

app.get("/api/notifications", requireAuth, (req, res) => {
  const notifs = db
    .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(req.user.id);
  res.json(notifs);
});

app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?").run(
    Number(req.params.id),
    req.user.id
  );
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ?").run(req.user.id);
  res.json({ ok: true });
});

// ---- Sign up (with Brevo OTP + Organizer Code check) ----
app.post("/api/signup", rateLimiter(60000, 10), async (req, res) => {
  const { name, email, password, role, department, organizer_code } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required" });
  }
  const passStr = String(password);
  if (passStr.length < 8 || passStr.length > 128) {
    return res.status(400).json({ error: "Password must be between 8 and 128 characters" });
  }

  const cleanName = String(name).trim().replace(/\s+/g, " ");
  if (!NAME_PATTERN.test(cleanName)) {
    return res.status(400).json({ error: "Name can contain only letters and spaces (2 to 60 characters)" });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  if (!(await isValidEmail(cleanEmail))) {
    return res.status(400).json({ error: "Please enter a valid, real email address" });
  }

  const dept = department ? String(department).trim().toUpperCase() : null;
  if (dept && !DEPARTMENTS.includes(dept)) {
    return res.status(400).json({ error: "Please choose a valid department" });
  }

  const userRole = role === "organizer" ? "organizer" : "student";
  if (userRole === "organizer") {
    if (!ORGANIZER_CODE || String(organizer_code || "").trim() !== ORGANIZER_CODE) {
      return res.status(403).json({ error: "Invalid organizer access code" });
    }
  }

  if (ALLOWED_EMAIL_DOMAIN && !cleanEmail.endsWith("@" + ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ error: "Please use your college email (@" + ALLOWED_EMAIL_DOMAIN + ")" });
  }

  const hash = bcrypt.hashSync(passStr, 10);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  try {
    const result = db
      .prepare(
        "INSERT INTO users (name, email, password_hash, role, department, verified, otp_code, otp_expires) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
      )
      .run(cleanName, cleanEmail, hash, userRole, dept, otp, otpExpires);

       try {
      await sendEmail(
        cleanEmail,
        "Your EventPass Verification Code",
        `Your EventPass verification code is: ${otp}. It expires in 15 minutes.`
      );
    } catch (mailErr) {
      // the account was never usable, so remove it and let the student try again
      db.prepare("DELETE FROM users WHERE id = ?").run(Number(result.lastInsertRowid));
      return res.status(502).json({
        error: "We could not send the verification email. Please try again in a few minutes.",
      });
    }
    res.status(201).json({
      id: Number(result.lastInsertRowid),
      message: "Account created. Please check your email for the 6-digit verification OTP.",
      requiresVerification: true,
      email: cleanEmail,
    });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Email already registered" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ---- Verify OTP ----
app.post("/api/verify-otp", rateLimiter(60000, 10), (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP are required" });
  }
  const cleanEmail = String(email).trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (user.verified === 1) {
    return res.json({ ok: true, message: "Already verified" });
  }
  if (user.otp_code !== String(otp).trim() || new Date(user.otp_expires) < new Date()) {
    return res.status(400).json({ error: "Invalid or expired OTP code" });
  }

  db.prepare("UPDATE users SET verified = 1, otp_code = NULL, otp_expires = NULL WHERE id = ?").run(user.id);
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department },
  });
});

// ---- Forgot Password ----
app.post("/api/forgot-password", rateLimiter(60000, 5), async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }
  const cleanEmail = String(email).trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
  if (!user) {
    return res.json({ ok: true, message: "If registered, password reset instructions have been sent." });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare("UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?").run(otp, otpExpires, user.id);
  await sendEmail(
    cleanEmail,
    "EventPass Password Reset OTP",
    `Your password reset code is: ${otp}. It expires in 15 minutes.`
  );

  res.json({ ok: true, message: "Password reset code sent to your email." });
});

// ---- Reset Password ----
app.post("/api/reset-password", rateLimiter(60000, 10), (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: "Email, OTP and new password are required" });
  }
  const passStr = String(newPassword);
  if (passStr.length < 8 || passStr.length > 128) {
    return res.status(400).json({ error: "Password must be between 8 and 128 characters" });
  }
  const cleanEmail = String(email).trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
  if (!user || user.otp_code !== String(otp).trim() || new Date(user.otp_expires) < new Date()) {
    return res.status(400).json({ error: "Invalid or expired OTP code" });
  }

  const hash = bcrypt.hashSync(passStr, 10);
  db.prepare("UPDATE users SET password_hash = ?, verified = 1, otp_code = NULL, otp_expires = NULL WHERE id = ?").run(
    hash,
    user.id
  );

  res.json({ ok: true, message: "Password successfully reset. You can now sign in." });
});

// ---- Login ----
app.post("/api/login", rateLimiter(60000, 10), (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(String(email).trim().toLowerCase());

  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (user.verified === 0) {
    return res.status(403).json({
      error: "Please verify your email with the OTP code first",
      needsVerification: true,
      email: user.email,
    });
  }

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department },
  });
});

// ---- Auth Middleware ----
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Please log in first" });

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

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can do this` });
    }
    next();
  };
}

const EVENT_SELECT = `
  SELECT e.id, e.title, e.description, e.venue, e.event_date,
         e.seat_limit, e.organizer_id, e.allowed_departments, e.form_url,
         e.seat_limit - (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS seats_left
  FROM events e
`;

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
    out.formUrl = url || null;
  }
  return out;
}

// ---- Create Event ----
app.post("/api/events", requireAuth, requireRole("organizer"), (req, res) => {
  const { title, description, venue, event_date, seat_limit } = req.body;
  const cleanTitle = String(title || "").trim();
  const cleanVenue = String(venue || "").trim();
  const cleanDesc = description ? String(description).trim() : null;

  if (cleanTitle.length < 2 || cleanTitle.length > 100) {
    return res.status(400).json({ error: "Title is required (2 to 100 characters)" });
  }
  if (cleanVenue.length < 2 || cleanVenue.length > 100) {
    return res.status(400).json({ error: "Venue is required (2 to 100 characters)" });
  }
  if (cleanDesc && cleanDesc.length > 500) {
    return res.status(400).json({ error: "Description cannot exceed 500 characters" });
  }

  const extras = parseEventExtras(req.body);
  if (extras.error) return res.status(400).json({ error: extras.error });

  const seats = Number(seat_limit);
  if (!event_date || !Number.isInteger(seats) || seats <= 0) {
    return res.status(400).json({ error: "event_date and a positive whole-number seat_limit are required" });
  }
  if (Number.isNaN(Date.parse(event_date))) {
    return res.status(400).json({ error: "event_date must be a valid date" });
  }

  const result = db
    .prepare(
      "INSERT INTO events (title, description, venue, event_date, seat_limit, organizer_id, allowed_departments, form_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(cleanTitle, cleanDesc, cleanVenue, event_date, seats, req.user.id, extras.departments || "", extras.formUrl || null);

  const event = db.prepare(EVENT_SELECT + " WHERE e.id = ?").get(Number(result.lastInsertRowid));
  res.status(201).json(event);
});

// ---- List Events ----
app.get("/api/events", requireAuth, (req, res) => {
  const events =
    req.user.role === "organizer"
      ? db.prepare(EVENT_SELECT + " WHERE e.organizer_id = ? ORDER BY e.event_date ASC").all(req.user.id)
      : db.prepare(EVENT_SELECT + " ORDER BY e.event_date ASC").all();
  res.json(events);
});

// ---- One Event ----
app.get("/api/events/:id", requireAuth, (req, res) => {
  const event = db.prepare(EVENT_SELECT + " WHERE e.id = ?").get(Number(req.params.id));
  if (!event || (req.user.role === "organizer" && event.organizer_id !== req.user.id)) {
    return res.status(404).json({ error: "Event not found" });
  }
  res.json(event);
});

// ---- Edit Event ----
app.put("/api/events/:id", requireAuth, requireRole("organizer"), (req, res) => {
  const id = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);

  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.organizer_id !== req.user.id) {
    return res.status(403).json({ error: "You can only edit your own events" });
  }

  const title = req.body.title !== undefined ? String(req.body.title).trim() : event.title;
  if (title.length < 2 || title.length > 100) {
    return res.status(400).json({ error: "Title must be between 2 and 100 characters" });
  }

  const venue = req.body.venue !== undefined ? String(req.body.venue).trim() : event.venue;
  if (venue.length < 2 || venue.length > 100) {
    return res.status(400).json({ error: "Venue must be between 2 and 100 characters" });
  }

  const description =
    req.body.description !== undefined
      ? req.body.description
        ? String(req.body.description).trim()
        : null
      : event.description;
  if (description && description.length > 500) {
    return res.status(400).json({ error: "Description cannot exceed 500 characters" });
  }

  const eventDate = req.body.event_date ?? event.event_date;
  const seats = req.body.seat_limit !== undefined ? Number(req.body.seat_limit) : event.seat_limit;

  if (!Number.isInteger(seats) || seats <= 0) {
    return res.status(400).json({ error: "seat_limit must be a positive whole number" });
  }
  if (Number.isNaN(Date.parse(eventDate))) {
    return res.status(400).json({ error: "event_date must be a valid date" });
  }

  const registered = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?").get(id).n;
  if (seats < registered) {
    return res.status(400).json({
      error: `${registered} students have already registered, so seat_limit can't go below that`,
    });
  }

  const extras = parseEventExtras(req.body);
  if (extras.error) return res.status(400).json({ error: extras.error });
  const departments = extras.departments !== undefined ? extras.departments : event.allowed_departments;
  const formUrl = extras.formUrl !== undefined ? extras.formUrl : event.form_url;

  db.prepare(
    "UPDATE events SET title = ?, description = ?, venue = ?, event_date = ?, seat_limit = ?, allowed_departments = ?, form_url = ? WHERE id = ?"
  ).run(title, description, venue, eventDate, seats, departments, formUrl, id);

  promoteWaitlist(id);

  const regUsers = db.prepare("SELECT user_id FROM registrations WHERE event_id = ?").all(id);
  for (const ru of regUsers) {
    addNotification(ru.user_id, `Event details changed for "${title}".`);
  }

  res.json(db.prepare(EVENT_SELECT + " WHERE e.id = ?").get(id));
});

function departmentError(event, userId) {
  if (!event.allowed_departments) return null;
  const allowed = event.allowed_departments.split(",");
  const me = db.prepare("SELECT department FROM users WHERE id = ?").get(userId);
  return me && me.department && allowed.includes(me.department)
    ? null
    : "This event is only for: " + allowed.join(", ");
}

function inTransaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function promoteWaitlist(eventId) {
  const event = db.prepare("SELECT seat_limit, title FROM events WHERE id = ?").get(eventId);
  if (!event) return 0;
  let promoted = 0;
  while (true) {
    const taken = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?").get(eventId).n;
    if (taken >= event.seat_limit) break;
    const next = db.prepare("SELECT id, user_id FROM waitlist WHERE event_id = ? ORDER BY id LIMIT 1").get(eventId);
    if (!next) break;
    db.prepare("INSERT INTO registrations (user_id, event_id, ticket_code) VALUES (?, ?, ?)").run(
      next.user_id,
      eventId,
      crypto.randomBytes(16).toString("hex")
    );
    db.prepare("DELETE FROM waitlist WHERE id = ?").run(next.id);
    addNotification(next.user_id, `You got a seat from the waiting list for "${event.title}"`);
    promoted++;
  }
  return promoted;
}

// ---- Register for Event ----
app.post("/api/events/:id/register", requireAuth, requireRole("student"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);

  if (!event) return res.status(404).json({ error: "Event not found" });
  if (Date.parse(event.event_date) < Date.now()) {
    return res.status(400).json({ error: "This event has already started" });
  }

  const deptError = departmentError(event, req.user.id);
  if (deptError) return res.status(403).json({ error: deptError });

  if (event.form_url && !(req.body && req.body.form_confirmed === true)) {
    return res.status(400).json({ error: "Please fill the registration form first", form_url: event.form_url });
  }

  const ticketCode = crypto.randomBytes(16).toString("hex");

  try {
    db.exec("BEGIN IMMEDIATE");
    const taken = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?").get(eventId).n;
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
    } catch {}
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "You are already registered for this event" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ---- My Tickets ----
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

  res.json(rows.map((row) => ({ ...row, status: row.checked_in_at ? "Checked in" : "Registered" })));
});

// ---- One Ticket with QR ----
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

  if (!ticket || ticket.user_id !== req.user.id) {
    return res.status(404).json({ error: "Ticket not found" });
  }

  try {
    const qr = await QRCode.toDataURL(ticket.ticket_code, { width: 300, margin: 2 });
    const { user_id, ...safe } = ticket;
    res.json({ ...safe, status: ticket.checked_in_at ? "Checked in" : "Registered", qr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create the QR code" });
  }
});

// ---- Check-in ----
app.post("/api/checkin", requireAuth, requireRole("organizer"), (req, res) => {
  const code = typeof req.body.ticket_code === "string" ? req.body.ticket_code.trim().toLowerCase() : "";
  if (!code) return res.status(400).json({ error: "ticket_code is required" });

  const ticket = db
    .prepare(
      `SELECT r.id, e.id AS event_id, u.name AS student_name, e.title AS event_title, e.organizer_id
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       JOIN events e ON e.id = r.event_id
       WHERE r.ticket_code = ?`
    )
    .get(code);

  if (!ticket) return res.status(404).json({ result: "invalid", error: "Invalid ticket" });
  if (ticket.organizer_id !== req.user.id) {
    return res.status(403).json({ result: "wrong_event", error: "This ticket is for another organizer's event" });
  }
  if (req.body.event_id !== undefined && Number(req.body.event_id) !== ticket.event_id) {
    return res.status(409).json({ result: "wrong_event", error: "This ticket is for another event: " + ticket.event_title });
  }

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

// ---- Attendance List ----
app.get("/api/events/:id/attendance", requireAuth, requireRole("organizer"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.organizer_id !== req.user.id) return res.status(403).json({ error: "You can only view your own events" });

  const rows = db
    .prepare(
      `SELECT r.id AS registration_id, u.name, u.email, u.department, r.checked_in_at, r.created_at
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       WHERE r.event_id = ?
       ORDER BY u.name`
    )
    .all(eventId);

  const attendees = rows.map((row) => ({ ...row, status: row.checked_in_at ? "Checked in" : "Registered" }));

  res.json({
    event: event.title,
    registered: attendees.length,
    waiting: db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE event_id = ?").get(eventId).n,
    checked_in: attendees.filter((a) => a.checked_in_at).length,
    attendees,
  });
});

// ---- Organizer Analytics ----
app.get("/api/organizer/analytics", requireAuth, requireRole("organizer"), (req, res) => {
  const organizerId = req.user.id;

  const registrationsOverTime = db
    .prepare(
      `SELECT date(r.created_at) AS date, COUNT(*) AS count
       FROM registrations r
       JOIN events e ON r.event_id = e.id
       WHERE e.organizer_id = ?
       GROUP BY date(r.created_at)
       ORDER BY date ASC`
    )
    .all(organizerId);

  const attendanceStats = db
    .prepare(
      `SELECT COUNT(*) AS total_registered,
              SUM(CASE WHEN r.checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS total_checked_in
       FROM registrations r
       JOIN events e ON r.event_id = e.id
       WHERE e.organizer_id = ?`
    )
    .get(organizerId);

  const totalRegistered = attendanceStats.total_registered || 0;
  const totalCheckedIn = attendanceStats.total_checked_in || 0;
  const attendanceRate = totalRegistered > 0 ? Number(((totalCheckedIn / totalRegistered) * 100).toFixed(1)) : 0;

  const departmentBreakdown = db
    .prepare(
      `SELECT u.department, COUNT(*) AS count
       FROM registrations r
       JOIN users u ON r.user_id = u.id
       JOIN events e ON r.event_id = e.id
       WHERE e.organizer_id = ? AND u.department IS NOT NULL
       GROUP BY u.department
       ORDER BY count DESC`
    )
    .all(organizerId);

  res.json({ totalRegistered, totalCheckedIn, attendanceRate, registrationsOverTime, departmentBreakdown });
});

// ---- Manual Attendance ----
app.put("/api/events/:id/attendance/:registrationId", requireAuth, requireRole("organizer"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT organizer_id FROM events WHERE id = ?").get(eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.organizer_id !== req.user.id) return res.status(403).json({ error: "You can only manage your own events" });

  const present = req.body && req.body.present === true;
  const sql = present
    ? "UPDATE registrations SET checked_in_at = COALESCE(checked_in_at, CURRENT_TIMESTAMP) WHERE id = ? AND event_id = ?"
    : "UPDATE registrations SET checked_in_at = NULL WHERE id = ? AND event_id = ?";
  const result = db.prepare(sql).run(Number(req.params.registrationId), eventId);

  if (result.changes === 0) return res.status(404).json({ error: "Registration not found for this event" });
  res.json({ ok: true, status: present ? "Checked in" : "Registered" });
});

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

// ---- CSV Download ----
app.get("/api/events/:id/attendance.csv", requireAuth, requireRole("organizer"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.organizer_id !== req.user.id) return res.status(403).json({ error: "You can only view your own events" });

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

// ---- Cancel Registration ----
app.delete("/api/events/:id/register", requireAuth, requireRole("student"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT event_date FROM events WHERE id = ?").get(eventId);
  const reg = db
    .prepare("SELECT id, checked_in_at FROM registrations WHERE user_id = ? AND event_id = ?")
    .get(req.user.id, eventId);

  if (!event || !reg) return res.status(404).json({ error: "You are not registered for this event" });
  if (reg.checked_in_at) return res.status(409).json({ error: "You are already checked in, so this can't be cancelled" });
  if (Date.parse(event.event_date) < Date.now()) return res.status(400).json({ error: "This event has already started" });

  try {
    inTransaction(() => {
      db.prepare("DELETE FROM registrations WHERE id = ?").run(reg.id);
      promoteWaitlist(eventId);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ---- Waitlist ----
app.post("/api/events/:id/waitlist", requireAuth, requireRole("student"), (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);

  if (!event) return res.status(404).json({ error: "Event not found" });
  if (Date.parse(event.event_date) < Date.now()) return res.status(400).json({ error: "This event has already started" });

  const deptError = departmentError(event, req.user.id);
  if (deptError) return res.status(403).json({ error: deptError });

  if (event.form_url && !(req.body && req.body.form_confirmed === true)) {
    return res.status(400).json({ error: "Please fill the registration form first", form_url: event.form_url });
  }
  if (db.prepare("SELECT 1 FROM registrations WHERE user_id = ? AND event_id = ?").get(req.user.id, eventId)) {
    return res.status(409).json({ error: "You are already registered for this event" });
  }
  const taken = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?").get(eventId).n;
  if (taken < event.seat_limit) return res.status(409).json({ error: "Seats are available, please register instead" });

  try {
    const result = db.prepare("INSERT INTO waitlist (user_id, event_id) VALUES (?, ?)").run(req.user.id, eventId);
    const position = db
      .prepare("SELECT COUNT(*) AS n FROM waitlist WHERE event_id = ? AND id <= ?")
      .get(eventId, Number(result.lastInsertRowid)).n;
    res.status(201).json({ position });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "You are already on the waiting list" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.delete("/api/events/:id/waitlist", requireAuth, requireRole("student"), (req, res) => {
  const result = db.prepare("DELETE FROM waitlist WHERE user_id = ? AND event_id = ?").run(req.user.id, Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: "You are not on the waiting list" });
  res.json({ ok: true });
});

app.get("/api/my-waitlist", requireAuth, requireRole("student"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.event_id,
              (SELECT COUNT(*) FROM waitlist w2 WHERE w2.event_id = w.event_id AND w2.id <= w.id) AS position
       FROM waitlist w
       WHERE w.user_id = ?`
    )
    .all(req.user.id);
  res.json(rows);
});

// ---- Delete Event ----
app.delete("/api/events/:id", requireAuth, requireRole("organizer"), (req, res) => {
  const id = Number(req.params.id);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);

  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.organizer_id !== req.user.id) return res.status(403).json({ error: "You can only delete your own events" });

  try {
    const targetUsers = db
      .prepare(
        `SELECT DISTINCT user_id FROM (
          SELECT user_id FROM registrations WHERE event_id = ?
          UNION
          SELECT user_id FROM waitlist WHERE event_id = ?
        )`
      )
      .all(id, id);

    for (const tu of targetUsers) {
      addNotification(tu.user_id, `Event cancelled: "${event.title}".`);
    }

    inTransaction(() => {
      db.prepare("DELETE FROM waitlist WHERE event_id = ?").run(id);
      db.prepare("DELETE FROM registrations WHERE event_id = ?").run(id);
      db.prepare("DELETE FROM events WHERE id = ?").run(id);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));