import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";

let server: Server;
let base = "";
let dataDir = "";
let admin = "";
let flush = () => {};
let app!: ReturnType<typeof createApp>;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "signage-test-"));
  app = createApp({ dataDir, adminPassword: "secret", waitMs: 1500 });
  flush = () => app.store.save(); // writes any pending save now, so no timer fires after the folder is gone
  server = app.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  flush();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method: string, url: string, body?: unknown, auth?: string) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: auth } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test("admin login rejects a wrong password and accepts the right one", async () => {
  assert.equal((await api("POST", "/api/login", { password: "nope" })).status, 401);
  assert.equal((await api("GET", "/api/media")).status, 401);
  const ok = await api("POST", "/api/login", { password: "secret" });
  assert.equal(ok.status, 200);
  admin = `Bearer ${ok.json.token}`;
});

test("full flow: upload, playlist, pair a screen, fetch manifest and media, unpair", async () => {
  // Upload an image
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const form = new FormData();
  form.append("files", new Blob([png], { type: "image/png" }), "logo.png");
  form.append("files", new Blob(["not media"], { type: "text/plain" }), "notes.txt");
  const up = await fetch(base + "/api/media", { method: "POST", headers: { authorization: admin }, body: form });
  assert.equal(up.status, 201);
  const [media] = await up.json();
  assert.equal(media.type, "image");
  assert.equal(media.sha256, crypto.createHash("sha256").update(png).digest("hex"));
  assert.equal((await api("GET", "/api/media", undefined, admin)).json.length, 1, "text file was filtered out");

  // Playlist
  const pl = await api("POST", "/api/playlists", { name: "Lobby", items: [{ mediaId: media.id, duration: 8 }] }, admin);
  assert.equal(pl.status, 201);
  assert.equal((await api("POST", "/api/playlists", { name: "Bad", items: [{ mediaId: "missing" }] }, admin)).status, 404);

  // Screen registers and shows a code
  const reg = await api("POST", "/api/player/register", { info: { model: "Test TV" } });
  assert.equal(reg.status, 201);
  assert.match(reg.json.code, /^[A-Z2-9]{6}$/);
  const poll = `/api/player/pair-status?pollToken=${reg.json.pollToken}`;
  assert.equal((await api("GET", poll)).json.status, "pending");

  // Admin claims it
  assert.equal((await api("POST", "/api/devices/pair", { code: "ZZZZZZ", name: "x" }, admin)).status, 404);
  const paired = await api("POST", "/api/devices/pair",
    { code: reg.json.code.toLowerCase(), name: "Lobby TV", playlistId: pl.json.id }, admin);
  assert.equal(paired.status, 201);
  assert.equal(paired.json.token, undefined, "device token never goes to the admin UI");

  // Screen picks up its token exactly once
  const done = await api("GET", poll);
  assert.equal(done.json.status, "paired");
  assert.equal((await api("GET", poll)).status, 404);
  const device = `Device ${done.json.deviceToken}`;

  // Manifest + download
  const man = await api("GET", "/api/player/manifest", undefined, device);
  assert.equal(man.status, 200);
  assert.equal(man.json.items.length, 1);
  assert.equal(man.json.items[0].duration, 8);
  const file = await fetch(base + man.json.items[0].url, { headers: { authorization: device } });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.equal((await fetch(base + man.json.items[0].url)).status, 401);

  // Version changes when the playlist changes
  await api("PUT", `/api/playlists/${pl.json.id}`, { items: [{ mediaId: media.id, duration: 15 }] }, admin);
  const man2 = await api("GET", "/api/player/manifest", undefined, device);
  assert.notEqual(man2.json.version, man.json.version);

  const devices = await api("GET", "/api/devices", undefined, admin);
  assert.equal(devices.json[0].online, true);
  assert.equal(devices.json[0].info.model, "Test TV");

  // Deleting media removes it from playlists
  assert.equal((await api("DELETE", `/api/media/${media.id}`, undefined, admin)).status, 204);
  assert.equal((await api("GET", "/api/player/manifest", undefined, device)).json.items.length, 0);

  // Unpair cuts the screen off
  await api("DELETE", `/api/devices/${paired.json.id}`, undefined, admin);
  assert.equal((await api("GET", "/api/player/manifest", undefined, device)).status, 401);
});

