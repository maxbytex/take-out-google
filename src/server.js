'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const sanitize = require('sanitize-filename');

const { createOAuth2Client, getAuthUrl, getTokens, setCredentials } = require('./auth');
const { createSession, pollSession, getPickedMediaItems, deleteSession } = require('./photos');
const { getGPS, reverseGeocode } = require('./geocoder');
const { processTakeoutDir } = require('./takeout');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
}));

// ─── In-memory state ──────────────────────────────────────────────────────────
let currentJob = null;
let takeoutJob = null;

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const oAuth2Client = createOAuth2Client();
  res.redirect(getAuthUrl(oAuth2Client));
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const oAuth2Client = createOAuth2Client();
    const tokens = await getTokens(oAuth2Client, code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}

function getAuthedClient(req) {
  const oAuth2Client = createOAuth2Client();
  setCredentials(oAuth2Client, req.session.tokens);
  return oAuth2Client;
}

// ─── Download helper ──────────────────────────────────────────────────────────
const os = require('os');

function getDateParts(item) {
  if (!item.createTime) return { year: 'unknown', month: 'unknown', day: 'unknown' };
  const d = new Date(item.createTime);
  return {
    year:  String(d.getUTCFullYear()),
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
    day:   String(d.getUTCDate()).padStart(2, '0'),
  };
}

// Build final dest path given item + optional location
function buildDestPath(item, location) {
  const mf = item.mediaFile || {};
  const isVideo = (mf.mimeType || '').startsWith('video/');
  const { year, month, day } = getDateParts(item);
  const typeFolder = isVideo ? 'videos' : 'photos';
  const filename = sanitize(mf.filename || item.id + (isVideo ? '.mp4' : '.jpg')) || item.id;

  // Structure: YYYY/MM/DD/<Country>/<City>/photos|videos/<filename>
  //            or YYYY/MM/DD/no-location/photos|videos/<filename>
  const parts = [DOWNLOAD_DIR, year, month, day];
  if (location && location.country) {
    parts.push(sanitize(location.country));
    parts.push(sanitize(location.city || 'unknown-city'));
  } else {
    parts.push('no-location');
  }
  parts.push(typeFolder);
  parts.push(filename);

  return { destPath: path.join(...parts), isVideo, filename };
}

