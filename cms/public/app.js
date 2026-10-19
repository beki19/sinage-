"use strict";

// ---------- state + helpers ----------

const state = {
  token: localStorage.getItem("token"),
  me: null, users: [],
  media: [], playlists: [], layouts: [], devices: [], groups: [],
  selectedPlaylist: null, draft: null,
  selectedLayout: null, layoutDraft: null,
};
const $ = (sel) => document.querySelector(sel);

/** Tiny element builder: h("div", {class: "x", onclick}, child, "text") */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${state.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== "/api/login") { showLogin(); throw new Error("Logged out"); }
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data;
}

const fileUrl = (m) => `/api/media/${m.id}/file?token=${encodeURIComponent(state.token)}`;
const fmtSize = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.ceil(n / 1e3) + " KB");
const fmtAgo = (iso) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const preview = (m, { controls = false } = {}) =>
  m.type === "video"
    ? h("video", { src: fileUrl(m) + "#t=0.5", muted: true, preload: "metadata", controls })
    : h("img", { src: fileUrl(m), alt: m.name, loading: "lazy" });

// ---------- login ----------

function showLogin() {
  liveSource?.close();
  liveSource = null;
  state.token = null;
  localStorage.removeItem("token");
  $("#main").hidden = true;
  $("#login").hidden = false;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    const { token } = await api("POST", "/api/login", { username: e.target.username.value, password: e.target.password.value });
    state.token = token;
    localStorage.setItem("token", token);
    e.target.reset();
    start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  try { await api("POST", "/api/logout"); } catch {}
  showLogin();
});

// ---------- tabs ----------

document.querySelectorAll("header nav button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("header nav button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === "devices") loadDevices();
    if (btn.dataset.tab === "dashboard") loadDashboard();
  }),
);

// ---------- dashboard ----------

/** SVG element builder, like h() but in the SVG namespace. */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}

const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

/**
 * Column chart for one series. values: numbers (or null for no data), max: top of the y-axis,
 * ticks: y gridline values, label(v): tick text, tip(i, v): tooltip, xLabels: [index, text][].
 */
function columnChart({ values, max, ticks, label, tip, xLabels, height = 180, width = 640 }) {
  const W = width, H = height, L = 36, R = 6, T = 8, B = 22;
  const plotW = W - L - R, plotH = H - T - B;
  const band = plotW / values.length;
  const barW = Math.min(24, band - 2);
  const y = (v) => T + plotH - (v / max) * plotH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" },
    ticks.map((t) => [
      s("line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "gridline" }),
      s("text", { x: L - 6, y: y(t) + 4, class: "tick", "text-anchor": "end" }, label(t)),
    ]),
    values.map((v, i) => {
      const x = L + i * band + (band - barW) / 2;
      const hit = s("rect", { x: L + i * band, y: T, width: band, height: plotH, class: "hit", "data-tip": tip(i, v) });
      if (v == null || v <= 0) return hit;
      const top = y(v), r = Math.min(4, barW / 2, (T + plotH - top));
      // Rounded at the data end, square at the baseline.
      const d = `M${x},${T + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${T + plotH} Z`;
      return [s("path", { d, class: "bar" }), hit];
    }),
    xLabels.map(([i, text]) => s("text", { x: L + i * band + band / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, text)),
  );
  return svg;
}

/** Horizontal bars for one series, value at the tip. */
function barList(rows, { unit = "", empty = "Nothing yet." } = {}) {
  if (!rows.length) return h("p", { class: "muted small-text" }, empty);
  const max = Math.max(...rows.map((r) => r.n), 1);
  return h("div", { class: "barlist" }, rows.map((r) => h("div", { class: "barrow", "data-tip": `${r.label}: ${r.n}${unit}` },
    h("span", { class: "barlabel", title: r.label }, r.label),
    h("span", { class: "bartrack" }, h("span", { class: "barfill", style: `width:${Math.max(2, (r.n / max) * 100)}%` })),
    h("span", { class: "barvalue" }, `${r.n}${unit}`))));
}

const uptimeClass = (v) => (v == null ? "none" : v === 0 ? "u0" : v < 0.5 ? "u1" : v < 0.9 ? "u2" : "u3");

function renderDashboard(d) {
  $("#dash-updated").textContent = `Updated ${fmtTime(d.generatedAt)} · refreshes every 10 seconds`;

  // Hero: the one number that matters most.
  const share = d.screens.total ? d.screens.online / d.screens.total : null;
  const statusWord = !d.screens.total ? "No screens yet" : !d.screens.offline ? "All screens online" : `${d.screens.offline} offline`;
  $("#hero").replaceChildren(
    h("div", { class: "hero-label" }, "Screens online now"),
    h("div", { class: "hero-value" }, share == null ? "—" : pct(share)),
    h("div", { class: "hero-sub" },
      h("span", { class: `status-pill ${!d.screens.total ? "" : d.screens.offline ? "critical" : "good"}` },
        h("span", { class: "status-icon" }, !d.screens.total ? "•" : d.screens.offline ? "!" : "✓"), statusWord),
      h("span", { class: "muted" }, `${d.screens.online} of ${d.screens.total} screens`)),
    h("div", { class: "meter", "data-tip": `${d.screens.online} online, ${d.screens.offline} offline` },
      h("span", { class: "meter-on", style: `width:${(share ?? 0) * 100}%` })),
  );

  const tile = (label, value, note) => h("div", { class: "stat card" },
    h("div", { class: "stat-label" }, label), h("div", { class: "stat-value" }, value), note ? h("div", { class: "small-text muted" }, note) : null);
  $("#stats").replaceChildren(
    tile("Uptime, last 24 h", pct(d.uptime24h), "Average across screens"),
    tile("Content items", String(d.counts.items), `${d.counts.playlists} playlists · ${d.counts.layouts} layouts`),
    tile("Media library", fmtSize(d.media.bytes), `${d.media.count} file${d.media.count === 1 ? "" : "s"}`),
    tile("On a schedule", `${d.counts.scheduled} / ${d.screens.total}`, `${d.counts.groups} group${d.counts.groups === 1 ? "" : "s"} · ${d.counts.users} user${d.counts.users === 1 ? "" : "s"}`),
  );

  // Fleet uptime columns, one per hour.
  const hourStart = (i) => Date.parse(d.generatedAt) - (24 - i) * 3600_000;
  $("#uptime-chart").replaceChildren(d.screens.total
    ? columnChart({
        values: d.fleetHourly, max: 1, ticks: [0, 0.5, 1], label: (t) => `${t * 100}%`,
        tip: (i, v) => `${fmtTime(new Date(hourStart(i)).toISOString())}–${fmtTime(new Date(hourStart(i + 1)).toISOString())}: ${v == null ? "no screens yet" : `${pct(v)} online`}`,
        xLabels: [[0, "24 h ago"], [6, "18 h"], [12, "12 h"], [18, "6 h"], [23, "now"]],
        // Draw at the box's real width so labels stay at their true size on phones.
        width: Math.max(300, $("#uptime-chart").clientWidth || 640),
      })
    : h("p", { class: "muted" }, "Pair a screen to start tracking uptime."));

  // Attention list.
  const icons = { critical: "!", warning: "▲", info: "i" };
  $("#attention").replaceChildren(...(d.attention.length
    ? d.attention.map((a) => h("li", { class: a.level }, h("span", { class: "status-icon" }, icons[a.level]), h("span", {}, a.text)))
    : [h("li", { class: "good" }, h("span", { class: "status-icon" }, "✓"), h("span", {}, "All good. Nothing needs attention."))]));

  // Status board.
  $("#screen-board").replaceChildren(d.screenList.length
    ? h("div", { class: "board" },
        h("div", { class: "board-row board-head" },
          ["Screen", "Showing now", "Last 24 hours", "Uptime", "Last seen", "Player"].map((t) => h("span", {}, t))),
        d.screenList.map((x) => h("div", { class: "board-row" },
          h("span", { class: "board-name" },
            h("span", { class: `status-pill small ${x.online ? "good" : "critical"}` }, h("span", { class: "status-icon" }, x.online ? "✓" : "!"), x.online ? "Online" : "Offline"),
            h("strong", {}, x.name), x.group ? h("span", { class: "muted small-text" }, `Group: ${x.group}`) : null),
          h("span", { class: x.nowShowing ? "" : "muted" }, x.nowShowing ?? "Nothing assigned", liveSummary(x.live)),
          h("span", { class: "strip" }, x.hourly.map((v, i) => h("span", {
            class: `cell ${uptimeClass(v)}`,
            "data-tip": `${x.name}, ${fmtTime(new Date(hourStart(i)).toISOString())}: ${v == null ? "not paired yet" : `${pct(v)} of the hour online`}`,
          }))),
          h("span", { class: "num" }, pct(x.uptime24h)),
          h("span", { class: "muted small-text" }, x.online ? "now" : fmtAgo(x.lastSeen)),
          h("span", { class: "muted small-text" }, x.appVersion ? `v${x.appVersion}` : "—", x.model ? h("div", {}, x.model) : null),
        )),
        h("div", { class: "legend small-text muted" }, "Hour online:",
          [["u3", "90%+"], ["u2", "50–90%"], ["u1", "under 50%"], ["u0", "offline"], ["none", "not paired"]].map(([c, t]) =>
            h("span", { class: "legend-item" }, h("span", { class: `cell ${c}` }), t))),
      )
    : h("p", { class: "muted" }, "No screens yet. Pair one in the Screens tab."));

  $("#content-mix").replaceChildren(barList(d.contentMix.map((m) => ({ label: m.label, n: m.n })), { empty: "Add items to a playlist to see the mix." }));
  $("#most-used").replaceChildren(barList(d.mostUsed.map((m) => ({ label: `${m.name} (${m.kind})`, n: m.screens })), { empty: "Assign content to a screen to see this." }));

  // Storage: one stacked bar, images then videos, with a legend.
  const total = d.media.images + d.media.videos;
  $("#storage").replaceChildren(total
    ? h("div", {},
        h("div", { class: "stack" },
          d.media.images ? h("span", { class: "seg s1", style: `flex:${d.media.images}`, "data-tip": `Images: ${fmtSize(d.media.images)}` }) : null,
          d.media.videos ? h("span", { class: "seg s2", style: `flex:${d.media.videos}`, "data-tip": `Videos: ${fmtSize(d.media.videos)}` }) : null),
        h("div", { class: "legend small-text" },
          h("span", { class: "legend-item" }, h("span", { class: "key s1" }), `Images ${fmtSize(d.media.images)}`),
          h("span", { class: "legend-item" }, h("span", { class: "key s2" }), `Videos ${fmtSize(d.media.videos)}`)))
    : h("p", { class: "muted small-text" }, "No media uploaded yet."));
  $("#versions").replaceChildren(barList(d.versions.map((v) => ({ label: v.version === "unknown" ? "Unknown" : `v${v.version}${v.latest ? " (newest)" : ""}`, n: v.n })), { empty: "No screens yet." }));

  // Coming up: schedule switches and dated items, in time order.
  const upcoming = [
    ...d.upcoming.map((u) => ({ at: u.at, when: `${fmtDay(u.at)} ${fmtTime(u.at)}`, text: `${u.screen} switches to ${u.to ?? "nothing"}`, sub: u.from ? `from ${u.from}` : "" })),
    ...d.dated.map((x) => ({ at: x.at, when: `${fmtDay(x.at)} ${x.at.slice(11)}`, text: `"${x.item}" ${x.type === "starts" ? "starts showing" : "stops showing"}`, sub: `in ${x.playlist}` })),
  ].sort((a, b) => a.at.localeCompare(b.at)).slice(0, 10);
  $("#upcoming").replaceChildren(...(upcoming.length
    ? upcoming.map((u) => h("li", {}, h("span", { class: "when" }, u.when), h("span", {}, u.text, u.sub ? h("span", { class: "muted small-text" }, ` ${u.sub}`) : null)))
    : [h("li", { class: "muted" }, "Nothing scheduled to change. Add time slots or start/end dates to see them here.")]));

  const maxDay = Math.max(1, ...d.days.map((x) => x.offline));
  const step = maxDay <= 4 ? 1 : Math.ceil(maxDay / 4);
  $("#activity-chart").replaceChildren(columnChart({
    values: d.days.map((x) => x.offline), max: Math.ceil(maxDay / step) * step,
    ticks: Array.from({ length: Math.ceil(maxDay / step) + 1 }, (_, i) => i * step), label: (t) => String(t),
    tip: (i, v) => `${fmtDay(d.days[i].day + "T12:00:00")}: went offline ${v} time${v === 1 ? "" : "s"}, came back ${d.days[i].online}`,
    xLabels: d.days.map((x, i) => [i, new Date(x.day + "T12:00:00").toLocaleDateString([], { weekday: "short" })]), height: 190, width: Math.max(300, $("#activity-chart").clientWidth || 380),
  }));

  $("#event-list").replaceChildren(...(d.events.length
    ? d.events.slice(0, 10).map((e) => h("li", {},
        h("span", { class: "when" }, fmtAgo(e.at)),
        h("span", {}, h("span", { class: `status-pill small ${e.type === "online" ? "good" : "critical"}` },
          h("span", { class: "status-icon" }, e.type === "online" ? "✓" : "!"), e.type === "online" ? "Back" : "Offline"), ` ${e.deviceName}`)))
    : [h("li", { class: "muted" }, "Screens going offline and coming back will show up here.")]));
}

// One tooltip for every chart mark: anything with data-tip shows it on hover.
document.addEventListener("pointermove", (e) => {
  const tip = $("#viz-tip");
  const el = e.target.closest?.("[data-tip]");
  if (!el || $("#tab-dashboard").hidden) { tip.hidden = true; return; }
  tip.textContent = el.getAttribute("data-tip");
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
  tip.style.transform = `translate(${x}px, ${y}px)`;
});

async function loadDashboard() {
  const d = await api("GET", "/api/dashboard");
  renderDashboard(d);
  if (state.me?.role === "admin") {
    const s = await api("GET", "/api/settings");
    const f = $("#alert-settings");
    if (document.activeElement?.form !== f) {
      f.alertWebhookUrl.value = s.alertWebhookUrl;
      f.offlineAfterMinutes.value = s.offlineAfterMinutes;
    }
  }
}

$("#alert-settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("PUT", "/api/settings", { alertWebhookUrl: f.alertWebhookUrl.value.trim(), offlineAfterMinutes: Number(f.offlineAfterMinutes.value) });
    toast("Alert settings saved");
    loadDashboard();
  } catch (err) { toast(err.message); }
});