/** Registers a screen and pairs it from the admin side. Returns the device auth header and its id. */
async function pairScreen(name: string, extra: Record<string, unknown> = {}) {
  const reg = await api("POST", "/api/player/register", { info: {} });
  const paired = await api("POST", "/api/devices/pair", { code: reg.json.code, name, ...extra }, admin);
  assert.equal(paired.status, 201);
  const done = await api("GET", `/api/player/pair-status?pollToken=${reg.json.pollToken}`);
  return { auth: `Device ${done.json.deviceToken}`, id: paired.json.id as string };
}

test("text, web, YouTube and stream items with start/end dates", async () => {
  const items = [
    { kind: "text", text: "Closed Monday", color: "#FFFFFF", background: "#000000", scroll: true, duration: 12 },
    { kind: "web", url: "https://example.com/menu", duration: 30, startAt: "2026-01-01T08:00", endAt: "2026-12-31T18:00" },
    { kind: "web", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", duration: 60 },
    { kind: "stream", url: "https://example.com/live.m3u8", duration: 60 },
  ];
  const pl = await api("POST", "/api/playlists", { name: "Mixed", items }, admin);
  assert.equal(pl.status, 201);
  assert.equal(pl.json.items[0].color, "#ffffff");

  const bad = [
    { kind: "text", text: "" },
    { kind: "web", url: "javascript:alert(1)" },
    { kind: "text", text: "x", color: "red" },
    { kind: "web", url: "https://a.b", startAt: "2026-02-01T00:00", endAt: "2026-01-01T00:00" },
    { kind: "web", url: "https://a.b", startAt: "tomorrow" },
    { kind: "nope" },
  ];
  for (const it of bad) assert.equal((await api("POST", "/api/playlists", { name: "x", items: [it] }, admin)).status, 400, JSON.stringify(it));

  const { auth } = await pairScreen("Kiosk", { playlistId: pl.json.id });
  const man = (await api("GET", "/api/player/manifest", undefined, auth)).json;
  assert.equal(man.defaultProgram, `playlist:${pl.json.id}`);
  const zone = man.programs[0].zones[0];
  assert.deepEqual([zone.x, zone.y, zone.w, zone.h], [0, 0, 100, 100]);
  assert.deepEqual(zone.items.map((i: { kind: string }) => i.kind), ["text", "web", "youtube", "stream"]);
  assert.equal(zone.items[0].scroll, true);
  assert.equal(zone.items[1].startAt, "2026-01-01T08:00");
  assert.equal(zone.items[2].videoId, "dQw4w9WgXcQ");
  assert.equal(man.items.length, 0, "old players only get images and videos");
  assert.equal(man.media.length, 0);
});

test("layouts: zones validated, screen gets one zone per playlist, deleting cleans up", async () => {
  const a = (await api("POST", "/api/playlists", { name: "Main", items: [{ kind: "text", text: "A" }] }, admin)).json;
  const t = (await api("POST", "/api/playlists", { name: "Ticker", items: [{ kind: "text", text: "News", scroll: true }] }, admin)).json;

  const zones = [
    { name: "Main", x: 0, y: 0, w: 100, h: 88, playlistId: a.id },
    { name: "Ticker", x: 0, y: 88, w: 100, h: 12, playlistId: t.id },
  ];
  assert.equal((await api("POST", "/api/layouts", { name: "x", zones: [{ x: 50, y: 0, w: 60, h: 10 }] }, admin)).status, 400);
  assert.equal((await api("POST", "/api/layouts", { name: "x", zones: [] }, admin)).status, 400);
  assert.equal((await api("POST", "/api/layouts", { name: "x", zones: [{ x: 0, y: 0, w: 10, h: 10, playlistId: "nope" }] }, admin)).status, 404);
  const layout = await api("POST", "/api/layouts", { name: "Lobby split", zones }, admin);
  assert.equal(layout.status, 201);

  const { auth, id: deviceId } = await pairScreen("Split TV", { layoutId: layout.json.id, playlistId: a.id });
  let man = (await api("GET", "/api/player/manifest", undefined, auth)).json;
  assert.equal(man.defaultProgram, `layout:${layout.json.id}`, "a layout wins over a playlist");
  assert.equal(man.programs[0].zones.length, 2);
  assert.equal(man.programs[0].zones[1].h, 12);
  assert.equal(man.programs[0].zones[1].items[0].text, "News");

  // Deleting a zone's playlist empties that zone; deleting the layout falls back to the playlist.
  await api("DELETE", `/api/playlists/${t.id}`, undefined, admin);
  man = (await api("GET", "/api/player/manifest", undefined, auth)).json;
  assert.equal(man.programs[0].zones[1].items.length, 0);
  await api("DELETE", `/api/layouts/${layout.json.id}`, undefined, admin);
  man = (await api("GET", "/api/player/manifest", undefined, auth)).json;
  assert.equal(man.defaultProgram, `playlist:${a.id}`);

  const dev = (await api("GET", "/api/devices", undefined, admin)).json.find((d: { id: string }) => d.id === deviceId);
  assert.equal(dev.layoutId, null);
});

test("scheduling: time slots validated, sent to the screen, and matched across midnight", async () => {
  const { ruleMatches } = await import("../src/app.js");
  const breakfast = (await api("POST", "/api/playlists", { name: "Breakfast", items: [{ kind: "text", text: "Eggs" }] }, admin)).json;
  const lunch = (await api("POST", "/api/playlists", { name: "Lunch", items: [{ kind: "text", text: "Soup" }] }, admin)).json;
  const { auth, id: deviceId } = await pairScreen("Menu board", { playlistId: lunch.id });

  for (const schedule of [
    [{ days: [], start: "06:00", end: "11:00", playlistId: breakfast.id }],
    [{ days: [1], start: "6:00", end: "11:00", playlistId: breakfast.id }],
    [{ days: [1], start: "06:00", end: "11:00" }],
  ]) {
    assert.equal((await api("PATCH", `/api/devices/${deviceId}`, { schedule }, admin)).status, 400, JSON.stringify(schedule));
  }
  const weekdays = [1, 2, 3, 4, 5];
  const ok = await api("PATCH", `/api/devices/${deviceId}`, { schedule: [{ days: weekdays, start: "06:00", end: "11:00", playlistId: breakfast.id }] }, admin);
  assert.equal(ok.status, 200);

  const man = (await api("GET", "/api/player/manifest", undefined, auth)).json;
  assert.equal(man.defaultProgram, `playlist:${lunch.id}`);
  assert.equal(man.programs.length, 2, "both the default and the scheduled playlist are sent");
  assert.deepEqual(man.schedule, [{ days: weekdays, start: "06:00", end: "11:00", program: `playlist:${breakfast.id}` }]);

  const rule = { days: weekdays, start: "06:00", end: "11:00" };
  const at = (s: string) => new Date(s); // local time
  assert.equal(ruleMatches(rule, at("2026-10-19T06:00")), true, "Monday 6:00");
  assert.equal(ruleMatches(rule, at("2026-10-19T11:00")), false, "end is exclusive");
  assert.equal(ruleMatches(rule, at("2026-10-18T07:00")), false, "Sunday");
  const night = { days: [5], start: "22:00", end: "02:00" };
  assert.equal(ruleMatches(night, at("2026-10-23T23:00")), true, "Friday night");
  assert.equal(ruleMatches(night, at("2026-10-24T01:30")), true, "early Saturday counts as Friday night");
  assert.equal(ruleMatches(night, at("2026-10-25T01:30")), false);
  assert.equal(ruleMatches({ days: [0], start: "00:00", end: "00:00" }, at("2026-10-18T15:00")), true, "all day Sunday");

  // Deleting a scheduled playlist drops its time slot.
  await api("DELETE", `/api/playlists/${breakfast.id}`, undefined, admin);
  const dev = (await api("GET", "/api/devices", undefined, admin)).json.find((d: { id: string }) => d.id === deviceId);
  assert.equal(dev.schedule.length, 0);
  assert.equal(dev.nowShowing, "Lunch");
});

test("groups: screens in a group show the group's content; deleting the group hands it back", async () => {
  const own = (await api("POST", "/api/playlists", { name: "Own", items: [{ kind: "text", text: "own" }] }, admin)).json;
  const shared = (await api("POST", "/api/playlists", { name: "Shared", items: [{ kind: "text", text: "shared" }] }, admin)).json;
  const group = await api("POST", "/api/groups", { name: "All lobby TVs", playlistId: shared.id }, admin);
  assert.equal(group.status, 201);
  assert.equal((await api("POST", "/api/devices/pair", { code: "X", name: "x", groupId: "nope" }, admin)).status, 404);

  const one = await pairScreen("Lobby 1", { playlistId: own.id, groupId: group.json.id });
  const two = await pairScreen("Lobby 2", { playlistId: own.id });
  await api("PATCH", `/api/devices/${two.id}`, { groupId: group.json.id }, admin);
  for (const s of [one, two]) {
    const man = (await api("GET", "/api/player/manifest", undefined, s.auth)).json;
    assert.equal(man.defaultProgram, `playlist:${shared.id}`);
  }

  // One change to the group reaches every screen in it.
  const sched = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00", playlistId: own.id }];
  await api("PATCH", `/api/groups/${group.json.id}`, { schedule: sched }, admin);
  const man = (await api("GET", "/api/player/manifest", undefined, two.auth)).json;
  assert.equal(man.schedule[0].program, `playlist:${own.id}`);

  assert.equal((await api("DELETE", `/api/groups/${group.json.id}`, undefined, admin)).status, 204);
  const after = (await api("GET", "/api/player/manifest", undefined, one.auth)).json;
  assert.equal(after.defaultProgram, `playlist:${own.id}`);
  assert.equal(after.schedule.length, 0);
});

test("remote commands and screenshots", async () => {
  const group = (await api("POST", "/api/groups", { name: "Cmd group" }, admin)).json;
  const screen = await pairScreen("Remote TV", { groupId: group.id });

  assert.equal((await api("POST", `/api/devices/${screen.id}/commands`, { type: "format-disk" }, admin)).status, 400);
  assert.equal((await api("POST", `/api/devices/${screen.id}/commands`, { type: "screenshot" }, admin)).status, 202);
  assert.equal((await api("POST", `/api/devices/${screen.id}/commands`, { type: "screenshot" }, admin)).status, 202);
  assert.equal((await api("POST", `/api/groups/${group.id}/commands`, { type: "reboot" }, admin)).json.screens, 1);

  let man = (await api("GET", "/api/player/manifest", undefined, screen.auth)).json;
  assert.deepEqual(man.commands.map((c: { type: string }) => c.type), ["screenshot", "reboot"], "duplicates are merged");
  const version = man.version;

  // Screenshot upload clears the screenshot command; only that device may upload.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  assert.equal((await fetch(base + "/api/player/screenshot", { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg })).status, 401);
  const up = await fetch(base + "/api/player/screenshot", { method: "POST", headers: { authorization: screen.auth, "content-type": "image/jpeg" }, body: jpeg });
  assert.equal(up.status, 204);
  const shot = await fetch(base + `/api/devices/${screen.id}/screenshot`, { headers: { authorization: admin } });
  assert.equal(shot.status, 200);
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), jpeg);

  // The screen reports the reboot twice: about to, then couldn't.
  const reboot = man.commands.find((c: { type: string }) => c.type === "reboot");
  await api("POST", `/api/player/commands/${reboot.id}/done`, { ok: true, message: "Rebooting" }, screen.auth);
  await api("POST", `/api/player/commands/${reboot.id}/done`, { ok: false, message: "Needs root" }, screen.auth);
  man = (await api("GET", "/api/player/manifest", undefined, screen.auth)).json;
  assert.equal(man.commands.length, 0);
  assert.equal(man.version, version, "commands don't change the content version");
  const dev = (await api("GET", "/api/devices", undefined, admin)).json.find((d: { id: string }) => d.id === screen.id);
  assert.deepEqual([dev.lastCommandResult.type, dev.lastCommandResult.ok, dev.lastCommandResult.message], ["reboot", false, "Needs root"]);
  assert.ok(dev.screenshotAt);
});