async function downloadMediaItem(item, oAuth2Client) {
  const mf = item.mediaFile || {};
  const baseUrl = mf.baseUrl;
  if (!baseUrl) throw new Error('No baseUrl for item ' + item.id);

  const { token } = await oAuth2Client.getAccessToken();
  const isVideo = (mf.mimeType || '').startsWith('video/');
  const downloadUrl = baseUrl + (isVideo ? '=dv' : '=d');
  const rawFilename = sanitize(mf.filename || item.id + (isVideo ? '.mp4' : '.jpg')) || item.id;

  // 1. Download to a temp file first
  const tmpPath = path.join(os.tmpdir(), `gphotos-${item.id}-${rawFilename}`);
  let response;
  try {
    response = await axios.get(downloadUrl, {
      responseType: 'stream',
      timeout: 60000,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`
      : err.message;
    throw new Error(detail);
  }

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tmpPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // 2. Read GPS from EXIF (works for JPEG, HEIC, TIFF, PNG)
  let location = null;
  if (!isVideo) {
    const gps = await getGPS(tmpPath);
    if (gps) {
      location = await reverseGeocode(gps.latitude, gps.longitude);
    }
  }

  // 3. Move to final organized path
  const { destPath } = buildDestPath(item, location);
  await fs.ensureDir(path.dirname(destPath));

  if (await fs.pathExists(destPath)) {
    await fs.remove(tmpPath);
    return { skipped: true, path: destPath, location };
  }

  await fs.move(tmpPath, destPath);
  return { skipped: false, path: destPath, location };
}

// ─── API routes ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!req.session.tokens, job: currentJob });
});

// Debug: test GPS extraction on a file already in downloads/
// Usage: /api/debug-gps?file=downloads/no-location/photos/IMG_6033.HEIC
app.get('/api/debug-gps', requireAuth, async (req, res) => {
  const filePath = path.resolve(req.query.file || '');
  if (!filePath.startsWith(path.resolve(DOWNLOAD_DIR))) {
    return res.status(400).json({ error: 'Path must be inside downloads/' });
  }
  try {
    const exifr = await import('exifr');
    const lib = exifr.default || exifr;
    const all = await lib.parse(filePath, { gps: true, tiff: true, heic: true, icc: false, iptc: false, xmp: false });
    const gps  = await getGPS(filePath);
    const loc  = gps ? await reverseGeocode(gps.latitude, gps.longitude) : null;
    res.json({ file: req.query.file, exifKeys: all ? Object.keys(all) : null, gps, location: loc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 1: Create a Picker session → returns pickerUri for the user to open
app.post('/api/picker/start', requireAuth, async (req, res) => {
  try {
    const client = getAuthedClient(req);
    const pickerSession = await createSession(client);
    req.session.pickerSessionId = pickerSession.id;
    res.json({ pickerUri: pickerSession.pickerUri, sessionId: pickerSession.id });
  } catch (err) {
    console.error('[server] picker/start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Poll whether user finished picking
app.get('/api/picker/status', requireAuth, async (req, res) => {
  const sessionId = req.session.pickerSessionId;
  if (!sessionId) return res.json({ ready: false, error: 'No active picker session' });
  try {
    const client = getAuthedClient(req);
    const { token } = await client.getAccessToken();
    const r = await axios.get(
      `https://photospicker.googleapis.com/v1/sessions/${sessionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json({ ready: r.data.mediaItemsSet === true });
  } catch (err) {
    res.json({ ready: false, error: err.message });
  }
});

// Step 2b: Preview metadata and planned folder structure BEFORE downloading
app.get('/api/picker/preview', requireAuth, async (req, res) => {
  const sessionId = req.session.pickerSessionId;
  if (!sessionId) return res.status(400).json({ error: 'No active picker session.' });
  try {
    const client = getAuthedClient(req);
    const items = await getPickedMediaItems(client, sessionId);
    // Log first item raw for debugging
    if (items[0]) console.log('[preview] first item raw:', JSON.stringify(items[0], null, 2));
    const preview = items.map(item => {
      const mf = item.mediaFile || {};
      const meta = mf.mediaFileMetadata || {};
      const { destPath } = buildDestPath(item);
      return {
        filename: mf.filename || item.id,
        createTime: item.createTime,
        mimeType: mf.mimeType,
        type: item.type,
        camera: meta.photo?.cameraModel || meta.video?.cameraModel || null,
        width: meta.width,
        height: meta.height,
        destPath: destPath.replace(DOWNLOAD_DIR, 'downloads'),
      };
    });
    res.json({ total: items.length, preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 3: Download all picked items
app.post('/api/picker/download', requireAuth, async (req, res) => {
  if (currentJob && currentJob.status === 'running') {
    return res.status(409).json({ error: 'A download is already running.' });
  }
  const sessionId = req.session.pickerSessionId;
  if (!sessionId) return res.status(400).json({ error: 'No active picker session.' });

  currentJob = { status: 'running', logs: [], stats: null, startedAt: new Date().toISOString() };
  const client = getAuthedClient(req);

  (async () => {
    try {
      const items = await getPickedMediaItems(client, sessionId);
      currentJob.logs.push(`Found ${items.length} items to download`);

      let downloaded = 0, skipped = 0, errors = 0;
      for (const item of items) {
        const filename = item.mediaFile?.filename || item.id;
        try {
          const result = await downloadMediaItem(item, client);
          if (result.skipped) skipped++; else downloaded++;
          const shortPath = result.path.replace(DOWNLOAD_DIR, 'downloads');
          const loc = result.location ? `${result.location.country}/${result.location.city}` : 'no-location';
          currentJob.logs.push(JSON.stringify({ type: 'file', item: filename, skipped: result.skipped, path: shortPath, location: loc }));
        } catch (err) {
          errors++;
          currentJob.logs.push(JSON.stringify({ type: 'error', item: filename, error: err.message }));
          console.error('[download] error on', filename, err.message);
        }
        if (currentJob.logs.length > 500) currentJob.logs.shift();
      }

      await deleteSession(client, sessionId);
      currentJob.status = 'done';
      currentJob.stats = { total: items.length, downloaded, skipped, errors };
      currentJob.finishedAt = new Date().toISOString();
    } catch (err) {
      currentJob.status = 'error';
      currentJob.error = err.message;
      currentJob.finishedAt = new Date().toISOString();
    }
  })();

  res.json({ message: 'Download started' });
});

app.get('/api/logs', requireAuth, (req, res) => {
  if (!currentJob) return res.json({ logs: [] });
  res.json({ status: currentJob.status, logs: currentJob.logs, stats: currentJob.stats, error: currentJob.error });
});

// ─── Takeout routes ─────────────────────────────────────────────────────────
// POST /api/takeout/process  body: { takeoutDir, outDir? }
app.post('/api/takeout/process', (req, res) => {
  if (takeoutJob && takeoutJob.status === 'running') {
    return res.status(409).json({ error: 'A Takeout job is already running.' });
  }
  const { takeoutDir, outDir } = req.body;
  if (!takeoutDir) return res.status(400).json({ error: 'takeoutDir is required.' });

  // Safety: must be an absolute path within the server filesystem
  const resolvedIn  = path.resolve(takeoutDir);
  const resolvedOut = path.resolve(outDir || DOWNLOAD_DIR);

  takeoutJob = { status: 'running', logs: [], stats: null, startedAt: new Date().toISOString() };
  res.json({ message: 'Takeout processing started.' });

  (async () => {
    try {
      const stats = await processTakeoutDir(resolvedIn, resolvedOut, (event) => {
        if (event.type === 'start') {
          takeoutJob.logs.push(`Found ${event.total} media files — starting…`);
        } else if (event.type === 'file') {
          const loc = event.location && event.location !== 'no-location' ? ` 📍 ${event.location}` : '';
          takeoutJob.logs.push(
            JSON.stringify({ type: 'file', filename: event.filename, skipped: event.skipped, location: event.location || 'no-location' })
          );
        } else if (event.type === 'error') {
          takeoutJob.logs.push(
            JSON.stringify({ type: 'error', filename: event.filename, error: event.error })
          );
        }
        if (takeoutJob.logs.length > 1000) takeoutJob.logs.shift();
      });
      takeoutJob.status = 'done';
      takeoutJob.stats  = stats;
      takeoutJob.finishedAt = new Date().toISOString();
    } catch (err) {
      takeoutJob.status = 'error';
      takeoutJob.error  = err.message;
      takeoutJob.finishedAt = new Date().toISOString();
      console.error('[takeout] fatal:', err.message);
    }
  })();
});

app.get('/api/takeout/logs', (req, res) => {
  if (!takeoutJob) return res.json({ logs: [] });
  res.json({
    status:  takeoutJob.status,
    logs:    takeoutJob.logs,
    stats:   takeoutJob.stats,
    error:   takeoutJob.error,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Google Photos Downloader running at http://localhost:${PORT}\n`);
});
