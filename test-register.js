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
  const stamp = Date.now(); // new students every run, so you can rerun this test
  const organizer = await loginAs("Organizer One", "org1@example.com", "organizer");
  const s1 = await loginAs("Student A", `a-${stamp}@example.com`, "student");
  const s2 = await loginAs("Student B", `b-${stamp}@example.com`, "student");
  const s3 = await loginAs("Student C", `c-${stamp}@example.com`, "student");

  const small = await call("create 2-seat event", "/api/events", {
    method: "POST",
    token: organizer,
    body: { title: "Mini Workshop", venue: "Lab 1", event_date: "2026-12-15T10:00", seat_limit: 2 },
  });
  const past = await call("create past event", "/api/events", {
    method: "POST",
    token: organizer,
    body: { title: "Old Event", venue: "Hall", event_date: "2020-01-01T09:00", seat_limit: 10 },
  });

  console.log("\n--- registration tests ---");
  await call("no token", `/api/events/${small.id}/register`, { method: "POST" });
  await call("organizer blocked", `/api/events/${small.id}/register`, { method: "POST", token: organizer });
  await call("event not found", "/api/events/9999/register", { method: "POST", token: s1 });
  await call("past event", `/api/events/${past.id}/register`, { method: "POST", token: s1 });
  await call("A registers (seat 1)", `/api/events/${small.id}/register`, { method: "POST", token: s1 });
  await call("A again (duplicate)", `/api/events/${small.id}/register`, { method: "POST", token: s1 });
  await call("B registers (seat 2)", `/api/events/${small.id}/register`, { method: "POST", token: s2 });
  await call("C registers (full)", `/api/events/${small.id}/register`, { method: "POST", token: s3 });

  console.log("\n--- check results ---");
  await call("seats left", `/api/events/${small.id}`, { token: s1 });
  await call("A's tickets", "/api/my-tickets", { token: s1 });
  await call("C's tickets (none)", "/api/my-tickets", { token: s3 });
  await call("shrink below registered", `/api/events/${small.id}`, {
    method: "PUT",
    token: organizer,
    body: { seat_limit: 1 },
  });
})();