test("user accounts: roles, view-only, password changes, deleting logs out", async () => {
  // Built-in admin works with or without a username.
  assert.equal((await api("POST", "/api/login", { username: "admin", password: "secret" })).status, 200);
  assert.equal((await api("GET", "/api/me", undefined, admin)).json.role, "admin");

  assert.equal((await api("POST", "/api/users", { username: "admin", password: "longenough" }, admin)).status, 409);
  assert.equal((await api("POST", "/api/users", { username: "sam", password: "short" }, admin)).status, 400);
  assert.equal((await api("POST", "/api/users", { username: "sam", password: "longenough", role: "boss" }, admin)).status, 400);
  const sam = await api("POST", "/api/users", { username: "sam", password: "longenough", role: "editor" }, admin);
  assert.equal(sam.status, 201);
  assert.equal(sam.json.passwordHash, undefined);
  const vic = (await api("POST", "/api/users", { username: "vic", password: "viewonly1", role: "viewer" }, admin)).json;

  assert.equal((await api("POST", "/api/login", { username: "SAM", password: "wrongpass" })).status, 401);
  assert.equal((await api("POST", "/api/login", { username: "nobody", password: "longenough" })).status, 401);
  const editor = `Bearer ${(await api("POST", "/api/login", { username: "SAM", password: "longenough" })).json.token}`;
  const viewer = `Bearer ${(await api("POST", "/api/login", { username: "vic", password: "viewonly1" })).json.token}`;

  // Editors manage content but not users; viewers only look.
  assert.equal((await api("POST", "/api/playlists", { name: "By editor" }, editor)).status, 201);
  assert.equal((await api("GET", "/api/users", undefined, editor)).status, 403);
  assert.equal((await api("GET", "/api/playlists", undefined, viewer)).status, 200);
  assert.equal((await api("POST", "/api/playlists", { name: "By viewer" }, viewer)).status, 403);
  assert.equal((await api("GET", "/api/me", undefined, viewer)).json.username, "vic");

  // Own password change.
  assert.equal((await api("POST", "/api/me/password", { current: "nope", password: "newpassword" }, editor)).status, 400);
  assert.equal((await api("POST", "/api/me/password", { current: "longenough", password: "newpassword" }, editor)).status, 204);
  assert.equal((await api("POST", "/api/login", { username: "sam", password: "newpassword" })).status, 200);

  // Promoting takes effect at once; deleting logs the user out.
  await api("PATCH", `/api/users/${vic.id}`, { role: "editor" }, admin);
  assert.equal((await api("POST", "/api/playlists", { name: "By promoted" }, viewer)).status, 201);
  assert.equal((await api("DELETE", `/api/users/${vic.id}`, undefined, admin)).status, 204);
  assert.equal((await api("GET", "/api/playlists", undefined, viewer)).status, 401);
});

