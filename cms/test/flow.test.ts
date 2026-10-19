import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
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

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "signage-test-"));
  const { app } = createApp({ dataDir, adminPassword: "secret" });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
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
