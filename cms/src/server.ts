import path from "node:path";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin";
if (!process.env.ADMIN_PASSWORD) {
  console.warn("ADMIN_PASSWORD is not set; using the default password \"admin\". Set it before going live.");
}

const { app } = createApp({
  dataDir,
  adminPassword,
  maxUploadMb: process.env.MAX_UPLOAD_MB ? Number(process.env.MAX_UPLOAD_MB) : undefined,
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Signage CMS on http://0.0.0.0:${port} (data in ${dataDir})`);
});
