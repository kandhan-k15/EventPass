const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET. Create a .env file and start with npm start.");
  process.exit(1);
}

app.get("/", (req, res) => {
  res.send("EventPass is running");
});

// ---- Sign up ----
app.post("/api/signup", (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const userRole = role === "organizer" ? "organizer" : "student";
  const cleanEmail = email.trim().toLowerCase();
  const hash = bcrypt.hashSync(password, 10);

  try {
    const result = db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
      .run(name.trim(), cleanEmail, hash, userRole);

    res.status(201).json({
      id: Number(result.lastInsertRowid),
      name: name.trim(),
      email: cleanEmail,
      role: userRole,
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
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
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
    .prepare("SELECT id, name, email, role FROM users WHERE id = ?")
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
         e.seat_limit, e.organizer_id,
         e.seat_limit - (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS seats_left
  FROM events e
`;

// ---- Create an event (organizers only) ----
app.post("/api/events", requireAuth, requireRole("organizer"), (req, res) => {
  const { title, description, venue, event_date, seat_limit } = req.body;
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
      "INSERT INTO events (title, description, venue, event_date, seat_limit, organizer_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      title.trim(),
      description ? description.trim() : null,
      venue.trim(),
      event_date,
      seats,
      req.user.id
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

  db.prepare(
    "UPDATE events SET title = ?, description = ?, venue = ?, event_date = ?, seat_limit = ? WHERE id = ?"
  ).run(String(title).trim(), description, String(venue).trim(), eventDate, seats, id);

  res.json(db.prepare(EVENT_SELECT + " WHERE e.id = ?").get(id));
});

app.listen(3000, () => console.log("Server on http://localhost:3000"));