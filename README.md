# 📷 Takeout Organizer

Organize your **Google Takeout** photos locally — no Google login, no API keys.  
Reads GPS from sidecar JSON files, reverse-geocodes to Country/City via OpenStreetMap, and moves everything into a clean folder structure.

---

## Output structure

```
downloads/
└── 2026/
    └── January/
        └── 03/
            ├── France/
            │   └── Vertaizon/
            │       └── photos/
            │           └── IMG_5563.HEIC
            └── no-location/
                └── videos/
                    └── clip.mp4
```

---

## Setup

**1. Export from Google**

Go to [takeout.google.com](https://takeout.google.com), select only **Google Photos**, download and extract the ZIP.

**2. Install & run**

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000), paste the path to your extracted Takeout folder, and click **Process Takeout**.

---

## How it works

1. Scans all media files in the Takeout folder
2. Reads the `.supplemental-metadata.json` / `.json` sidecar for GPS & date
3. Falls back to EXIF in the image if the sidecar has no GPS
4. Reverse-geocodes coordinates → Country / City (OpenStreetMap, no key needed)
5. **Moves** files into `downloads/YYYY/Month/DD/Country/City/photos|videos/`
6. Already-moved files are skipped automatically
