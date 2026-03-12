# Google Photos Downloader

A simple Node.js + Express app to **download all your Google Photos**, organized by albums and date, using the Google Photos Library API.

---

## ⚠️ Important — Google API change (March 2025)

In March 2025, Google made the `photoslibrary.*` OAuth scopes **restricted** (sensitive). This means:

- **New apps** must go through Google's full OAuth verification to use them in production.
- **Personal / unverified apps** can still use the scopes in **Testing mode** — up to 100 test users.
- For downloading **your own photos**, Testing mode is all you need.

---

## Project structure

```
.
├── src/
│   ├── server.js      # Express web server (OAuth flow + download UI)
│   ├── auth.js        # Google OAuth2 helpers
│   ├── photos.js      # Google Photos Library API client
│   ├── downloader.js  # Download + folder organization logic
│   └── cli.js         # CLI runner (no browser needed after first auth)
├── public/
│   └── index.html     # Web UI
├── downloads/         # Photos are saved here (gitignored)
├── .env.example       # Copy to .env and fill in your credentials
└── package.json
```

Download folder structure:
```
downloads/
├── albums/
│   ├── Vacation 2024/
│   │   ├── IMG_001.jpg
│   │   └── ...
│   └── Family/
│       └── ...
└── by-date/
    ├── 2024/
    │   ├── 01/
    │   └── 12/
    └── 2025/
        └── ...
```

---

## Setup

### 1. Create a Google Cloud project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one).
3. Enable the **Google Photos Library API**:
   - APIs & Services → Library → search "Photos Library API" → Enable.

### 2. Create OAuth 2.0 credentials

1. APIs & Services → **Credentials** → Create Credentials → **OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URIs: `http://localhost:3000/auth/callback`
4. Download the JSON or copy **Client ID** and **Client Secret**.

### 3. Configure the OAuth consent screen (Testing mode)

1. APIs & Services → **OAuth consent screen**.
2. User Type: **External** → Create.
3. Fill in App name, support email.
4. Scopes: add `https://www.googleapis.com/auth/photoslibrary.readonly`.
5. **Test users**: add your own Google account email here.
6. Publishing status: leave as **Testing** (no verification needed for personal use).

### 4. Configure the app

```bash
cp .env.example .env
```

Edit `.env`:

```env
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any_random_string_here
PORT=3000
DOWNLOAD_DIR=./downloads
```

### 5. Install dependencies

```bash
npm install
```

---

## Usage — Web UI

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser:

1. Click **Sign in with Google** and authorize the app with your test account.
2. Your albums will be listed.
3. Choose a download mode:
   - **Everything** — albums folder + by-date folder
   - **By Album** — one folder per album
   - **By Date** — `YYYY/MM/` folder tree
4. Click **Start Download** and watch the live log.

Photos are saved to the `downloads/` folder on the server.

---

## Usage — CLI (after first login)

After signing in via the web UI once, your tokens are saved to `.tokens.json`.  
You can then use the CLI directly:

```bash
# Download everything
node src/cli.js

# Only by albums
node src/cli.js --mode albums

# Only by date
node src/cli.js --mode date
```

If `.tokens.json` doesn't exist yet, the CLI will open an authorization URL and ask you to paste the code.

---

## Notes

- `baseUrl` from the Photos API expires after ~1 hour. The downloader fetches fresh URLs as it goes, so long downloads are safe.
- Already-downloaded files are **skipped** automatically (checked by filename).
- The Google Photos API does **not** expose GPS coordinates through the Library API — location-based folders are not supported by the API itself. Albums are the primary organizational unit provided by the API.
- Videos are downloaded at full resolution using the `=dv` suffix on the `baseUrl`.
