"use strict";

/**
 * Google Takeout processor.
 *
 * Google Takeout structure:
 *   Takeout/Google Photos/<Album or "Photos from YYYY">/
 *     photo.jpg
 *     photo.jpg.json   ← sidecar with GPS, dates, etc.
 *
 * The JSON sidecar has geoData.latitude/longitude (0.0 = no GPS).
 * This is the ONLY reliable source of GPS for Google Photos.
 */

const fs = require("fs-extra");
const path = require("path");
const sanitize = require("sanitize-filename");
const { getGPS, reverseGeocode } = require("./geocoder");

const PHOTO_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".bmp",
  ".raw",
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".3gp",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".3gp",
  ".wmv",
]);

function isMedia(filename) {
  return PHOTO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function isVideo(filename) {
  return VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/**
 * Find the JSON sidecar for a given media file path.
 * Google uses several naming patterns:
 *   photo.jpg      → photo.jpg.json
 *   photo(1).jpg   → photo(1).jpg.json
 *   very-long-nam… → very-long-nam….json  (truncated)
 */
async function findSidecar(mediaPath) {
  // Most common: same name + .json  (photo.jpg → photo.jpg.json)
  const direct = mediaPath + ".json";
  if (await fs.pathExists(direct)) return direct;

  // Spanish/newer Takeout exports: .supplemental-metadata.json
  const supplemental = mediaPath + ".supplemental-metadata.json";
  if (await fs.pathExists(supplemental)) return supplemental;

  // Some exports: basename without extension + .json  (photo.jpg → photo.json)
  const withoutExt = mediaPath.replace(/\.[^.]+$/, "") + ".json";
  if (await fs.pathExists(withoutExt)) return withoutExt;

  // Without extension + supplemental
  const withoutExtSupplemental =
    mediaPath.replace(/\.[^.]+$/, "") + ".supplemental-metadata.json";
  if (await fs.pathExists(withoutExtSupplemental))
    return withoutExtSupplemental;

  return null;
}

/**
 * Parse a Takeout JSON sidecar.
 * Returns { title, timestamp, latitude, longitude } or null.
 */
async function parseSidecar(sidecarPath) {
  try {
    const data = await fs.readJson(sidecarPath);
    const geo = data.geoData || data.geoDataExif || {};
    const lat = geo.latitude;
    const lon = geo.longitude;
    // Google uses 0.0 as "no location"
    const hasGPS = lat != null && lon != null && !(lat === 0 && lon === 0);

    const ts = data.photoTakenTime?.timestamp || data.creationTime?.timestamp;
    return {
      title: data.title || null,
      timestamp: ts ? new Date(parseInt(ts) * 1000) : null,
      latitude: hasGPS ? lat : null,
      longitude: hasGPS ? lon : null,
    };
  } catch {
    return null;
  }
}

/**
 * Build the organized destination path for a media file.
 * Structure: <outDir>/YYYY/MM/DD/<Country>/<City>/photos|videos/<filename>
 *         or <outDir>/YYYY/MM/DD/no-location/photos|videos/<filename>
 */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function buildPath(outDir, filename, date, location) {
  const d = date || new Date();
  const year = String(d.getUTCFullYear());
  const month = MONTH_NAMES[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, "0");
  const type = isVideo(filename) ? "videos" : "photos";
  const safe = sanitize(filename) || filename;

  const parts = [outDir, year, month, day];
  if (location?.country) {
    parts.push(sanitize(location.country));
    parts.push(sanitize(location.city || "unknown"));
  } else {
    parts.push("no-location");
  }
  parts.push(type);
  parts.push(safe);

  return path.join(...parts);
}

/**
 * Recursively collect all media files from a directory.
 * Returns array of absolute paths.
 */
async function collectMediaFiles(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectMediaFiles(full)));
    } else if (entry.isFile() && isMedia(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Process a Google Takeout extracted directory.
 *
 * @param {string} takeoutDir  - Path to extracted Takeout folder
 * @param {string} outDir      - Output directory
 * @param {Function} onProgress - Called with progress events
 * @returns {object} stats
 */
async function processTakeoutDir(takeoutDir, outDir, onProgress) {
  const mediaFiles = await collectMediaFiles(takeoutDir);
  const stats = {
    total: mediaFiles.length,
    done: 0,
    skipped: 0,
    noGPS: 0,
    errors: 0,
  };

  onProgress?.({ type: "start", total: stats.total });

  for (const mediaPath of mediaFiles) {
    const filename = path.basename(mediaPath);
    try {
      // 1. Find and parse sidecar JSON
      const sidecarPath = await findSidecar(mediaPath);
      const meta = sidecarPath ? await parseSidecar(sidecarPath) : null;

      const date = meta?.timestamp || null;
      let location = null;

      // 2. Reverse geocode if GPS available
      let gpsCoords =
        meta?.latitude != null
          ? { latitude: meta.latitude, longitude: meta.longitude }
          : await getGPS(mediaPath); // fallback: read EXIF from the image itself

      if (gpsCoords) {
        location = await reverseGeocode(
          gpsCoords.latitude,
          gpsCoords.longitude,
        );
        if (!location) {
          // Geocoder failed (network/rate-limit) — keep GPS coords in log
          onProgress?.({
            type: "warn",
            filename,
            msg: `geocode failed for (${gpsCoords.latitude.toFixed(4)}, ${gpsCoords.longitude.toFixed(4)}) — placed in no-location`,
          });
        }
      } else {
        stats.noGPS++;
      }

      // 3. Build destination path
      const destPath = buildPath(outDir, filename, date, location);

      // 4. Copy (skip if already exists)
      await fs.ensureDir(path.dirname(destPath));
      const loc = location
        ? `${location.country}/${location.city}`
        : "no-location";

      if (await fs.pathExists(destPath)) {
        stats.skipped++;
        onProgress?.({ type: "file", filename, skipped: true, location: loc });
        continue;
      }

      await fs.move(mediaPath, destPath);
      stats.done++;

      onProgress?.({ type: "file", filename, skipped: false, location: loc });
    } catch (err) {
      stats.errors++;
      onProgress?.({ type: "error", filename, error: err.message });
      console.error("[takeout] error on", filename, err.message);
    }
  }

  return stats;
}

module.exports = { processTakeoutDir, collectMediaFiles, parseSidecar };
