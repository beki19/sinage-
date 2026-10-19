"use strict";

// ---------- state + helpers ----------

const state = { token: localStorage.getItem("token"), media: [], playlists: [], devices: [], selectedPlaylist: null, draft: null };
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
  state.token = null;
  localStorage.removeItem("token");
  $("#main").hidden = true;
  $("#login").hidden = false;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    const { token } = await api("POST", "/api/login", { password: e.target.password.value });
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
  }),
);

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
        h("div", { class: "muted" }, fmtSize(m.size)),
        h("div", { class: "actions" },
          h("button", { class: "ghost small", onclick: () => renameMedia(m) }, "Rename"),
          h("button", { class: "danger small", onclick: () => deleteMedia(m) }, "Delete"),
        ),
      ),
    ));
  }
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
      `${d.items.length} item${d.items.length === 1 ? "" : "s"} · images total ${total}s${hasVideo ? " + videos" : ""}`,
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
        const url = prompt("Web page or YouTube link", "https://");
        if (url && url !== "https://") { d.items.push({ kind: "web", url, duration: 30 }); touch(); }
      } }, "+ Web page / YouTube"),
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
  return h("div", { class: "glyph" }, it.kind === "stream" ? "LIVE" : isYoutube(it.url) ? "▶ YouTube" : "WEB");
}

function itemFields(it, mediaById, soft) {
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
        h("div", { class: "muted small-text" }, it.kind === "stream"
          ? "Live stream (HLS .m3u8 or a video URL). Plays nonstop if it's the only item."
          : "Web page, or a YouTube link (plays muted). Needs internet on the screen."),
      ];
    default:
      return h("div", { class: "muted" }, `Unknown item (${it.kind})`);
  }
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
  await Promise.all([loadPlaylists(), loadDevices()]);
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

// ---------- devices ----------

function playlistOptions(selected) {
  return [h("option", { value: "" }, "No playlist"),
    ...state.playlists.map((p) => h("option", { value: p.id, selected: p.id === selected }, p.name))];
}

function renderPlaylistSelects() {
  const sel = $("#pair-form .playlist-select");
  const current = sel.value;
  sel.replaceChildren(...playlistOptions(current));
  renderDevices();
}

async function loadDevices() {
  state.devices = await api("GET", "/api/devices");
  renderDevices();
}

function renderDevices() {
  const rows = $("#device-rows");
  if (!state.devices.length) {
    rows.replaceChildren(h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No screens yet. Pair one above.")));
    return;
  }
  rows.replaceChildren(...state.devices.map((d) => h("tr", {},
    h("td", {}, h("strong", {}, d.name), h("div", { class: "small-text" }, `Paired ${new Date(d.pairedAt).toLocaleDateString()}`)),
    h("td", {}, h("span", { class: `dot ${d.online ? "on" : ""}` }), d.online ? "Online" : `Offline · ${fmtAgo(d.lastSeen)}`),
    h("td", {}, h("select", { onchange: async (e) => {
      await api("PATCH", `/api/devices/${d.id}`, { playlistId: e.target.value || null });
      toast("Playlist assigned. The screen switches within 30 seconds.");
      loadDevices();
    } }, playlistOptions(d.playlistId))),
    h("td", { class: "small-text" }, [d.info?.manufacturer, d.info?.model].filter(Boolean).join(" ") || "—",
      d.info?.appVersion ? h("div", {}, `App ${d.info.appVersion}`) : ""),
    h("td", {}, h("div", { class: "inline" },
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

$("#pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("#pair-error").textContent = "";
  try {
    await api("POST", "/api/devices/pair", { code: f.code.value, name: f.name.value, playlistId: f.playlistId.value || null });
    f.reset();
    toast("Screen paired");
    loadDevices();
  } catch (err) { $("#pair-error").textContent = err.message; }
});

// ---------- boot ----------

async function start() {
  $("#login").hidden = true;
  $("#main").hidden = false;
  try {
    await Promise.all([loadMedia(), loadPlaylists(), loadDevices()]);
  } catch { /* 401 already handled */ }
}

setInterval(() => { if (state.token && !$("#tab-devices").hidden) loadDevices().catch(() => {}); }, 10000);
window.addEventListener("beforeunload", (e) => { if (state.draft?.dirty) e.preventDefault(); });

if (state.token) start(); else showLogin();
