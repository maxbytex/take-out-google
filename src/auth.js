'use strict';

const { google } = require('googleapis');
require('dotenv').config();

const SCOPES = [
  // Google Photos Picker API — no verification required, user selects photos via Google UI
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(oAuth2Client) {
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh_token on every login
  });
}

async function getTokens(oAuth2Client, code) {
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

function setCredentials(oAuth2Client, tokens) {
  oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

module.exports = { createOAuth2Client, getAuthUrl, getTokens, setCredentials };
