const base = "http://localhost:3000";
const json = { "Content-Type": "application/json" };

async function call(label, path, { method = "GET", token, body } = {}) {
  const headers = { ...json };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  console.log(`${label}: ${method} ${path} -> ${res.status}`, JSON.stringify(data));
  return data;
}

async function loginAs(name, email, role) {
  const password = "password123";
  await call("signup " + role, "/api/signup", { method: "POST", body: { name, email, password, role } });
  const data = await call("login " + role, "/api/login", { method: "POST", body: { email, password } });
  return data.token;
}

(async () => {
  const stamp = Date.now();
  const org1 = await loginAs("Organizer One", "org1@example.com", "organizer");
  const org2 = await loginAs("Organizer Two", "org2@example.com", "organizer");
  const a = await loginAs("Student A", `a-${stamp}@example.com`, "student");
  const b = await loginAs("Student B", `b-${stamp}@example.com`, "student");
  const c = await loginAs("Student C", `c-${stamp}@example.com`, "student");

  const ev = await call("create 1-seat event", "/api/events", {
    method: "POST", token: org1,
    body: { title: "Waitlist Demo", venue: "Lab 3", event_date: "2026-12-22T10:00", seat_limit: 1 },
  });
  const id = ev.id;

  console.log("\n--- waiting list ---");
  await call("A registers", `/api/events/${id}/register`, { method: "POST", token: a });
  await call("A joins waitlist (already registered)", `/api/events/${id}/waitlist`, { method: "POST", token: a });
  await call("B registers (full)", `/api/events/${id}/register`, { method: "POST", token: b });
  await call("B joins waitlist (#1 expected)", `/api/events/${id}/waitlist`, { method: "POST", token: b });
  await call("B joins again", `/api/events/${id}/waitlist`, { method: "POST", token: b });
  await call("C joins waitlist (#2 expected)", `/api/events/${id}/waitlist`, { method: "POST", token: c });
  await call("C position", "/api/my-waitlist", { token: c });
  await call("A cancels", `/api/events/${id}/register`, { method: "DELETE", token: a });
  await call("B now has a ticket", "/api/my-tickets", { token: b });
  await call("C moved up (#1 expected)", "/api/my-waitlist", { token: c });
  await call("seat limit 1 -> 2 (C should get in)", `/api/events/${id}`, { method: "PUT", token: org1, body: { seat_limit: 2 } });
  await call("C has a ticket", "/api/my-tickets", { token: c });
  await call("attendance counts", `/api/events/${id}/attendance`, { token: org1 });

  console.log("\n--- edit and delete ---");
  await call("edit title", `/api/events/${id}`, { method: "PUT", token: org1, body: { title: "Waitlist Demo (edited)" } });
  await call("other organizer deletes", `/api/events/${id}`, { method: "DELETE", token: org2 });
  await call("student deletes", `/api/events/${id}`, { method: "DELETE", token: a });
  await call("owner deletes", `/api/events/${id}`, { method: "DELETE", token: org1 });
  await call("event is gone", `/api/events/${id}`, { token: a });
})();