$("#test-alert").addEventListener("click", async () => {
  try {
    await api("POST", "/api/settings/test-alert");
    toast("Test alert sent. Check your channel.");
  } catch (err) { toast(err.message); }
});

// ---------- media ----------

async function loadMedia() {
  state.media = await api("GET", "/api/media");
  renderMedia();
}

function renderMedia() {
  const grid = $("#media-grid");
  grid.replaceChildren();
  if (!state.media.length) grid.append(h("p", { class: "muted" }, "No media yet. Upload some above."));
  for (const m of state.media) {
    grid.append(h("div", { class: "tile" },
      h("div", { class: "thumb" }, preview(m, { controls: m.type === "video" }), h("span", { class: "badge" }, m.type)),
      h("div", { class: "meta" },
        h("div", { class: "name", title: m.name }, m.name),
        h("div", { class: "muted" }, fmtSize(m.size), m.video ? ` · ${m.video.width}×${m.video.height}` : ""),
        m.type === "video" ? videoBadge(m) : null,
        h("div", { class: "actions" },
          h("button", { class: "ghost small", onclick: () => renameMedia(m) }, "Rename"),
          h("button", { class: "danger small", onclick: () => deleteMedia(m) }, "Delete"),
        ),
      ),
    ));
  }
}

/** Whether a video is ready for TVs: most TVs only manage H.264 at 1080p, so bigger videos get a converted copy. */
function videoBadge(m) {
  const retry = (label) => h("button", { class: "ghost small", onclick: async () => {
    try { await api("POST", `/api/media/${m.id}/convert`); await loadMedia(); } catch (err) { toast(err.message); }
  } }, label);
  if (m.convert === "running") return h("div", { class: "vbadge info" }, "⏳ Making a 1080p copy for screens…");
  if (m.screenCopy) return h("div", { class: "vbadge good" }, `✓ Screens get a 1080p copy (${fmtSize(m.screenCopy.size)})`);
  if (m.convert === "failed") return h("div", { class: "vbadge bad" }, `⚠ Converting failed: ${m.convertError ?? ""}`, retry("Try again"));
  if (m.convert === "needs-ffmpeg") {
    return h("div", { class: "vbadge bad" },
      `⚠ ${m.video?.label ?? "This video"}: many TVs can't play this and stay black. Install FFmpeg on the CMS computer to convert it automatically, or upload a 1920×1080 H.264 version.`,
      retry("Check again"));
  }
  if (m.video?.tvSafe) return h("div", { class: "vbadge good" }, `✓ Ready for screens · ${m.video.label}`);
  return null;
}

async function renameMedia(m) {
  const name = prompt("New name", m.name);
  if (!name) return;
  await api("PATCH", `/api/media/${m.id}`, { name });
  await loadMedia();
}

async function deleteMedia(m) {
  const used = state.playlists.filter((p) => p.items.some((i) => i.mediaId === m.id)).map((p) => p.name);
  const msg = used.length ? `Delete "${m.name}"? It will also be removed from: ${used.join(", ")}.` : `Delete "${m.name}"?`;
  if (!confirm(msg)) return;
  await api("DELETE", `/api/media/${m.id}`);
  await Promise.all([loadMedia(), loadPlaylists()]);
  toast("Deleted");
}

function uploadFiles(files) {
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const bar = $("#upload-progress");
  bar.hidden = false;
  bar.value = 0;
  // XHR rather than fetch so we can show upload progress for big videos.
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/media");
  xhr.setRequestHeader("authorization", `Bearer ${state.token}`);
  xhr.upload.onprogress = (e) => e.lengthComputable && (bar.value = (e.loaded / e.total) * 100);
  xhr.onload = async () => {
    bar.hidden = true;
    if (xhr.status === 201) {
      const n = JSON.parse(xhr.responseText).length;
      toast(`Uploaded ${n} file${n === 1 ? "" : "s"}`);
      await loadMedia();
    } else {
      toast(JSON.parse(xhr.responseText || "{}").error ?? "Upload failed");
    }
  };
  xhr.onerror = () => { bar.hidden = true; toast("Upload failed"); };
  xhr.send(form);
}

const dz = $("#dropzone");
$("#file-input").addEventListener("change", (e) => { uploadFiles([...e.target.files]); e.target.value = ""; });
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); });

// ---------- playlists ----------

async function loadPlaylists() {
  state.playlists = await api("GET", "/api/playlists");
  renderPlaylistList();
  renderPlaylistSelects();
}

