'use strict';

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sanitize = require('sanitize-filename');
const { listAllAlbums, listMediaInAlbum, listMediaItems } = require('./photos');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';

/**
 * Download a single file from a Google Photos baseUrl.
 * Appends =d to the URL to force full-resolution download.
 * For videos, appends =dv instead.
 */
async function downloadFile(mediaItem, destPath) {
  await fs.ensureDir(path.dirname(destPath));

  // Skip if already downloaded
  if (await fs.pathExists(destPath)) return { skipped: true, path: destPath };

  const isVideo = mediaItem.mimeType && mediaItem.mimeType.startsWith('video/');
  const downloadUrl = mediaItem.baseUrl + (isVideo ? '=dv' : '=d');

  const response = await axios.get(downloadUrl, { responseType: 'stream', timeout: 60000 });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return { skipped: false, path: destPath };
}

/**
 * Build a safe filename from a media item.
 * Uses the item's filename if available, otherwise fallback to id.
 */
function buildFilename(mediaItem) {
  const name = mediaItem.filename || `${mediaItem.id}.jpg`;
  return sanitize(name) || `${mediaItem.id}.jpg`;
}

/**
 * Download all photos organized by ALBUM.
 * Structure: downloads/albums/<album-title>/<filename>
 */
async function downloadByAlbums(oAuth2Client, onProgress) {
  const albums = await listAllAlbums(oAuth2Client);
  const stats = { total: 0, downloaded: 0, skipped: 0, errors: 0 };

  for (const album of albums) {
    const albumName = sanitize(album.title || album.id);
    const albumDir = path.join(DOWNLOAD_DIR, 'albums', albumName);
    onProgress && onProgress({ type: 'album-start', album: album.title, totalInAlbum: parseInt(album.mediaItemsCount || 0) });

    const items = await listMediaInAlbum(oAuth2Client, album.id);
    for (const item of items) {
      stats.total++;
      const destPath = path.join(albumDir, buildFilename(item));
      try {
        const result = await downloadFile(item, destPath);
        result.skipped ? stats.skipped++ : stats.downloaded++;
        onProgress && onProgress({ type: 'file', item: item.filename, skipped: result.skipped });
      } catch (err) {
        stats.errors++;
        onProgress && onProgress({ type: 'error', item: item.filename, error: err.message });
      }
    }
  }

  return stats;
}

/**
 * Download all photos organized by DATE (YYYY/MM).
 * Structure: downloads/by-date/YYYY/MM/<filename>
 */
async function downloadByDate(oAuth2Client, onProgress) {
  const items = await listMediaItems(oAuth2Client);
  const stats = { total: items.length, downloaded: 0, skipped: 0, errors: 0 };

  for (const item of items) {
    const creationTime = item.mediaMetadata && item.mediaMetadata.creationTime;
    let year = 'unknown', month = 'unknown';
    if (creationTime) {
      const d = new Date(creationTime);
      year  = String(d.getUTCFullYear());
      month = String(d.getUTCMonth() + 1).padStart(2, '0');
    }

    const destPath = path.join(DOWNLOAD_DIR, 'by-date', year, month, buildFilename(item));
    try {
      const result = await downloadFile(item, destPath);
      result.skipped ? stats.skipped++ : stats.downloaded++;
      onProgress && onProgress({ type: 'file', item: item.filename, skipped: result.skipped, year, month });
    } catch (err) {
      stats.errors++;
      onProgress && onProgress({ type: 'error', item: item.filename, error: err.message });
    }
  }

  return stats;
}

/**
 * Download everything: by albums AND by date (deduped by filename).
 */
async function downloadAll(oAuth2Client, onProgress) {
  onProgress && onProgress({ type: 'phase', message: 'Downloading by albums...' });
  const albumStats = await downloadByAlbums(oAuth2Client, onProgress);

  onProgress && onProgress({ type: 'phase', message: 'Downloading remaining photos by date...' });
  const dateStats  = await downloadByDate(oAuth2Client, onProgress);

  return {
    albums: albumStats,
    byDate: dateStats,
    totalDownloaded: albumStats.downloaded + dateStats.downloaded,
    totalSkipped:    albumStats.skipped    + dateStats.skipped,
    totalErrors:     albumStats.errors     + dateStats.errors,
  };
}

module.exports = { downloadByAlbums, downloadByDate, downloadAll };
