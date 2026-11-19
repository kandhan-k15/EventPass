const App = {
  token: () => localStorage.getItem("token"),
  user: () => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  },

  save(token, user) {
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(user));
  },

  home: (user) => (user && user.role === "organizer" ? "/organizer.html" : "/events.html"),

  logout() {
    localStorage.clear();
    location.href = "/";
  },

  playSound(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === "click") {
        osc.frequency.setValueAtTime(620, ctx.currentTime);
        gain.gain.setValueAtTime(0.05, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        osc.start();
        osc.stop(ctx.currentTime + 0.08);
      } else if (type === "success") {
        osc.frequency.setValueAtTime(523.25, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.18);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch {}
  },

  async call(path, { method = "GET", body, noAuth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (!noAuth && App.token()) headers.Authorization = "Bearer " + App.token();

    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && !noAuth) App.logout();
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  },

  confirm(title, text, okLabel = "Confirm") {
    App.playSound("click");
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      dlg.className = "animated-modal";
      const h = document.createElement("h2");
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = text;
      const no = document.createElement("button");
      no.type = "button";
      no.className = "btn ghost";
      no.textContent = "Keep it";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "btn danger";
      ok.textContent = okLabel;
      const finish = (value) => {
        dlg.close();
        dlg.remove();
        resolve(value);
      };
      ok.onclick = () => { App.playSound("click"); finish(true); };
      no.onclick = () => { App.playSound("click"); finish(false); };
      dlg.addEventListener("cancel", () => finish(false));
      dlg.append(h, p, no, ok);
      document.body.append(dlg);
      dlg.showModal();
    });
  },

  say(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "msg show " + kind + " pulse-anim";
    if (kind === "ok") App.playSound("success");
  },

  initNotifications() {
    if (!App.token()) return;
    const nav = document.querySelector(".nav");
    if (!nav || document.getElementById("bell-btn")) return;

    const bellBtn = document.createElement("button");
    bellBtn.id = "bell-btn";
    bellBtn.type = "button";
    bellBtn.className = "btn small ghost bell-icon";
    bellBtn.innerHTML = `🔔 <span id="bell-count" class="badge-count" style="display:none">0</span>`;

    const dropdown = document.createElement("div");
    dropdown.id = "notif-dropdown";
    dropdown.className = "notif-dropdown";
    dropdown.hidden = true;
    dropdown.innerHTML = `
      <div class="notif-header">
        <strong>Notifications</strong>
        <button id="mark-all-read" type="button" class="btn ghost small" style="font-size:12px;padding:4px 8px;">Mark all read</button>
      </div>
      <div id="notif-list" class="notif-list"></div>
    `;

    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.append(bellBtn, dropdown);
    nav.prepend(wrap);

    async function loadNotifs() {
      try {
        const list = await App.call("/api/notifications");
        const unread = list.filter((n) => n.is_read === 0);
        const countEl = document.getElementById("bell-count");
        if (unread.length > 0) {
          countEl.textContent = unread.length;
          countEl.style.display = "inline-block";
        } else {
          countEl.style.display = "none";
        }

        const listEl = document.getElementById("notif-list");
        listEl.replaceChildren();
        if (list.length === 0) {
          listEl.innerHTML = `<div class="empty" style="padding:16px;font-size:13px;">No notifications yet</div>`;
          return;
        }
        for (const n of list) {
          const item = document.createElement("div");
          item.className = "notif-item" + (n.is_read ? "" : " unread");
          const textDiv = document.createElement("div");
          textDiv.textContent = n.message;
          const timeDiv = document.createElement("div");
          timeDiv.style.fontSize = "11px";
          timeDiv.style.color = "var(--muted)";
          timeDiv.style.marginTop = "3px";
          timeDiv.textContent = new Date(n.created_at).toLocaleString();
          item.append(textDiv, timeDiv);
          if (!n.is_read) {
            item.onclick = async () => {
              App.playSound("click");
              await App.call(`/api/notifications/${n.id}/read`, { method: "POST" });
              loadNotifs();
            };
          }
          listEl.append(item);
        }
      } catch (err) {
        console.error(err);
      }
    }

    bellBtn.onclick = (e) => {
      e.stopPropagation();
      App.playSound("click");
      dropdown.hidden = !dropdown.hidden;
      if (!dropdown.hidden) loadNotifs();
    };

    document.getElementById("mark-all-read").onclick = async (e) => {
      e.stopPropagation();
      App.playSound("click");
      await App.call("/api/notifications/read-all", { method: "POST" });
      loadNotifs();
    };

    document.addEventListener("click", () => {
      dropdown.hidden = true;
    });

    loadNotifs();
    setInterval(loadNotifs, 15000);
  },
};

document.addEventListener("DOMContentLoaded", () => {
  App.initNotifications();
  document.querySelectorAll("button, a.btn").forEach((el) => {
    el.addEventListener("click", () => App.playSound("click"));
  });
});