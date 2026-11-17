const base = "http://localhost:3000";
const json = { "Content-Type": "application/json" };

async function call(path, options) {
  const res = await fetch(base + path, options);
  const body = await res.json();
  console.log((options && options.method) || "GET", path, res.status, body);
  return body;
}

(async () => {
  const student = { name: "Test Student", email: "test@example.com", password: "password123", role: "student" };

  await call("/api/signup", { method: "POST", headers: json, body: JSON.stringify(student) });
  await call("/api/signup", { method: "POST", headers: json, body: JSON.stringify(student) });
  await call("/api/login", { method: "POST", headers: json, body: JSON.stringify({ email: student.email, password: "wrongpassword" }) });
  const { token } = await call("/api/login", { method: "POST", headers: json, body: JSON.stringify({ email: student.email, password: student.password }) });
  await call("/api/me", { headers: { Authorization: "Bearer " + token } });
  await call("/api/me");
})();