function renderPlaylistList() {
  const ul = $("#playlist-list");
  ul.replaceChildren(...state.playlists.map((p) =>
    h("li", {}, h("button", { class: p.id === state.selectedPlaylist ? "active" : "", onclick: () => selectPlaylist(p.id) },
      `${p.name} `, h("span", { class: "muted" }, `(${p.items.length})`))),
  ));
  if (!state.playlists.length) ul.append(h("li", { class: "muted" }, "None yet"));
}

function selectPlaylist(id) {
  if (state.draft?.dirty && !confirm("Discard unsaved changes?")) return;
  state.selectedPlaylist = id;
  const p = state.playlists.find((x) => x.id === id);
  state.draft = p ? { ...p, items: p.items.map((i) => ({ ...i })), dirty: false } : null;
  renderPlaylistList();
  renderEditor();
}

function renderEditor() {
  const box = $("#playlist-editor");
  const d = state.draft;
  if (!d) { box.replaceChildren(h("p", { class: "muted" }, "Pick or create a playlist.")); return; }
  const touch = () => { d.dirty = true; renderEditor(); };
  // For typing: mark unsaved without re-rendering, so the text box keeps focus.
  const soft = () => { d.dirty = true; saveBtn.disabled = false; };
  const mediaById = Object.fromEntries(state.media.map((m) => [m.id, m]));
  const isVideo = (i) => i.kind === "media" && mediaById[i.mediaId]?.type === "video";
  const total = d.items.reduce((s, i) => s + (isVideo(i) ? 0 : i.duration), 0);
  const hasVideo = d.items.some(isVideo);

  const nameInput = h("input", { value: d.name, oninput: (e) => { d.name = e.target.value; soft(); } });
  const saveBtn = h("button", { disabled: !d.dirty, onclick: savePlaylist }, "Save");

  box.replaceChildren(
    h("div", { class: "editor-head" },
      nameInput,
      saveBtn,
      h("button", { class: "danger", onclick: deletePlaylist }, "Delete"),
    ),
    h("p", { class: "muted" },
      `${d.items.length} item${d.items.length === 1 ? "" : "s"} · about ${total}s${hasVideo ? " + videos" : ""}`,
      d.dirty ? " · unsaved changes" : ""),
    h("ol", { class: "items" }, d.items.map((it, idx) => h("li", { class: "item" },
      h("span", { class: "num" }, idx + 1),
      h("div", { class: "mini" }, itemThumb(it, mediaById)),
      h("div", { class: "fields" }, itemFields(it, mediaById, soft), itemDates(it, soft)),
      isVideo(it) ? h("span") : h("label", { class: "inline", title: "Seconds on screen" },
        h("input", { class: "dur", type: "number", min: 1, value: it.duration,
          onchange: (e) => { it.duration = Math.max(1, Number(e.target.value) || 1); touch(); } }), "s"),
      h("div", { class: "controls" },
        h("button", { class: "ghost small", disabled: idx === 0, title: "Move up",
          onclick: () => { [d.items[idx - 1], d.items[idx]] = [d.items[idx], d.items[idx - 1]]; touch(); } }, "↑"),
        h("button", { class: "ghost small", disabled: idx === d.items.length - 1, title: "Move down",
          onclick: () => { [d.items[idx + 1], d.items[idx]] = [d.items[idx], d.items[idx + 1]]; touch(); } }, "↓"),
        h("button", { class: "danger small", title: "Remove", onclick: () => { d.items.splice(idx, 1); touch(); } }, "✕"),
      ),
    ))),
    h("h2", {}, "Add"),
    h("div", { class: "inline wrap add-kinds" },
      h("button", { class: "ghost", onclick: () => {
        d.items.push({ kind: "text", text: "Your message here", color: "#ffffff", background: "#1f2937", scroll: false, duration: 10 });
        touch();
      } }, "+ Text or ticker"),
      h("button", { class: "ghost", onclick: () => {
        const url = prompt("YouTube link: a video, playlist or live stream", "https://www.youtube.com/watch?v=");
        if (!url || /v=$/.test(url)) return;
        if (!isYoutube(url)) { toast("That isn't a YouTube link. Use \"+ Web page\" for other sites."); return; }
        d.items.push({ kind: "web", url, sound: false, duration: 60 });
        touch();
      } }, "+ YouTube"),
      h("button", { class: "ghost", onclick: () => {
        const url = prompt("Web page address", "https://");
        if (url && url !== "https://") { d.items.push({ kind: "web", url, duration: 30 }); touch(); }
      } }, "+ Web page"),
      h("button", { class: "ghost", onclick: () => { d.items.push({ ...newZoneItem("channel", {}), duration: 300 }); touch(); } }, "+ Live news channel"),
      h("button", { class: "ghost", onclick: () => { d.items.push({ ...newZoneItem("x", {}), duration: 60 }); touch(); } }, "+ X posts"),
      h("button", { class: "ghost", onclick: () => {
        d.items.push({ kind: "clock", clocks: defaultClocks(), hour24: true, color: "#ffffff", background: "#111827", duration: 30 });
        touch();
      } }, "+ World clock"),
      h("button", { class: "ghost", onclick: () => openNewsPicker((url, label) => {
        d.items.push({ kind: "feed", url, mode: "ticker", title: label, color: "#ffffff", background: "#111827", duration: 60 });
        touch();
      }) }, "+ News feed"),
      h("button", { class: "ghost", onclick: () => {
        const url = prompt("Live stream address (HLS .m3u8 or a video URL)", "https://");
        if (url && url !== "https://") { d.items.push({ kind: "stream", url, duration: 60 }); touch(); }
      } }, "+ Live stream"),
    ),
    state.media.length
      ? h("div", { class: "picker" }, state.media.map((m) =>
          h("button", { title: `Add ${m.name}`, onclick: () => { d.items.push({ kind: "media", mediaId: m.id, duration: 10 }); touch(); } },
            h("div", { class: "mini" }, preview(m)), h("span", {}, `+ ${m.name}`))))
      : h("p", { class: "muted" }, "Upload images and videos in the Media tab to add them here."),
  );
}