test("dashboard and offline alerts", async () => {
  // A stand-in for Slack/Discord that records what it receives.
  const received: { event: string; text: string; screen?: { name: string } }[] = [];
  const hook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => { received.push(JSON.parse(body)); res.end("ok"); });
  });
  hook.listen(0);
  await new Promise((r) => hook.once("listening", r));
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

  try {
    const viewer = (await api("POST", "/api/users", { username: "dash", password: "dashboard1", role: "viewer" }, admin)).json;
    const viewerAuth = `Bearer ${(await api("POST", "/api/login", { username: "dash", password: "dashboard1" })).json.token}`;
    assert.equal((await api("GET", "/api/settings", undefined, viewerAuth)).status, 403);
    assert.equal((await api("PUT", "/api/settings", { offlineAfterMinutes: 1 }, admin)).status, 400);
    assert.equal((await api("PUT", "/api/settings", { alertWebhookUrl: "ftp://x" }, admin)).status, 400);
    assert.equal((await api("PUT", "/api/settings", { alertWebhookUrl: hookUrl, offlineAfterMinutes: 2 }, admin)).status, 200);
    assert.equal((await api("POST", "/api/settings/test-alert", undefined, admin)).status, 204);
    assert.equal(received.at(-1)?.event, "test");

    const screen = await pairScreen("Watched TV");
    await api("GET", "/api/player/manifest", undefined, screen.auth);
    await app.checkAlerts(); // baseline: online, no alert
    const device = app.store.data.devices.find((d) => d.id === screen.id)!;
    device.lastSeen = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await app.checkAlerts();
    assert.equal(received.at(-1)?.event, "offline");
    assert.match(received.at(-1)!.text, /Watched TV/);
    await app.checkAlerts();
    assert.equal(received.filter((r) => r.event === "offline").length, 1, "one alert per change");
    await api("GET", "/api/player/manifest", undefined, screen.auth);
    await app.checkAlerts();
    assert.equal(received.at(-1)?.event, "online");

    const dash = (await api("GET", "/api/dashboard", undefined, viewerAuth)).json;
    assert.ok(dash.screens.total >= 1);
    assert.equal(dash.alertsOn, true);
    assert.deepEqual(dash.events.slice(0, 2).map((e: { type: string }) => e.type), ["online", "offline"]);
    await api("DELETE", `/api/users/${viewer.id}`, undefined, admin);
  } finally {
    hook.close();
  }
});

