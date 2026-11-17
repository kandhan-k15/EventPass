const base = "http://localhost:3000";
const json = { "Content-Type": "application/json" };

async function call(label, path, { method = "GET", token, body } = {}) {
  const headers = { ...json };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  console.log(`${label}: ${method} ${path} -> ${res.status}`, data);
  return data;
}

async function loginAs(name, email, role) {
  const password = "password123";
  await call("signup " + role, "/api/signup", { method: "POST", body: { name, email, password, role } });
  const data = await call("login " + role, "/api/login", { method: "POST", body: { email, password } });
  return data.token;
}

(async () => {
  const student = await loginAs("Test Student", "test@example.com", "student");
  const org1 = await loginAs("Organizer One", "org1@example.com", "organizer");
  const org2 = await loginAs("Organizer Two", "org2@example.com", "organizer");

  const eventBody = {
    title: "Hackathon 2026",
    description: "24-hour coding event",
    venue: "Main Auditorium",
    event_date: "2026-12-10T09:00",
    seat_limit: 50,
  };

  await call("no token", "/api/events", { method: "POST", body: eventBody });
  await call("student blocked", "/api/events", { method: "POST", token: student, body: eventBody });
  await call("bad input", "/api/events", { method: "POST", token: org1, body: { title: "x" } });
  const created = await call("create", "/api/events", { method: "POST", token: org1, body: eventBody });
  await call("list", "/api/events", { token: student });
  await call("detail", `/api/events/${created.id}`, { token: student });
  await call("missing", "/api/events/9999", { token: student });
  await call("update own", `/api/events/${created.id}`, { method: "PUT", token: org1, body: { seat_limit: 80 } });
  await call("update someone else's", `/api/events/${created.id}`, { method: "PUT", token: org2, body: { seat_limit: 10 } });
})();