const isYoutube = (url) => /^https?:\/\/([\w-]+\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\//i.test(url ?? "");

function itemThumb(it, mediaById) {
  if (it.kind === "media") return mediaById[it.mediaId] ? preview(mediaById[it.mediaId]) : "";
  if (it.kind === "text") {
    return h("div", { class: "glyph", style: `background:${it.background};color:${it.color}` }, it.scroll ? "ticker ›" : "Aa");
  }
  if (it.kind === "clock" || it.kind === "feed") {
    return h("div", { class: "glyph", style: `background:${it.background};color:${it.color}` },
      it.kind === "clock" ? `🕒 ${it.clocks.length} cit${it.clocks.length === 1 ? "y" : "ies"}` : it.mode === "list" ? "NEWS list" : "NEWS ›");
  }
  if (it.kind === "x") return h("div", { class: "glyph", style: "background:#000" }, "𝕏 posts");
  return h("div", { class: "glyph" }, it.kind === "stream" ? "LIVE" : channelIdOf(it.url) ? "▶ LIVE TV" : isYoutube(it.url) ? "▶ YouTube" : "WEB");
}

// ---------- world clock + news helpers ----------

const TIME_ZONES = [
  "Africa/Addis_Ababa", "Africa/Nairobi", "Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg", "Africa/Accra",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Istanbul", "Europe/Moscow",
  "Asia/Dubai", "Asia/Riyadh", "Asia/Karachi", "Asia/Kolkata", "Asia/Shanghai", "Asia/Singapore", "Asia/Tokyo",
  "Australia/Sydney", "Pacific/Auckland",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo", "UTC",
];
const cityName = (tz) => tz.split("/").pop().replace(/_/g, " ");

/** This browser's own time zone first, then a few world cities. */
function defaultClocks() {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return [here, "Europe/London", "America/New_York", "Asia/Tokyo"]
    .filter((tz, i, all) => all.indexOf(tz) === i).slice(0, 4).map((tz) => ({ label: cityName(tz), tz }));
}

function timeZoneList() {
  if (!$("#tz-list")) document.body.append(h("datalist", { id: "tz-list" }, TIME_ZONES.map((tz) => h("option", { value: tz }))));
  return "tz-list";
}

/** Editable list of cities for a world clock. Changes go straight into `clocks`. */
function clockFields(clocks, changed, rerender) {
  return h("div", { class: "clock-rows" },
    clocks.map((c, i) => h("div", { class: "inline" },
      h("input", { value: c.label, placeholder: "Label", class: "clock-label", oninput: (e) => { c.label = e.target.value; changed(); } }),
      h("input", { value: c.tz, list: timeZoneList(), placeholder: "Time zone, e.g. Africa/Addis_Ababa", class: "clock-tz",
        onchange: (e) => { if (!c.label || c.label === cityName(c.tz)) c.label = cityName(e.target.value); c.tz = e.target.value; changed(); rerender(); } }),
      h("button", { class: "danger small", type: "button", disabled: clocks.length === 1, title: "Remove city",
        onclick: () => { clocks.splice(i, 1); changed(); rerender(); } }, "✕"))),
    h("button", { class: "ghost small", type: "button", disabled: clocks.length >= 8,
      onclick: () => { clocks.push({ label: "London", tz: "Europe/London" }); changed(); rerender(); } }, "+ Add city"),
  );
}

const NEWS_EDITIONS = {
  "United States": "US:en", "United Kingdom": "GB:en", "Kenya": "KE:en", "Nigeria": "NG:en", "South Africa": "ZA:en",
  "Ghana": "GH:en", "India": "IN:en", "Canada": "CA:en", "Australia": "AU:en", "Ireland": "IE:en", "Singapore": "SG:en",
  "France (français)": "FR:fr", "Germany (Deutsch)": "DE:de", "Spain (español)": "ES:es", "Egypt (العربية)": "EG:ar",
};
const NEWS_TOPICS = {
  "Top stories": "", "World": "WORLD", "National": "NATION", "Business": "BUSINESS", "Technology": "TECHNOLOGY",
  "Science": "SCIENCE", "Health": "HEALTH", "Sports": "SPORTS", "Entertainment": "ENTERTAINMENT", "Search for…": "SEARCH",
};

function googleNewsUrl(ceid, topic, query) {
  const [gl, lang] = ceid.split(":");
  const params = `hl=${lang === "en" ? `en-${gl}` : lang}&gl=${gl}&ceid=${ceid}`;
  if (topic === "SEARCH") return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${params}`;
  if (topic) return `https://news.google.com/rss/headlines/section/topic/${topic}?${params}`;
  return `https://news.google.com/rss?${params}`;
}

/** Google News edition + topic (or search) pickers. Returns the element and a getter for the feed address and a label. */
function newsFields() {
  const edition = h("select", {}, Object.entries(NEWS_EDITIONS).map(([name, v]) => h("option", { value: v }, name)));
  const topic = h("select", {}, Object.entries(NEWS_TOPICS).map(([name, v]) => h("option", { value: v }, name)));
  const query = h("input", { placeholder: "Search words, e.g. Addis Ababa", hidden: true });
  topic.addEventListener("change", () => (query.hidden = topic.value !== "SEARCH"));
  const value = () => {
    if (topic.value === "SEARCH" && !query.value.trim()) throw new Error("Type what to search for");
    const label = topic.value === "SEARCH" ? query.value.trim() : topic.value ? topic.selectedOptions[0].text : "Top stories";
    return { url: googleNewsUrl(edition.value, topic.value, query.value.trim()), label };
  };
  return { el: h("div", { class: "inline wrap" }, edition, topic, query), value };
}

/** Pick a Google News feed (or paste any RSS address) and preview its headlines. */
function openNewsPicker(onPick) {
  const news = newsFields();
  const custom = h("input", { type: "url", placeholder: "…or paste any RSS feed address", class: "grow" });
  const preview = h("div", { class: "small-text muted" });
  const pick = () => {
    if (custom.value.trim()) return { url: custom.value.trim(), label: "" };
    return news.value();
  };
  openDialog("Add a news feed",
    h("p", { class: "muted small-text" }, "Headlines from Google News, refreshed every 10 minutes. Show them as a ticker or as a list."),
    news.el,
    h("div", { class: "inline wrap", style: "margin-top:8px" }, custom),
    preview,
    h("div", { class: "inline wrap dialog-actions" },
      h("button", { class: "ghost", onclick: async () => {
        try {
          preview.textContent = "Loading…";
          const { items } = await api("GET", `/api/feed-preview?url=${encodeURIComponent(pick().url)}`);
          preview.replaceChildren(h("ul", { class: "plain" }, items.slice(0, 5).map((i) => h("li", {}, i.title))));
        } catch (err) { preview.textContent = err.message; }
      } }, "Preview headlines"),
      h("span", { class: "spacer" }),
      h("button", { onclick: () => {
        try { const p = pick(); $("#dialog").close(); onPick(p.url, p.label); } catch (err) { toast(err.message); }
      } }, "Add feed")));
}

function itemFields(it, mediaById, soft, rerender = renderEditor) {
  switch (it.kind) {
    case "media": {
      const m = mediaById[it.mediaId];
      return [h("div", {}, m?.name ?? "(missing)"), h("div", { class: "muted" }, m?.type === "video" ? "Video plays to the end" : "")];
    }
    case "text":
      return [
        h("textarea", { rows: 2, value: it.text, oninput: (e) => { it.text = e.target.value; soft(); } }),
        h("div", { class: "inline wrap small-text" },
          h("label", { class: "inline" }, "Text", h("input", { type: "color", value: it.color, oninput: (e) => { it.color = e.target.value; soft(); } })),
          h("label", { class: "inline" }, "Background", h("input", { type: "color", value: it.background, oninput: (e) => { it.background = e.target.value; soft(); } })),
          h("label", { class: "inline" }, h("input", { type: "checkbox", checked: !!it.scroll, onchange: (e) => { it.scroll = e.target.checked; soft(); } }), "Scroll as a ticker"),
        ),
      ];
    case "web":
    case "stream":
      return [
        h("input", { type: "url", value: it.url, placeholder: "https://…", oninput: (e) => { it.url = e.target.value; soft(); } }),
        it.kind === "web" && isYoutube(it.url)
          ? h("label", { class: "inline small-text" }, h("input", { type: "checkbox", checked: !!it.sound, onchange: (e) => { it.sound = e.target.checked; soft(); } }),
              "Play with sound (some devices only allow muted autoplay)")
          : null,
        h("div", { class: "muted small-text" }, it.kind === "stream"
          ? "Live stream (HLS .m3u8 or a video URL). Plays nonstop if it's the only item."
          : isYoutube(it.url) ? "YouTube video, playlist or live stream. Needs internet on the screen." : "Web page. Needs internet on the screen."),
      ];
    case "x":
      return [
        h("input", { value: it.handle ? `@${String(it.handle).replace(/^@/, "")}` : "", placeholder: "@account, e.g. @dwnews",
          oninput: (e) => { it.handle = e.target.value; soft(); } }),
        h("div", { class: "inline wrap small-text" }, colorInputs(it, soft)),
        h("div", { class: "muted small-text" }, "Shows the account's recent posts using X's own embed. X decides what logged-out viewers see, so some accounts may show little or nothing."),
      ];
    case "clock": {
      const box = h("div", { class: "fields" });
      const draw = () => box.replaceChildren(
        clockFields(it.clocks, soft, draw),
        h("div", { class: "inline wrap small-text" },
          h("label", { class: "inline" }, h("input", { type: "checkbox", checked: it.hour24 !== false, onchange: (e) => { it.hour24 = e.target.checked; soft(); } }), "24-hour"),
          colorInputs(it, soft)));
      draw();
      return box;
    }
    case "feed":
      return [
        h("div", { class: "inline wrap" },
          h("input", { type: "url", value: it.url, class: "grow", oninput: (e) => { it.url = e.target.value; soft(); } }),
          h("button", { class: "ghost small", type: "button", onclick: () => openNewsPicker((url, label) => {
            it.url = url;
            if (label) it.title = label;
            soft();
            rerender();
          }) }, "Google News…")),
        h("div", { class: "inline wrap small-text" },
          h("select", { onchange: (e) => { it.mode = e.target.value; soft(); } },
            h("option", { value: "ticker", selected: it.mode !== "list" }, "Scrolling ticker"),
            h("option", { value: "list", selected: it.mode === "list" }, "Headline list")),
          h("input", { value: it.title ?? "", placeholder: "Title (optional)", class: "feed-title", oninput: (e) => { it.title = e.target.value; soft(); } }),
          colorInputs(it, soft)),
      ];
    default:
      return h("div", { class: "muted" }, `Unknown item (${it.kind})`);
  }
}

function colorInputs(it, soft) {
  return [
    h("label", { class: "inline" }, "Text", h("input", { type: "color", value: it.color, oninput: (e) => { it.color = e.target.value; soft(); } })),
    h("label", { class: "inline" }, "Background", h("input", { type: "color", value: it.background, oninput: (e) => { it.background = e.target.value; soft(); } })),
  ];
}

/** Optional "only show between" window, in each screen's own local time. */
function itemDates(it, soft) {
  const has = it.startAt || it.endAt;
  return h("details", { class: "dates", open: !!has },
    h("summary", { class: "small-text" }, has ? `Showing ${it.startAt ? "from " + it.startAt.replace("T", " ") : ""} ${it.endAt ? "until " + it.endAt.replace("T", " ") : ""}` : "Start / end date"),
    h("div", { class: "inline wrap small-text" },
      h("label", { class: "inline" }, "From", h("input", { type: "datetime-local", value: it.startAt ?? "",
        onchange: (e) => { it.startAt = e.target.value || null; soft(); } })),
      h("label", { class: "inline" }, "Until", h("input", { type: "datetime-local", value: it.endAt ?? "",
        onchange: (e) => { it.endAt = e.target.value || null; soft(); } })),
    ),
  );
}

async function savePlaylist() {
  const d = state.draft;
  try {
    await api("PUT", `/api/playlists/${d.id}`, { name: d.name, items: d.items });
    d.dirty = false;
    await loadPlaylists();
    selectPlaylist(d.id);
    toast("Saved. Screens update within 30 seconds.");
  } catch (err) { toast(err.message); }
}

async function deletePlaylist() {
  const d = state.draft;
  const screens = state.devices.filter((x) => x.playlistId === d.id).length;
  if (!confirm(`Delete playlist "${d.name}"?${screens ? ` ${screens} screen(s) using it will go blank.` : ""}`)) return;
  await api("DELETE", `/api/playlists/${d.id}`);
  state.draft = null;
  state.selectedPlaylist = null;
  await Promise.all([loadPlaylists(), loadLayouts(), loadDevices()]);
  renderEditor();
}

$("#new-playlist").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const p = await api("POST", "/api/playlists", { name: e.target.name.value });
    e.target.reset();
    await loadPlaylists();
    selectPlaylist(p.id);
  } catch (err) { toast(err.message); }
});

// ---------- layouts ----------

