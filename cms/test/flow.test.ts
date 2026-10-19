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
