// Shared helpers used by every page
const App = {
  token: () => localStorage.getItem("token"),
  user: () => JSON.parse(localStorage.getItem("user") || "null"),

  save(token, user) {
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(user));
  },

  // Where each role lands after login
  home: (user) => (user && user.role === "organizer" ? "/organizer.html" : "/events.html"),

  logout() {
    localStorage.clear();
    location.href = "/";
  },

  // Talks to the server. Throws an Error with the server's message if something is wrong.
  async call(path, { method = "GET", body, noAuth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (!noAuth && App.token()) headers.Authorization = "Bearer " + App.token();

    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && !noAuth) App.logout(); // token missing or expired
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  },

  // Show a message in an element with class "msg"
  say(el, text, kind) {
    el.textContent = text; // textContent, never innerHTML, so text can't inject HTML
    el.className = "msg show " + kind;
  },
};