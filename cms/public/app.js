"use strict";

// ---------- state + helpers ----------

const state = {
  token: localStorage.getItem("token"),
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
  state.layoutDraft = l ? { ...l, zones: l.zones.map((z) => ({ ...z })), dirty: false } : null;
  renderLayoutList();
  renderLayoutEditor();
}

function renderLayoutEditor() {
  const box = $("#layout-editor");
  const d = state.layoutDraft;
  if (!d) { box.replaceChildren(h("p", { class: "muted" }, "Pick or create a layout.")); return; }
  const touch = () => { d.dirty = true; renderLayoutEditor(); };
  const saveBtn = h("button", { disabled: !d.dirty, onclick: saveLayout }, "Save");
  const playlistName = (pid) => state.playlists.find((p) => p.id === pid)?.name ?? "No playlist";

  box.replaceChildren(
    h("div", { class: "editor-head" },
      h("input", { value: d.name, oninput: (e) => { d.name = e.target.value; d.dirty = true; saveBtn.disabled = false; } }),
      saveBtn,
      h("button", { class: "danger", onclick: deleteLayout }, "Delete"),
    ),
    h("p", { class: "muted" }, "Start from a preset, then pick a playlist for each zone.", d.dirty ? " · unsaved changes" : ""),
    h("div", { class: "inline wrap presets" }, Object.entries(LAYOUT_PRESETS).map(([name, zones]) =>
      h("button", { class: "ghost small", onclick: () => {
        // Keep playlists already chosen, zone by zone.
        d.zones = zones.map(([zn, x, y, w, hh], i) => ({ id: d.zones[i]?.id, name: zn, x, y, w, h: hh, playlistId: d.zones[i]?.playlistId ?? null }));
        touch();
      } }, name))),
    h("div", { class: "screen-preview" }, d.zones.map((z, i) =>
      h("div", { class: `zone-box c${i % 6}`, style: `left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%` },
        h("strong", {}, z.name), h("span", {}, playlistName(z.playlistId))))),
    h("table", { class: "zones" },
      h("thead", {}, h("tr", {}, ["Zone", "Playlist", "Left %", "Top %", "Width %", "Height %", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, d.zones.map((z, i) => {
        const num = (key) => h("input", { type: "number", min: key === "w" || key === "h" ? 1 : 0, max: 100, step: "any", value: z[key],
          onchange: (e) => { z[key] = Number(e.target.value); touch(); } });
        return h("tr", {},
          h("td", {}, h("span", { class: `swatch c${i % 6}` }), h("input", { value: z.name, oninput: (e) => { z.name = e.target.value; d.dirty = true; saveBtn.disabled = false; } })),
          h("td", {}, h("select", { onchange: (e) => { z.playlistId = e.target.value || null; touch(); } },
            h("option", { value: "" }, "No playlist"),
            state.playlists.map((p) => h("option", { value: p.id, selected: p.id === z.playlistId }, p.name)))),
          h("td", {}, num("x")), h("td", {}, num("y")), h("td", {}, num("w")), h("td", {}, num("h")),
          h("td", {}, h("button", { class: "danger small", disabled: d.zones.length === 1, title: "Remove zone",
            onclick: () => { d.zones.splice(i, 1); touch(); } }, "✕")),
        );
      })),
    ),
    h("button", { class: "ghost", disabled: d.zones.length >= 12, onclick: () => {
      d.zones.push({ name: `Zone ${d.zones.length + 1}`, x: 0, y: 0, w: 50, h: 50, playlistId: null });
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
    ...body,
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

// ---------- boot ----------

async function start() {
  $("#login").hidden = true;
  $("#main").hidden = false;
  try {
    await Promise.all([loadMedia(), loadPlaylists(), loadLayouts(), loadGroups(), loadDevices()]);
  } catch { /* 401 already handled */ }
}

setInterval(() => { if (state.token && !$("#tab-devices").hidden) loadDevices().catch(() => {}); }, 10000);
window.addEventListener("beforeunload", (e) => { if (state.draft?.dirty) e.preventDefault(); });

if (state.token) start(); else showLogin();