const LAYOUT_PRESETS = {
  "Fullscreen": [["Main", 0, 0, 100, 100]],
  "Main + ticker": [["Main", 0, 0, 100, 88], ["Ticker", 0, 88, 100, 12]],
  "Main + sidebar": [["Main", 0, 0, 75, 100], ["Sidebar", 75, 0, 25, 100]],
  "Main + sidebar + ticker": [["Main", 0, 0, 75, 88], ["Sidebar", 75, 0, 25, 88], ["Ticker", 0, 88, 100, 12]],
  "Two halves": [["Left", 0, 0, 50, 100], ["Right", 50, 0, 50, 100]],
  "Four quarters": [["Top left", 0, 0, 50, 50], ["Top right", 50, 0, 50, 50], ["Bottom left", 0, 50, 50, 50], ["Bottom right", 50, 50, 50, 50]],
};

async function loadLayouts() {
  state.layouts = await api("GET", "/api/layouts");
  renderLayoutList();
  renderPlaylistSelects();
}

function renderLayoutList() {
  const ul = $("#layout-list");
  ul.replaceChildren(...state.layouts.map((l) =>
    h("li", {}, h("button", { class: l.id === state.selectedLayout ? "active" : "", onclick: () => selectLayout(l.id) },
      `${l.name} `, h("span", { class: "muted" }, `(${l.zones.length} zone${l.zones.length === 1 ? "" : "s"})`))),
  ));
  if (!state.layouts.length) ul.append(h("li", { class: "muted" }, "None yet"));
}

function selectLayout(id) {
  if (state.layoutDraft?.dirty && !confirm("Discard unsaved changes?")) return;
  state.selectedLayout = id;
  const l = state.layouts.find((x) => x.id === id);
  state.layoutDraft = l ? { ...l, zones: l.zones.map((z) => ({ ...z, item: z.item ? structuredClone(z.item) : null })), dirty: false } : null;
  renderLayoutList();
  renderLayoutEditor();
}

/** What a zone shows: a playlist, or one source set directly on the zone. */
const ZONE_SOURCES = {
  playlist: "A playlist",
  youtube: "YouTube video / playlist",
  channel: "Live TV news channel",
  x: "X (Twitter) posts",
  feed: "News headlines (Google News / RSS)",
  clock: "World clock",
  text: "Text or ticker",
  web: "Web page",
};

/** Well-known news channels that stream live on YouTube. A channel may pause its stream or block embedding. */
const NEWS_CHANNELS = {
  "Al Jazeera English": "UCNye-wNBqNL5ZzHSJj3l8Bg",
  "DW News": "UCknLrEdhRCp1aegoMqRaCZg",
  "France 24 English": "UCQfwfsi5VrQ8yKZ-UWmAEFg",
  "Sky News": "UCoMdktPbSTixAyNGwb-UYkQ",
  "ABC News (US)": "UCBi2mrWuNuyYy4gbM6fU18Q",
  "NBC News": "UCeY0bbntWzzVIaj2z3QigXg",
  "Euronews": "UCSrZ3UV4jOidv8ppoVuvW9Q",
  "CNA": "UC83jt4dlz1Gjl58fzQrrKZg",
  "TRT World": "UC7fWeaHhqgM4Ry-RMpM2YYw",
  "Africanews": "UC1_E8NeF5QHY2dtdLRBCCLA",
};
const channelUrl = (id) => `https://www.youtube.com/channel/${id}/live`;
const channelIdOf = (url) => (url ?? "").match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1] ?? null;

function zoneSource(z) {
  const it = z.item;
  if (!it) return "playlist";
  if (it.kind === "web") return channelIdOf(it.url) ? "channel" : isYoutube(it.url) ? "youtube" : "web";
  return it.kind;
}

function newZoneItem(source, z) {
  const base = { duration: 30, color: "#ffffff", background: "#111827" };
  switch (source) {
    case "youtube": return { ...base, kind: "web", url: "", sound: false };
    case "channel": return { ...base, kind: "web", url: channelUrl(Object.values(NEWS_CHANNELS)[0]), sound: false };
    case "x": return { ...base, kind: "x", handle: "", background: "#000000" };
    case "feed": return { ...base, kind: "feed", url: googleNewsUrl("US:en", "", ""), mode: z.h <= 20 ? "ticker" : "list", title: "Top stories" };
    case "clock": return { ...base, kind: "clock", clocks: defaultClocks(), hour24: true };
    case "text": return { ...base, kind: "text", text: "Your message here", scroll: z.h <= 20 };
    case "web": return { ...base, kind: "web", url: "" };
    default: return null;
  }
}

/** Live TV channel picker: a preset list plus "another channel" for any YouTube channel link. */
function channelFields(it, soft, rerender) {
  const current = channelIdOf(it.url);
  const preset = Object.values(NEWS_CHANNELS).includes(current);
  return [
    h("select", { onchange: (e) => {
      it.url = e.target.value ? channelUrl(e.target.value) : "";
      soft();
      rerender();
    } },
      Object.entries(NEWS_CHANNELS).map(([name, id]) => h("option", { value: id, selected: id === current }, name)),
      h("option", { value: "", selected: !preset }, "Another YouTube channel…")),
    preset ? null : h("input", { type: "url", value: it.url, placeholder: "https://www.youtube.com/channel/UC…/live",
      oninput: (e) => { it.url = e.target.value; soft(); } }),
    h("label", { class: "inline small-text" }, h("input", { type: "checkbox", checked: !!it.sound, onchange: (e) => { it.sound = e.target.checked; soft(); } }), "Play with sound"),
    h("div", { class: "muted small-text" }, "Plays the channel's live stream. Channels sometimes pause their stream or don't allow it on other sites; pick another if a screen stays black."),
  ];
}

function zoneSourceLabel(z) {
  const src = zoneSource(z);
  if (src === "playlist") return state.playlists.find((p) => p.id === z.playlistId)?.name ?? "Nothing yet";
  if (src === "channel") return Object.entries(NEWS_CHANNELS).find(([, cid]) => cid === channelIdOf(z.item.url))?.[0] ?? "Live channel";
  if (src === "x") return z.item.handle ? `@${String(z.item.handle).replace(/^@/, "")} on X` : "X";
  return ZONE_SOURCES[src].split(" (")[0];
}

function renderLayoutEditor() {
  const box = $("#layout-editor");
  const d = state.layoutDraft;
  if (!d) { box.replaceChildren(h("p", { class: "muted" }, "Pick or create a layout.")); return; }
  const touch = () => { d.dirty = true; renderLayoutEditor(); };
  const soft = () => { d.dirty = true; saveBtn.disabled = false; };
  const saveBtn = h("button", { disabled: !d.dirty, onclick: saveLayout }, "Save");

  const zoneCard = (z, i) => {
    const num = (key, label) => h("label", { class: "inline small-text" }, label,
      h("input", { type: "number", min: key === "w" || key === "h" ? 1 : 0, max: 100, step: "any", value: z[key],
        onchange: (e) => { z[key] = Number(e.target.value); touch(); } }));
    const src = zoneSource(z);
    let fields;
    if (src === "playlist") {
      fields = h("select", { onchange: (e) => { z.playlistId = e.target.value || null; touch(); } },
        h("option", { value: "" }, "Pick a playlist…"),
        state.playlists.map((p) => h("option", { value: p.id, selected: p.id === z.playlistId }, p.name)));
    } else if (src === "channel") {
      fields = channelFields(z.item, soft, renderLayoutEditor);
    } else {
      fields = itemFields(z.item, {}, soft, renderLayoutEditor);
    }
    return h("div", { class: "zone-card" },
      h("div", { class: "zone-card-head" },
        h("span", { class: `swatch c${i % 6}` }),
        h("input", { value: z.name, class: "zone-name", oninput: (e) => { z.name = e.target.value; soft(); } }),
        h("button", { class: "danger small", disabled: d.zones.length === 1, title: "Remove zone",
          onclick: () => { d.zones.splice(i, 1); touch(); } }, "✕")),
      h("label", { class: "inline zone-source" }, "Shows",
        h("select", { onchange: (e) => {
          const next = e.target.value;
          z.item = next === "playlist" ? null : newZoneItem(next, z);
          touch();
        } }, Object.entries(ZONE_SOURCES).map(([v, label]) => h("option", { value: v, selected: v === src }, label)))),
      h("div", { class: "fields zone-fields" }, fields),
      h("details", { class: "zone-pos" }, h("summary", { class: "small-text" }, `Position ${z.x}%, ${z.y}% · size ${z.w}% × ${z.h}%`),
        h("div", { class: "inline wrap" }, num("x", "Left %"), num("y", "Top %"), num("w", "Width %"), num("h", "Height %"))),
    );
  };

  box.replaceChildren(
    h("div", { class: "editor-head" },
      h("input", { value: d.name, oninput: (e) => { d.name = e.target.value; soft(); } }),
      saveBtn,
      h("button", { class: "ghost", disabled: d.dirty, title: d.dirty ? "Save first" : "", onclick: () => openSendLayout(d) }, "Send to screens"),
      h("button", { class: "danger", onclick: deleteLayout }, "Delete"),
    ),
    h("p", { class: "muted" }, "Pick a shape, then choose what each zone shows: a playlist, YouTube, a live news channel, X posts, news headlines, a world clock and more.",
      d.dirty ? " · unsaved changes" : ""),
    h("div", { class: "inline wrap presets" }, Object.entries(LAYOUT_PRESETS).map(([name, zones]) =>
      h("button", { class: "ghost small", onclick: () => {
        // Keep what each zone already shows, zone by zone.
        d.zones = zones.map(([zn, x, y, w, hh], i) => ({
          id: d.zones[i]?.id, name: zn, x, y, w, h: hh, playlistId: d.zones[i]?.playlistId ?? null, item: d.zones[i]?.item ?? null,
        }));
        touch();
      } }, name))),
    h("div", { class: "screen-preview" }, d.zones.map((z, i) =>
      h("div", { class: `zone-box c${i % 6}`, style: `left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%` },
        h("strong", {}, z.name), h("span", {}, zoneSourceLabel(z))))),
    h("div", { class: "zone-cards" }, d.zones.map(zoneCard)),
    h("button", { class: "ghost", disabled: d.zones.length >= 12, onclick: () => {
      d.zones.push({ name: `Zone ${d.zones.length + 1}`, x: 0, y: 0, w: 50, h: 50, playlistId: null, item: null });
      touch();
    } }, "+ Add zone"),
    h("p", { class: "muted small-text" }, "Only the biggest zone plays sound. Each video zone needs its own video decoder, so cheap TV boxes may manage only one or two."),
  );
}

