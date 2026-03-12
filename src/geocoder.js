'use strict';

const axios = require('axios');

// In-memory cache: "lat,lon" → { country, city }
// Rounded to 2 decimals (~1km precision) to reuse nearby results
const cache = new Map();

// Nominatim rate limit: max 1 req/sec
let lastRequestAt = 0;
async function rateLimitedGet(url, params) {
  const now = Date.now();
  const wait = 1100 - (now - lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return axios.get(url, { params, headers: { 'User-Agent': 'google-photos-downloader/1.0' }, timeout: 10000 });
}

/**
 * Read GPS coords from a local file using exifr.
 * Supports JPEG, HEIC, PNG, TIFF, WebP.
 * Returns { latitude, longitude } or null if no GPS data.
 */
async function getGPS(filePath) {
  try {
    // exifr is ESM — use dynamic import
    const exifr = await import('exifr');
    const lib = exifr.default || exifr;

    // Parse full EXIF including GPS; enableUnknown helps with HEIC/HEIF
    const parsed = await lib.parse(filePath, {
      gps: true,
      icc: false,
      iptc: false,
      xmp: false,
      tiff: true,
      heic: true,
    });

    console.log(`[geocoder] EXIF keys for ${require('path').basename(filePath)}:`, parsed ? Object.keys(parsed) : 'null');

    if (!parsed) return null;

    // exifr stores GPS as GPSLatitude/GPSLongitude arrays or as latitude/longitude
    const lat = parsed.latitude ?? parsed.GPSLatitude;
    const lon = parsed.longitude ?? parsed.GPSLongitude;

    if (lat != null && lon != null) {
      // If arrays (deg, min, sec), convert to decimal
      const toDecimal = (v) => Array.isArray(v) ? v[0] + v[1] / 60 + v[2] / 3600 : v;
      const latitude  = toDecimal(lat);
      const longitude = toDecimal(lon);
      // Apply hemisphere
      const latRef = parsed.GPSLatitudeRef  || '';
      const lonRef = parsed.GPSLongitudeRef || '';
      return {
        latitude:  latRef === 'S' ? -Math.abs(latitude)  : Math.abs(latitude),
        longitude: lonRef === 'W' ? -Math.abs(longitude) : Math.abs(longitude),
      };
    }

    console.log(`[geocoder] No GPS found in EXIF for ${require('path').basename(filePath)}`);
    return null;
  } catch (err) {
    console.error(`[geocoder] getGPS error for ${require('path').basename(filePath)}:`, err.message);
    return null;
  }
}

/**
 * Reverse geocode lat/lon → { country, city }.
 * Uses Nominatim (OpenStreetMap) — free, no API key needed.
 * city falls back to town → village → county → state.
 */
async function reverseGeocode(latitude, longitude) {
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const res = await rateLimitedGet('https://nominatim.openstreetmap.org/reverse', {
      lat: latitude,
      lon: longitude,
      format: 'json',
      zoom: 10,
      addressdetails: 1,
    });

    const addr = res.data.address || {};
    const country = addr.country || 'unknown-country';
    const city = addr.city || addr.town || addr.village || addr.suburb || addr.county || addr.state || 'unknown-city';

    const result = { country, city };
    cache.set(key, result);
    console.log(`[geocoder] (${latitude.toFixed(4)}, ${longitude.toFixed(4)}) → ${country} / ${city}`);
    return result;
  } catch (err) {
    console.warn('[geocoder] reverse geocode failed:', err.message);
    return null;
  }
}

module.exports = { getGPS, reverseGeocode };
