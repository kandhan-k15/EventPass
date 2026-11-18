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
  // shorten the long QR text so the output stays readable
  const shown = JSON.stringify(data, (k, v) =>
    typeof v === "string" && v.length > 60 ? v.slice(0, 30) + "...(" + v.length + " chars)" : v
  );
  console.log(`${label}: ${method} ${path} -> ${res.status} ${shown}`);
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
  const s1 = await loginAs("Student A", `a-${stamp}@example.com`, "student");
  const s2 = await loginAs("Student B", `b-${stamp}@example.com`, "student");

  const event = await call("create event", "/api/events", {
    method: "POST",
    token: org1,
    body: { title: "QR Demo Event", venue: "Hall 2", event_date: "2026-12-20T10:00", seat_limit: 10 },
  });
  const reg = await call("A registers", `/api/events/${event.id}/register`, { method: "POST", token: s1 });
  await call("B registers", `/api/events/${event.id}/register`, { method: "POST", token: s2 });

  console.log("\n--- ticket + QR ---");
  await call("A views own ticket", `/api/tickets/${reg.registration_id}`, { token: s1 });
  await call("B views A's ticket", `/api/tickets/${reg.registration_id}`, { token: s2 });

  console.log("\n--- check-in tests ---");
  const check = (label, token, ticket_code) =>
    call(label, "/api/checkin", { method: "POST", token, body: { ticket_code } });

  await check("no token", undefined, reg.ticket_code);
  await check("student blocked", s1, reg.ticket_code);
  await check("missing code", org1, "");
  await check("fake code", org1, "0".repeat(32));
  await check("other organizer", org2, reg.ticket_code);
  await check("valid check-in", org1, reg.ticket_code);
  await check("scan same ticket again", org1, reg.ticket_code);

  console.log("\n--- results ---");
  await call("attendance (owner)", `/api/events/${event.id}/attendance`, { token: org1 });
  await call("attendance (other organizer)", `/api/events/${event.id}/attendance`, { token: org2 });
  await call("A's tickets", "/api/my-tickets", { token: s1 });
})();