async function saveLayout() {
  const d = state.layoutDraft;
  try {
    await api("PUT", `/api/layouts/${d.id}`, { name: d.name, zones: d.zones });
    d.dirty = false;
    await loadLayouts();
    selectLayout(d.id);
    toast("Saved. Screens update within 30 seconds.");
  } catch (err) { toast(err.message); }
}

async function deleteLayout() {
  const d = state.layoutDraft;
  const screens = state.devices.filter((x) => x.layoutId === d.id).length;
  if (!confirm(`Delete layout "${d.name}"?${screens ? ` ${screens} screen(s) using it will go back to their playlist.` : ""}`)) return;
  await api("DELETE", `/api/layouts/${d.id}`);
  state.layoutDraft = null;
  state.selectedLayout = null;
  await Promise.all([loadLayouts(), loadDevices()]);
  renderLayoutEditor();
}

// ---------- ready-made designs + sending layouts to screens ----------

const FILL_LABELS = { main: "Your content", clock: "World clock", "news-ticker": "News ticker", "news-list": "Headlines", youtube: "YouTube" };
const THEMES = {
  "Dark": { color: "#ffffff", background: "#111827" },
  "Navy": { color: "#ffffff", background: "#1e3a8a" },
  "Light": { color: "#111827", background: "#f3f4f6" },
  "Black & gold": { color: "#facc15", background: "#000000" },
};

function zonePreview(zones, label) {
  return h("div", { class: "screen-preview mini-preview" }, zones.map((z, i) =>
    h("div", { class: `zone-box c${i % 6}`, style: `left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%` }, h("span", {}, label(z)))));
}

/** Checkboxes for screens and groups. Screens in a group are left out: they show what the group shows. */
function targetChecklist() {
  const boxes = [];
  const row = (kind, x, text, note) => {
    const cb = h("input", { type: "checkbox", value: x.id });
    boxes.push({ kind, cb });
    return h("label", { class: "inline target" }, cb, text, note ? h("span", { class: "muted small-text" }, note) : null);
  };
  const free = state.devices.filter((d) => !d.groupId);
  const el = h("div", { class: "targets" },
    state.groups.map((g) => row("group", g, `Group: ${g.name}`, `${state.devices.filter((d) => d.groupId === g.id).length} screens`)),
    free.map((d) => row("device", d, d.name, d.online ? "online" : "offline")),
    !state.groups.length && !free.length ? h("p", { class: "muted small-text" }, "No screens yet. Pair one in the Screens tab; you can send this later.") : null,
  );
  const value = () => ({
    deviceIds: boxes.filter((b) => b.kind === "device" && b.cb.checked).map((b) => b.cb.value),
    groupIds: boxes.filter((b) => b.kind === "group" && b.cb.checked).map((b) => b.cb.value),
  });
  return { el, value };
}

function openSendLayout(layout) {
  const targets = targetChecklist();
  openDialog(`Send "${layout.name}" to screens`,
    h("p", { class: "muted small-text" }, "The ticked screens and groups show this layout instead of what they show now (their schedules still apply)."),
    targets.el,
    h("div", { class: "inline wrap dialog-actions" }, h("span", { class: "spacer" }),
      h("button", { onclick: async () => {
        try {
          const { screens } = await api("POST", `/api/layouts/${layout.id}/send`, targets.value());
          $("#dialog").close();
          toast(`Sent to ${screens} screen${screens === 1 ? "" : "s"}/group${screens === 1 ? "" : "s"}. They switch within 30 seconds.`);
          await Promise.all([loadDevices(), loadGroups()]);
        } catch (err) { toast(err.message); }
      } }, "Send")));
}

async function openTemplates() {
  const templates = await api("GET", "/api/templates");
  openDialog("Ready-made designs",
    h("p", { class: "muted small-text" }, "Pick a design. You'll choose the YouTube link, news and cities next, then send it to your screens."),
    h("div", { class: "template-grid" }, templates.map((t) =>
      h("button", { class: "template-card", onclick: () => openTemplateSetup(t) },
        zonePreview(t.zones, (z) => FILL_LABELS[z.fill]),
        h("strong", {}, t.name),
        h("span", { class: "small-text muted" }, t.description)))));
}

function openTemplateSetup(t) {
  const fills = new Set(t.zones.map((z) => z.fill));
  const clocks = defaultClocks();
  const news = newsFields();
  const name = h("input", { value: t.name, required: true });
  const theme = h("select", {}, Object.keys(THEMES).map((k) => h("option", { value: k }, k)));
  const main = h("select", {}, h("option", { value: "" }, "A new empty playlist (fill it later)"),
    state.playlists.map((p) => h("option", { value: p.id }, p.name)));
  const youtube = h("input", { type: "url", placeholder: "https://www.youtube.com/watch?v=… (video, playlist or live)", class: "grow" });
  const sound = h("input", { type: "checkbox" });
  const clockBox = h("div");
  const drawClocks = () => clockBox.replaceChildren(clockFields(clocks, () => {}, drawClocks));
  drawClocks();
  const targets = targetChecklist();
  const section = (title, ...body) => h("div", { class: "setup-section" }, h("h3", {}, title), ...body);

  openDialog(t.name,
    zonePreview(t.zones, (z) => (z.name === FILL_LABELS[z.fill] ? z.name : `${z.name}: ${FILL_LABELS[z.fill]}`)),
    section("Name", h("div", { class: "inline wrap" }, name, h("label", { class: "inline small-text" }, "Colours", theme))),
    fills.has("main") ? section("Your content", main) : null,
    fills.has("youtube") ? section("YouTube", h("div", { class: "inline wrap" }, youtube),
      h("label", { class: "inline small-text" }, sound, "Play with sound")) : null,
    fills.has("news-ticker") || fills.has("news-list") ? section("Google News", news.el) : null,
    fills.has("clock") ? section("World clock cities", clockBox) : null,
    section("Send to", targets.el),
    h("div", { class: "inline wrap dialog-actions" },
      h("button", { class: "ghost", onclick: openTemplates }, "← Back"),
      h("span", { class: "spacer" }),
      h("button", { onclick: async () => {
        try {
          const feed = fills.has("news-ticker") || fills.has("news-list") ? news.value() : null;
          const result = await api("POST", `/api/templates/${t.id}/apply`, {
            name: name.value, ...THEMES[theme.value],
            mainPlaylistId: main.value || null,
            youtubeUrl: youtube.value.trim(), youtubeSound: sound.checked,
            feedUrl: feed?.url, feedTitle: feed?.label,
            clocks, ...targets.value(),
          });
          $("#dialog").close();
          toast(result.screens ? `Created "${result.layout.name}" and sent it. Screens switch within 30 seconds.` : `Created "${result.layout.name}".`);
          await Promise.all([loadPlaylists(), loadLayouts(), loadDevices(), loadGroups()]);
          selectLayout(result.layout.id);
        } catch (err) { toast(err.message); }
      } }, "Create design")));
}

$("#open-templates").addEventListener("click", () => openTemplates().catch((err) => toast(err.message)));

$("#new-layout").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const l = await api("POST", "/api/layouts", { name: e.target.name.value });
    e.target.reset();
    await loadLayouts();
    selectLayout(l.id);
  } catch (err) { toast(err.message); }
});

// ---------- devices ----------

/** One select for "what this screen shows": a fullscreen playlist or a layout. Values look like "playlist:<id>". */
function contentOptions(selected) {
  return [
    h("option", { value: "" }, "Nothing"),
    state.playlists.length ? h("optgroup", { label: "Playlists (fullscreen)" },
      state.playlists.map((p) => h("option", { value: `playlist:${p.id}`, selected: `playlist:${p.id}` === selected }, p.name))) : null,
    state.layouts.length ? h("optgroup", { label: "Layouts" },
      state.layouts.map((l) => h("option", { value: `layout:${l.id}`, selected: `layout:${l.id}` === selected }, l.name))) : null,
  ];
}

const contentValue = (x) => (x.layoutId ? `layout:${x.layoutId}` : x.playlistId ? `playlist:${x.playlistId}` : "");
const contentBody = (value) => {
  const [kind, id] = value.split(":");
  return { playlistId: kind === "playlist" ? id : null, layoutId: kind === "layout" ? id : null };
};

function renderPlaylistSelects() {
  const sel = $("#pair-form .content-select");
  const current = sel.value;
  sel.replaceChildren(...contentOptions(current).filter(Boolean));
  renderDevices();
  renderGroups();
  if (state.layoutDraft && !state.layoutDraft.dirty) renderLayoutEditor();
}

async function loadDevices() {
  state.devices = await api("GET", "/api/devices");
  renderDevices();
  renderGroups();
  if ($("#dialog").open) state.dialogRefresh?.();
}

// ---------- live status ----------

const LIVE_ICONS = { playing: "▶", loading: "…", error: "⚠", idle: "■", downloading: "⇩" };

