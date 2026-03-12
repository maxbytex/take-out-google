'use strict';

const axios = require('axios');

const BASE_URL = 'https://photospicker.googleapis.com/v1';

async function getHeaders(oAuth2Client) {
  const { token } = await oAuth2Client.getAccessToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function createSession(oAuth2Client) {
  const headers = await getHeaders(oAuth2Client);
  const res = await axios.post(`${BASE_URL}/sessions`, {}, { headers });
  console.log('[picker] session created:', res.data.id);
  return res.data;
}

async function pollSession(oAuth2Client, sessionId, pollIntervalSeconds = 3, timeoutSeconds = 600) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const headers = await getHeaders(oAuth2Client);
    const res = await axios.get(`${BASE_URL}/sessions/${sessionId}`, { headers });
    console.log('[picker] poll — mediaItemsSet:', res.data.mediaItemsSet);
    if (res.data.mediaItemsSet) return res.data;
    await new Promise(r => setTimeout(r, pollIntervalSeconds * 1000));
  }
  throw new Error('Picker session timed out.');
}

async function getPickedMediaItems(oAuth2Client, sessionId) {
  const items = [];
  let pageToken = null;
  do {
    const headers = await getHeaders(oAuth2Client);
    const params = { sessionId, pageSize: 100 };
    if (pageToken) params.pageToken = pageToken;
    console.log('[picker] GET /mediaItems, so far:', items.length);
    let res;
    try {
      res = await axios.get(`${BASE_URL}/mediaItems`, { headers, params });
    } catch (err) {
      const detail = err.response
        ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`
        : err.message;
      console.error('[picker] /mediaItems error:', detail);
      throw new Error(detail);
    }
    if (res.data.mediaItems) items.push(...res.data.mediaItems);
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return items;
}

async function deleteSession(oAuth2Client, sessionId) {
  const headers = await getHeaders(oAuth2Client);
  await axios.delete(`${BASE_URL}/sessions/${sessionId}`, { headers }).catch(() => {});
}

module.exports = { createSession, pollSession, getPickedMediaItems, deleteSession };