test("world clock, news feed and YouTube items", async () => {
  // A stand-in RSS feed shaped like Google News.
  const rss = `<?xml version="1.0"?><rss><channel><title>Top stories</title>
    <item><title>Rain &amp; wind expected - Daily Paper</title><source url="x">Daily Paper</source></item>
    <item><title><![CDATA[Markets <b>rise</b> again]]></title></item>
  </channel></rss>`;
  let hits = 0;
  const feed = http.createServer((_req, res) => { hits++; res.setHeader("content-type", "application/rss+xml"); res.end(rss); });
  feed.listen(0);
  await new Promise((r) => feed.once("listening", r));
  const feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/rss`;

  try {
    assert.equal((await api("POST", "/api/playlists", { name: "x", items: [{ kind: "clock", clocks: [] }] }, admin)).status, 400);
    assert.equal((await api("POST", "/api/playlists", { name: "x", items: [{ kind: "clock", clocks: [{ tz: "Mars/Base" }] }] }, admin)).status, 400);
    const pl = await api("POST", "/api/playlists", { name: "Widgets", items: [
      { kind: "clock", clocks: [{ tz: "Africa/Addis_Ababa" }, { label: "NYC", tz: "America/New_York" }], hour24: false },
      { kind: "feed", url: feedUrl, mode: "list", title: "News" },
      { kind: "web", url: "https://www.youtube.com/playlist?list=PLabcdefghijk", sound: true },
    ] }, admin);
    assert.equal(pl.status, 201);
    assert.equal(pl.json.items[0].clocks[0].label, "Addis Ababa");

    const preview = await api("GET", `/api/feed-preview?url=${encodeURIComponent(feedUrl)}`, undefined, admin);
    assert.deepEqual(preview.json.items, [{ title: "Rain & wind expected", source: "Daily Paper" }, { title: "Markets rise again", source: "" }]);

    const screen = await pairScreen("Widget TV", { playlistId: pl.json.id });
    const items = (await api("GET", "/api/player/manifest", undefined, screen.auth)).json.programs[0].zones[0].items;
    assert.deepEqual(items.map((i: { kind: string }) => i.kind), ["html", "html", "youtube"]);
    assert.match(items[0].html, /America\/New_York/);
    assert.match(items[1].html, /__DEVICE_TOKEN__/);
    assert.deepEqual([items[2].videoId, items[2].listId, items[2].sound], ["", "PLabcdefghijk", true]);

    const feedItemId = pl.json.items[1].id;
    const got = await api("GET", `/api/player/feed/${feedItemId}`, undefined, screen.auth);
    assert.equal(got.json.items.length, 2);
    assert.equal(hits, 1, "headlines are cached and shared");
    assert.equal((await api("GET", `/api/player/feed/${feedItemId}`)).status, 401);
  } finally {
    feed.close();
  }
});

test("premade layout templates create zones and go straight to screens", async () => {
  const templates = (await api("GET", "/api/templates", undefined, admin)).json;
  assert.ok(templates.length >= 5);
  const group = (await api("POST", "/api/groups", { name: "Template group" }, admin)).json;
  const screen = await pairScreen("Template TV");

  assert.equal((await api("POST", "/api/templates/youtube-news/apply", { name: "x" }, admin)).status, 400, "needs a YouTube link");
  assert.equal((await api("POST", "/api/templates/youtube-news/apply", { name: "x", youtubeUrl: "https://example.com" }, admin)).status, 400);
  const before = (await api("GET", "/api/playlists", undefined, admin)).json.length;
  const applied = await api("POST", "/api/templates/news-clock/apply", {
    name: "Reception", clocks: [{ label: "Addis Ababa", tz: "Africa/Addis_Ababa" }],
    feedUrl: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", deviceIds: [screen.id], groupIds: [group.id],
  }, admin);
  assert.equal(applied.status, 201);
  assert.equal(applied.json.screens, 2);
  assert.equal(applied.json.layout.zones.length, 3);
  assert.equal((await api("GET", "/api/playlists", undefined, admin)).json.length, before + 1, "only the main zone gets a playlist");

  const man = (await api("GET", "/api/player/manifest", undefined, screen.auth)).json;
  assert.equal(man.defaultProgram, `layout:${applied.json.layout.id}`);
  assert.deepEqual(man.programs[0].zones.map((z: { items: { kind: string }[] }) => z.items[0].kind), ["text", "html", "html"]);

  // An existing layout can be sent to more screens later.
  const other = await pairScreen("Template TV 2");
  assert.equal((await api("POST", `/api/layouts/${applied.json.layout.id}/send`, { deviceIds: [other.id] }, admin)).json.screens, 1);
  assert.equal((await api("GET", "/api/player/manifest", undefined, other.auth)).json.defaultProgram, `layout:${applied.json.layout.id}`);
});

test("layout zones can show a source directly: YouTube channel, X, clock", async () => {
  const zones = [
    { name: "Live news", x: 0, y: 0, w: 60, h: 100, item: { kind: "web", url: "https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg/live" } },
    { name: "X", x: 60, y: 0, w: 40, h: 50, item: { kind: "x", handle: "https://x.com/dwnews?lang=en" } },
    { name: "Clock", x: 60, y: 50, w: 40, h: 50, item: { kind: "clock", clocks: [{ tz: "Africa/Addis_Ababa" }] } },
  ];
  assert.equal((await api("POST", "/api/layouts", { name: "x", zones: [{ x: 0, y: 0, w: 10, h: 10, item: { kind: "x", handle: "not a handle!" } }] }, admin)).status, 400);
  const layout = await api("POST", "/api/layouts", { name: "Sources", zones }, admin);
  assert.equal(layout.status, 201);
  assert.equal(layout.json.zones[1].item.handle, "dwnews");

  const screen = await pairScreen("Sources TV", { layoutId: layout.json.id });
  const z = (await api("GET", "/api/player/manifest", undefined, screen.auth)).json.programs[0].zones;
  assert.deepEqual([z[0].items[0].kind, z[0].items[0].channelId], ["youtube", "UCknLrEdhRCp1aegoMqRaCZg"]);
  assert.equal(z[1].items[0].kind, "html");
  assert.match(z[1].items[0].html, /twitter\.com\/dwnews/);
  assert.match(z[2].items[0].html, /Africa\/Addis_Ababa/);
});

test("dashboard charts data: uptime history, status board, content mix, upcoming changes", async () => {
  const a = (await api("POST", "/api/playlists", { name: "Dash A", items: [{ kind: "text", text: "a" }] }, admin)).json;
  const b = (await api("POST", "/api/playlists", { name: "Dash B", items: [{ kind: "text", text: "b", scroll: true }] }, admin)).json;
  const screen = await pairScreen("Dash TV", { playlistId: a.id });
  // A slot starting in about two hours, every day.
  const at = new Date(Date.now() + 2 * 3600_000);
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  await api("PATCH", `/api/devices/${screen.id}`, { schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(at), end: hhmm(new Date(at.getTime() + 3600_000)), playlistId: b.id }] }, admin);
  await api("GET", "/api/player/manifest", undefined, screen.auth);

  const d = (await api("GET", "/api/dashboard", undefined, admin)).json;
  assert.equal(d.fleetHourly.length, 24);
  const row = d.screenList.find((x: { name: string }) => x.name === "Dash TV");
  assert.equal(row.hourly.length, 24);
  assert.ok(row.hourly[23] > 0, "the current hour shows the check-in");
  assert.equal(row.nowShowing, "Dash A");
  assert.ok(d.contentMix.some((m: { label: string }) => m.label === "Tickers"));
  const next = d.upcoming.find((u: { screen: string }) => u.screen === "Dash TV");
  assert.equal(next.to, "Dash B");
  assert.ok(Math.abs(Date.parse(next.at) - at.getTime()) < 61_000);
  assert.ok(Array.isArray(d.attention));
});

/** A tiny MP4 with just enough boxes for probeVideo: ftyp, then a moov holding an avc1 sample entry. */
function fakeMp4(width: number, height: number, profile = 100): Buffer {
  const box = (type: string, payload: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + payload.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, payload]);
  };
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const avcC = box("avcC", Buffer.from([1, profile, 0, 51, 0xff]));
  const avc1 = box("avc1", Buffer.concat([entry, avcC]));
  return Buffer.concat([box("ftyp", Buffer.from("isom0000", "latin1")), box("moov", box("stsd", avc1)), box("mdat", Buffer.alloc(16))]);
}

test("videos: size and codec are read on upload; 4K is flagged for conversion", async () => {
  const { probeVideo } = await import("../src/video.js");
  const tmp = path.join(dataDir, "probe.mp4");
  fs.writeFileSync(tmp, fakeMp4(3840, 2160));
  assert.deepEqual(probeVideo(tmp), { width: 3840, height: 2160, codec: "avc1", label: "H.264 High 5.1, 3840×2160", tvSafe: false });
  fs.writeFileSync(tmp, fakeMp4(1920, 1080, 77));
  assert.equal(probeVideo(tmp)?.tvSafe, true);

  const form = new FormData();
  form.append("files", new Blob([fakeMp4(3840, 2160)], { type: "video/mp4" }), "big.mp4");
  form.append("files", new Blob([fakeMp4(1280, 720)], { type: "video/mp4" }), "small.mp4");
  const up = await (await fetch(base + "/api/media", { method: "POST", headers: { authorization: admin }, body: form })).json();
  assert.equal(up[0].video.tvSafe, false);
  assert.ok(["needs-ffmpeg", "running", "failed"].includes(up[0].convert), up[0].convert);
  assert.equal(up[1].video.tvSafe, true);
  assert.equal(up[1].convert, null);
  for (const m of up) await api("DELETE", `/api/media/${m.id}`, undefined, admin);
});

test("live: a screen's wait call answers as soon as its content changes, and its status shows up", async () => {
  const pl = (await api("POST", "/api/playlists", { name: "Live A", items: [{ kind: "text", text: "hello" }] }, admin)).json;
  const screen = await pairScreen("Live TV", { playlistId: pl.id });
  const man = (await api("GET", "/api/player/manifest", undefined, screen.auth)).json;
  assert.ok(man.changeKey);

  // Nothing changes: the call is held open, then answers "no change".
  let t = Date.now();
  assert.equal((await api("GET", `/api/player/wait?key=${encodeURIComponent(man.changeKey)}`, undefined, screen.auth)).json.changed, false);
  assert.ok(Date.now() - t >= 1400, "held open until the timeout");

  // A playlist edit wakes it straight away.
  t = Date.now();
  const waiting = api("GET", `/api/player/wait?key=${encodeURIComponent(man.changeKey)}`, undefined, screen.auth);
  await new Promise((r) => setTimeout(r, 100));
  await api("PUT", `/api/playlists/${pl.id}`, { items: [{ kind: "text", text: "changed" }] }, admin);
  assert.equal((await waiting).json.changed, true);
  assert.ok(Date.now() - t < 1000, "answered within a second");

  // So does a command, and a stale key answers at once.
  assert.equal((await api("GET", "/api/player/wait?key=old", undefined, screen.auth)).json.changed, true);

  // Live status, with item names filled in for the admin page.
  const itemId = (await api("GET", "/api/playlists", undefined, admin)).json.find((p: { id: string }) => p.id === pl.id).items[0].id;
  assert.equal((await api("POST", "/api/player/status", {
    state: "playing", program: `playlist:${pl.id}`, screen: "1920×1080", freeMb: 5000, videoMode: "surface",
    zones: [{ zoneId: "main", itemId, kind: "text", state: "playing" }],
  }, screen.auth)).status, 204);
  const dev = (await api("GET", "/api/devices", undefined, admin)).json.find((d: { id: string }) => d.id === screen.id);
  assert.equal(dev.live.programName, "Live A");
  assert.equal(dev.live.zones[0].label, '"changed"');
  assert.equal(dev.live.zones[0].zoneName, "Fullscreen");

  // Broken JSON is a 400, not a server error.
  const bad = await fetch(base + "/api/playlists", { method: "POST", headers: { authorization: admin, "content-type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
});