/** One line on what a screen is doing: "▶ promo.mp4" or "⚠ This screen can't play 4K video". */
function liveSummary(live) {
  if (!live) return null;
  if (live.download && live.state === "downloading") {
    return h("div", { class: "live small-text" }, `⇩ Downloading ${live.download.done + 1} of ${live.download.total} (${live.download.mb} MB)`);
  }
  const err = live.zones.find((z) => z.state === "error");
  if (err) return h("div", { class: "live small-text bad" }, `⚠ ${err.label ?? err.kind ?? "Item"}: ${err.error ?? "failed"}`);
  const playing = live.zones.filter((z) => z.state === "playing" && z.label).map((z) => z.label);
  if (playing.length) return h("div", { class: "live small-text" }, `▶ ${playing.slice(0, 2).join(" · ")}${playing.length > 2 ? ` +${playing.length - 2}` : ""}`);
  return live.state ? h("div", { class: "live small-text muted" }, live.state) : null;
}

/** The full picture for the Control dialog: every zone, downloads, screen size and free space. */
function liveDetails(live) {
  if (!live) return h("p", { class: "muted small-text" }, "No live status yet. Screens send it from player version 1.4.0.");
  return h("div", { class: "live-details" },
    h("div", { class: "small-text muted" },
      [live.programName ? `Showing ${live.programName}` : "Nothing assigned", live.screen ? `screen ${live.screen}` : null,
        live.freeMb != null ? `${live.freeMb >= 1000 ? (live.freeMb / 1000).toFixed(1) + " GB" : live.freeMb + " MB"} free` : null,
        live.videoMode === "texture" ? "video: compatibility mode" : null, `updated ${fmtAgo(live.at)}`].filter(Boolean).join(" · ")),
    live.download ? h("div", { class: "small-text" }, `⇩ Downloading file ${live.download.done + 1} of ${live.download.total} (${live.download.mb} MB so far)`) : null,
    live.message ? h("div", { class: "small-text bad" }, live.message) : null,
    h("ul", { class: "zone-live" }, live.zones.map((z) => h("li", { class: z.state === "error" ? "bad" : "" },
      h("span", { class: "zl-icon" }, LIVE_ICONS[z.state] ?? "•"),
      h("span", {}, h("strong", {}, z.zoneName ?? "Zone"), ` ${z.label ?? z.kind ?? "nothing"}`,
        z.state !== "playing" ? h("span", { class: "muted" }, ` · ${z.state}`) : null,
        z.error ? h("div", { class: "small-text" }, z.error) : null)))),
  );
}

// Pushes from the CMS ("something changed") reload whatever is on screen, so screens' status updates live.
let liveSource = null;
let liveTimer = null;
function connectLive() {
  liveSource?.close();
  if (!state.token || typeof EventSource === "undefined") return;
  liveSource = new EventSource(`/api/live?token=${encodeURIComponent(state.token)}`);
  liveSource.onmessage = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (!$("#tab-devices").hidden || $("#dialog").open) loadDevices().catch(() => {});
      if (!$("#tab-dashboard").hidden) loadDashboard().catch(() => {});
      if (!$("#tab-media").hidden) loadMedia().catch(() => {});
    }, 250);
  };
}

function renderDevices() {
  const rows = $("#device-rows");
  if (!state.devices.length) {
    rows.replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No screens yet. Pair one above.")));
    return;
  }
  rows.replaceChildren(...state.devices.map((d) => h("tr", {},
    h("td", {}, h("strong", {}, d.name), h("div", { class: "small-text" }, `Paired ${new Date(d.pairedAt).toLocaleDateString()}`)),
    h("td", {}, h("span", { class: `dot ${d.online ? "on" : ""}` }), d.online ? "Online" : `Offline · ${fmtAgo(d.lastSeen)}`,
      d.online ? liveSummary(d.live) : null),
    h("td", { class: "showing" },
      state.groups.length ? h("select", { title: "Group", onchange: async (e) => {
        await api("PATCH", `/api/devices/${d.id}`, { groupId: e.target.value || null });
        toast("Saved. The screen switches within 30 seconds.");
        loadDevices();
      } }, h("option", { value: "" }, "No group"),
        state.groups.map((g) => h("option", { value: g.id, selected: g.id === d.groupId }, `Group: ${g.name}`))) : null,
      d.groupId
        ? h("div", { class: "small-text" }, "Shows the group's content", d.nowShowing ? ` · now: ${d.nowShowing}` : "")
        : [h("select", { title: "Shows", onchange: async (e) => {
            await api("PATCH", `/api/devices/${d.id}`, contentBody(e.target.value));
            toast("Saved. The screen switches within 30 seconds.");
            loadDevices();
          } }, contentOptions(contentValue(d))),
          scheduleSummary(d)]),
    h("td", { class: "small-text" }, [d.info?.manufacturer, d.info?.model].filter(Boolean).join(" ") || "—",
      d.info?.appVersion ? h("div", {}, `App ${d.info.appVersion}`) : ""),
    h("td", {}, h("div", { class: "inline" },
      h("button", { class: "ghost small", onclick: () => openControl(d.id) }, d.commands?.length ? "Control ⏳" : "Control"),
      h("button", { class: "ghost small", disabled: !!d.groupId, title: d.groupId ? "This screen follows its group's schedule" : "",
        onclick: () => openScheduleEditor(`Schedule for ${d.name}`, d, async (schedule) => {
        await api("PATCH", `/api/devices/${d.id}`, { schedule });
        await loadDevices();
      }) }, "Schedule"),
      h("button", { class: "ghost small", onclick: async () => {
        const name = prompt("Screen name", d.name);
        if (name) { await api("PATCH", `/api/devices/${d.id}`, { name }); loadDevices(); }
      } }, "Rename"),
      h("button", { class: "danger small", onclick: async () => {
        if (!confirm(`Remove "${d.name}"? The screen will go back to showing a pairing code.`)) return;
        await api("DELETE", `/api/devices/${d.id}`);
        loadDevices();
      } }, "Remove"),
    )),
  )));
}

// ---------- groups ----------

async function loadGroups() {
  state.groups = await api("GET", "/api/groups");
  renderGroups();
  renderDevices();
}

function renderGroups() {
  const box = $("#group-rows");
  if (!state.groups.length) { box.replaceChildren(h("p", { class: "muted small-text" }, "No groups yet.")); return; }
  box.replaceChildren(...state.groups.map((g) => {
    const members = state.devices.filter((d) => d.groupId === g.id);
    return h("div", { class: "group-row" },
      h("div", {}, h("strong", {}, g.name),
        h("div", { class: "small-text" }, `${members.length} screen${members.length === 1 ? "" : "s"}`,
          members.length ? `: ${members.map((m) => m.name).join(", ")}` : "")),
      h("div", {},
        h("select", { onchange: async (e) => {
          await api("PATCH", `/api/groups/${g.id}`, contentBody(e.target.value));
          toast("Saved. Screens in the group switch within 30 seconds.");
          loadGroups();
        } }, contentOptions(contentValue(g))),
        scheduleSummary(g)),
      h("div", { class: "inline wrap" },
        h("button", { class: "ghost small", disabled: !members.length, onclick: () => groupCommand(g, "refresh") }, "Refresh all"),
        h("button", { class: "ghost small", disabled: !members.length, onclick: () => groupCommand(g, "screenshot") }, "Screenshot all"),
        h("button", { class: "ghost small", onclick: () => openScheduleEditor(`Schedule for ${g.name}`, g, async (schedule) => {
          await api("PATCH", `/api/groups/${g.id}`, { schedule });
          await Promise.all([loadGroups(), loadDevices()]);
        }) }, "Schedule"),
        h("button", { class: "ghost small", onclick: async () => {
          const name = prompt("Group name", g.name);
          if (name) { await api("PATCH", `/api/groups/${g.id}`, { name }); loadGroups(); }
        } }, "Rename"),
        h("button", { class: "danger small", onclick: async () => {
          if (!confirm(`Delete group "${g.name}"? Its screens go back to their own content.`)) return;
          await api("DELETE", `/api/groups/${g.id}`);
          await Promise.all([loadGroups(), loadDevices()]);
        } }, "Delete"),
      ),
    );
  }));
}

async function groupCommand(g, type) {
  try {
    const { screens } = await api("POST", `/api/groups/${g.id}/commands`, { type });
    toast(`Sent to ${screens} screen${screens === 1 ? "" : "s"}. They pick it up within 15 seconds.`);
    loadDevices();
  } catch (err) { toast(err.message); }
}

// ---------- remote control + screenshots ----------

const COMMAND_LABELS = { refresh: "refresh", restart: "app restart", reboot: "reboot", screenshot: "screenshot" };

