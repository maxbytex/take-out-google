"use strict";

require("dotenv").config();
const express = require("express");
const path = require("path");
const { processTakeoutDir } = require("./takeout");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "./downloads";

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── In-memory state ──────────────────────────────────────────────────────────
let takeoutJob = null;

// ─── Takeout routes ─────────────────────────────────────────────────────────
// POST /api/takeout/process  body: { takeoutDir, outDir? }
app.post("/api/takeout/process", (req, res) => {
  if (takeoutJob && takeoutJob.status === "running") {
    return res.status(409).json({ error: "A Takeout job is already running." });
  }
  const { takeoutDir, outDir } = req.body;
  if (!takeoutDir)
    return res.status(400).json({ error: "takeoutDir is required." });

  // Safety: must be an absolute path within the server filesystem
  const resolvedIn = path.resolve(takeoutDir);
  const resolvedOut = path.resolve(outDir || DOWNLOAD_DIR);

  takeoutJob = {
    status: "running",
    logs: [],
    stats: null,
    startedAt: new Date().toISOString(),
  };
  res.json({ message: "Takeout processing started." });

  (async () => {
    try {
      const stats = await processTakeoutDir(
        resolvedIn,
        resolvedOut,
        (event) => {
          if (event.type === "start") {
            takeoutJob.logs.push(
              `Found ${event.total} media files — starting…`,
            );
          } else if (event.type === "file") {
            const loc =
              event.location && event.location !== "no-location"
                ? ` 📍 ${event.location}`
                : "";
            takeoutJob.logs.push(
              JSON.stringify({
                type: "file",
                filename: event.filename,
                skipped: event.skipped,
                location: event.location || "no-location",
                album: event.album || null,
              }),
            );
          } else if (event.type === "error") {
            takeoutJob.logs.push(
              JSON.stringify({
                type: "error",
                filename: event.filename,
                error: event.error,
              }),
            );
          }
          if (takeoutJob.logs.length > 1000) takeoutJob.logs.shift();
        },
      );
      takeoutJob.status = "done";
      takeoutJob.stats = stats;
      takeoutJob.finishedAt = new Date().toISOString();
    } catch (err) {
      takeoutJob.status = "error";
      takeoutJob.error = err.message;
      takeoutJob.finishedAt = new Date().toISOString();
      console.error("[takeout] fatal:", err.message);
    }
  })();
});

app.get("/api/takeout/logs", (req, res) => {
  if (!takeoutJob) return res.json({ logs: [] });
  res.json({
    status: takeoutJob.status,
    logs: takeoutJob.logs,
    stats: takeoutJob.stats,
    error: takeoutJob.error,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(
    `\n🚀  Google Photos Downloader running at http://localhost:${PORT}\n`,
  );
});
