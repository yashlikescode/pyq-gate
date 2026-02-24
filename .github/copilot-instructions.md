# Copilot — App Instructions

Purpose
- Quick developer instructions and UX requirements for the GATE previous-year papers web app.

Hosting & Webview
- The app will be hosted (public or internal). Add the hosted URL visibly in the app's web view / About screen so opening the app feels like a phone app.
- Make the site a PWA (manifest.json + icons + `display: standalone`) so users can "add to home screen" and the app launches like a native phone app.

Mobile-first design
- Design and implement the UI for mobile view first (narrow viewport, large touch targets, stacked layout).
- Use meta viewport: `width=device-width, initial-scale=1` and mobile-friendly font sizes and spacing.
- Prioritize a single-column listing: Subject → Year list → Paper viewer.

Data size and download policy
- Total on-disk dataset ~800 MB. Do NOT download everything to the client.
- Only fetch metadata at first (small JSON). Only download a paper (PDF/image) when the user explicitly opens it.
- Use per-subject or per-year metadata files (e.g., `metadata/subject_<id>.json`) so initial payload remains tiny.

Metadata & scanning
- Create a scanner that walks the year/subject folders and emits a small metadata payload per subject:
  - `subject_id`, `subject_name`, `years` (array), and for each paper: `year`, `type` (paper/key), `rel_path`, `size`, `mime`, `thumb_rel_path`.
- Keep metadata JSON minimal (no file contents, only paths and small attributes).
- Recommended scripts:
  - `unzip_recursive.py` — already present; use it to unpack zips.
  - `scan_metadata.py` — create this to produce `metadata/index.json` and `metadata/subject_<id>.json` files.

Frontend behavior (lazy & on-demand)
- Step 1: Fetch `metadata/index.json` (subjects list only).
- Step 2: When a subject is selected, fetch `metadata/subject_<id>.json` (years and file entries).
- Step 3: When a user taps a year/paper, fetch the actual file URL (or stream using range requests) and open it in an embedded viewer or new tab.
- Use thumbnails/previews in the list (small images) instead of full PDFs for browsing.
- Show progress indicators and fail-safe retry for slow connections.
- Create the UI with modularity in mind and ensure that it is scalable and maintainable as the dataset grows or if new features are added in the future.

Serving files (server requirements)
- Serve static files with correct `Content-Type` and enable `Accept-Ranges`/`206 Partial Content` for PDF streaming.
- Set reasonable cache headers for metadata (short TTL) and papers (longer TTL). Use `Cache-Control` and `ETag`.
- If you need auth or access control, add a small server layer that serves files on-demand; otherwise static hosting/CDN is fine.

Performance & caching
- Use a Service Worker to cache only user-opened files (user-driven caching). Implement an LRU or size-limited cache (so cached files don't exceed a budget on the device).
- Pre-generate lightweight thumbnails (PNG/JPEG) next to each paper to use in lists.

PWA / App-like feel
- Add `manifest.json` with icons and `display: standalone` so it can be saved to home screen.
- Add `theme-color` and a minimal splash screen for better mobile feel.
- In the web view UI, show the hosted app link (URL) and an "Open in browser / Install" hint so users understand it's hosted.

Developer quick steps
1. Unzip your root archive using `unzip_recursive.py`.
2. Run `scan_metadata.py` (to be created) which writes `metadata/index.json` and `metadata/subject_<id>.json` files.
3. Implement frontend (mobile-first) to fetch `metadata/index.json` and lazy-load subject JSON files.
4. Serve the `static/` folder with a simple server (or host via CDN).

Commands (example)
```powershell
# Unzip
python unzip_recursive.py "<root-zip>.zip"

# Serve locally for testing (from project root)
python -m http.server 8000
# Then open http://localhost:8000 in mobile browser or emulator
```

Notes / reminders
- Always avoid bundling full papers in the initial build. Keep metadata small and fetch content on demand.
- Thumbnails and per-subject JSON are the key to snappy UI despite ~800 MB total data.

If you want, I can now:
- Create a `scan_metadata.py` scanner that emits per-subject JSON, or
- Scaffold a minimal mobile-first static frontend that demonstrates the lazy-loading behavior.


---
File created to guide development and UX decisions for the app.