function openControl(deviceId) {
  const cur = () => state.devices.find((x) => x.id === deviceId);
  let watching = null;

  const send = async (type, question) => {
    const x = cur();
    if (question && !confirm(question)) return;
    try {
      await api("POST", `/api/devices/${x.id}/commands`, { type });
      toast(x.online ? "Sent. The screen picks it up within 15 seconds." : "Sent. The screen is offline, so it will run when it's back (within 10 minutes).");
      await loadDevices();
      render();
      watch();
    } catch (err) { toast(err.message); }
  };

  // Re-check every 3 s for a minute so a new screenshot or result shows up without reloading.
  const watch = () => {
    clearInterval(watching);
    let n = 0;
    watching = setInterval(async () => {
      if (!$("#dialog").open || ++n > 20) { clearInterval(watching); return; }
      const before = JSON.stringify(cur());
      await loadDevices().catch(() => {});
      if (JSON.stringify(cur()) !== before && $("#dialog").open) render();
    }, 3000);
  };

  const render = () => {
    const x = cur();
    if (!x) { $("#dialog").close(); return; }
    const r = x.lastCommandResult;
    openDialog(x.name,
      h("div", { class: "shot" }, x.screenshotAt
        ? h("img", { src: `/api/devices/${x.id}/screenshot?token=${encodeURIComponent(state.token)}&t=${Date.parse(x.screenshotAt)}`, alt: `Screenshot of ${x.name}` })
        : h("p", { class: "muted" }, "No screenshot yet.")),
      h("p", { class: "small-text muted" },
        x.screenshotAt ? `Screenshot taken ${fmtAgo(x.screenshotAt)}. ` : "",
        x.online ? "Online." : `Offline, last seen ${fmtAgo(x.lastSeen)}.`,
        x.commands.length ? ` Waiting for the screen to run: ${x.commands.map((c) => COMMAND_LABELS[c.type]).join(", ")}.` : ""),
      r ? h("p", { class: `small-text ${r.ok ? "muted" : "error"}` },
        `Last ${COMMAND_LABELS[r.type]} (${fmtAgo(r.at)}): ${r.message || (r.ok ? "done" : "failed")}`) : null,
      h("h3", { class: "live-head" }, "Live status"),
      x.online ? liveDetails(x.live) : h("p", { class: "muted small-text" }, "The screen is offline."),
      h("div", { class: "inline wrap dialog-actions" },
        h("button", { onclick: () => send("screenshot") }, "Take screenshot"),
        h("button", { class: "ghost", title: "Re-check content and play from the top", onclick: () => send("refresh") }, "Refresh content"),
        h("button", { class: "ghost", onclick: () => send("restart", `Restart the player app on "${x.name}"?`) }, "Restart app"),
        h("button", { class: "danger", onclick: () => send("reboot",
          `Reboot "${x.name}"? This only works on rooted devices; on others the app restarts instead.`) }, "Reboot device"),
      ),
    );
  };
  state.dialogRefresh = render;
  $("#dialog").addEventListener("close", () => { if (state.dialogRefresh === render) state.dialogRefresh = null; }, { once: true });
  render();
  if (cur()?.commands.length) watch();
}

$("#new-group").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", "/api/groups", { name: e.target.name.value });
    e.target.reset();
    loadGroups();
  } catch (err) { toast(err.message); }
});

function scheduleSummary(x) {
  if (!x.schedule?.length) return null;
  const n = x.schedule.length;
  return h("div", { class: "small-text" }, `${n} time slot${n === 1 ? "" : "s"}`, x.nowShowing ? ` · now: ${x.nowShowing}` : "");
}

// ---------- dialogs + schedule editor ----------

function openDialog(title, ...body) {
  const dlg = $("#dialog");
  dlg.replaceChildren(
    h("div", { class: "dialog-head" }, h("h2", {}, title), h("button", { class: "ghost small", title: "Close", onclick: () => dlg.close() }, "✕")),
    ...body.flat().filter((c) => c != null && c !== false),
  );
  if (!dlg.open) dlg.showModal();
  return dlg;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** Edits target.schedule in a dialog; save(schedule) sends it to the server. */
function openScheduleEditor(title, target, save) {
  const rules = (target.schedule ?? []).map((r) => ({ id: r.id, days: [...r.days], start: r.start, end: r.end, content: contentValue(r) }));
  const render = () => openDialog(title,
    h("p", { class: "muted small-text" },
      "Outside these time slots the screen shows its default content. Times use each screen's own clock. ",
      "A slot that ends before it starts runs past midnight. If slots overlap, the first one wins."),
    rules.length
      ? h("div", { class: "rules" }, rules.map((r, i) => h("div", { class: "rule" },
          h("div", { class: "days" }, WEEK.map((day) => h("label", { class: `day${r.days.includes(day) ? " on" : ""}` },
            h("input", { type: "checkbox", checked: r.days.includes(day),
              onchange: (e) => { r.days = e.target.checked ? [...r.days, day] : r.days.filter((x) => x !== day); render(); } }),
            DAY_NAMES[day]))),
          h("div", { class: "inline wrap" },
            h("input", { type: "time", value: r.start, onchange: (e) => (r.start = e.target.value) }),
            h("span", { class: "muted" }, "to"),
            h("input", { type: "time", value: r.end, onchange: (e) => (r.end = e.target.value) }),
            h("select", { onchange: (e) => (r.content = e.target.value) }, contentOptions(r.content)),
            h("button", { class: "danger small", title: "Remove time slot", onclick: () => { rules.splice(i, 1); render(); } }, "✕"),
          ),
        )))
      : h("p", { class: "muted" }, "No time slots: the screen always shows its default content."),
    h("div", { class: "inline wrap dialog-actions" },
      h("button", { class: "ghost", onclick: () => { rules.push({ days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", content: "" }); render(); } }, "+ Add time slot"),
      h("span", { class: "spacer" }),
      h("button", { onclick: async () => {
        try {
          await save(rules.map(({ id, days, start, end, content }) => ({ id, days, start, end, ...contentBody(content) })));
          $("#dialog").close();
          toast("Schedule saved. Screens update within 30 seconds.");
        } catch (err) { toast(err.message); }
      } }, "Save schedule"),
    ),
  );
  render();
}

$("#pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("#pair-error").textContent = "";
  try {
    await api("POST", "/api/devices/pair", { code: f.code.value, name: f.name.value, ...contentBody(f.content.value) });
    f.reset();
    toast("Screen paired");
    loadDevices();
  } catch (err) { $("#pair-error").textContent = err.message; }
});

// ---------- user accounts ----------

const ROLE_NAMES = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

async function loadUsers() {
  if (state.me?.role !== "admin") return;
  state.users = await api("GET", "/api/users");
  renderUsers();
}

function renderUsers() {
  $("#user-rows").replaceChildren(
    h("tr", {}, h("td", {}, h("strong", {}, "admin"), h("div", { class: "small-text muted" }, "Built-in, uses ADMIN_PASSWORD")),
      h("td", {}, "Admin"), h("td", {}, "—"), h("td")),
    ...state.users.map((u) => h("tr", {},
      h("td", {}, h("strong", {}, u.username), u.id === state.me?.id ? h("span", { class: "muted small-text" }, " (you)") : ""),
      h("td", {}, h("select", { onchange: async (e) => {
        try { await api("PATCH", `/api/users/${u.id}`, { role: e.target.value }); toast("Role changed"); }
        catch (err) { toast(err.message); }
        loadUsers();
      } }, Object.entries(ROLE_NAMES).map(([v, label]) => h("option", { value: v, selected: v === u.role }, label)))),
      h("td", { class: "small-text" }, new Date(u.createdAt).toLocaleDateString()),
      h("td", {}, h("div", { class: "inline" },
        h("button", { class: "ghost small", onclick: async () => {
          const password = prompt(`New password for ${u.username} (8+ characters). They'll be logged out everywhere.`);
          if (!password) return;
          try { await api("PATCH", `/api/users/${u.id}`, { password }); toast("Password reset"); }
          catch (err) { toast(err.message); }
        } }, "Reset password"),
        h("button", { class: "danger small", onclick: async () => {
          if (!confirm(`Delete the account "${u.username}"? They'll be logged out.`)) return;
          await api("DELETE", `/api/users/${u.id}`);
          loadUsers();
        } }, "Delete"),
      )),
    )),
  );
}

$("#new-user").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("POST", "/api/users", { username: f.username.value, password: f.password.value, role: f.role.value });
    f.reset();
    toast("User added");
    loadUsers();
  } catch (err) { toast(err.message); }
});

$("#account").addEventListener("click", () => {
  const me = state.me;
  if (!me.id) {
    openDialog("Your account",
      h("p", {}, "You're signed in as the built-in ", h("strong", {}, "admin"), "."),
      h("p", { class: "muted" }, "Its password is the ADMIN_PASSWORD setting the server starts with. To change it, restart the server with a new ADMIN_PASSWORD. You can also create named accounts in the Users tab."));
    return;
  }
  const form = h("form", { class: "stack" },
    h("label", {}, "Current password", h("input", { type: "password", name: "current", required: true, autocomplete: "current-password" })),
    h("label", {}, "New password (8+ characters)", h("input", { type: "password", name: "password", required: true, minlength: 8, autocomplete: "new-password" })),
    h("button", { type: "submit" }, "Change password"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/me/password", { current: form.current.value, password: form.password.value });
      $("#dialog").close();
      toast("Password changed");
    } catch (err) { toast(err.message); }
  });
  openDialog(`Signed in as ${me.username} (${ROLE_NAMES[me.role]})`, form);
});

// ---------- boot ----------

async function start() {
  $("#login").hidden = true;
  $("#main").hidden = false;
  try {
    state.me = await api("GET", "/api/me");
    document.body.dataset.role = state.me.role;
    $("#account").textContent = `${state.me.username} · ${ROLE_NAMES[state.me.role]}`;
    await Promise.all([loadMedia(), loadPlaylists(), loadLayouts(), loadGroups(), loadDevices(), loadUsers(), loadDashboard()]);
    connectLive();
  } catch { /* 401 already handled */ }
}

setInterval(() => {
  if (!state.token) return;
  if (!$("#tab-devices").hidden) loadDevices().catch(() => {});
  if (!$("#tab-dashboard").hidden) loadDashboard().catch(() => {});
}, 10000);
window.addEventListener("beforeunload", (e) => { if (state.draft?.dirty) e.preventDefault(); });

if (state.token) start(); else showLogin();
