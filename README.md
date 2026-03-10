# Leus — Document Scanner

**A free, open-source, local-first web app that replaces Microsoft Lens.**  
All processing happens entirely in your browser — no cloud, no account, no data leaves your device.

---

## ✨ Features

| Feature | Details |
|---|---|
| 📷 **Camera Scan** | Use your device camera (rear camera preferred) to scan documents |
| 🔍 **Auto Edge Detection** | OpenCV.js detects document edges in real-time |
| ✂️ **Manual Crop** | Drag corner handles to fine-tune the crop area |
| 🔄 **Perspective Correction** | Automatically straightens skewed/angled documents |
| 🎨 **Image Filters** | Document (B&W), Whiteboard, Photo, Business Card, Original |
| 🔤 **OCR** | Extract text using Tesseract.js (supports English + Chinese Simplified/Traditional) |
| 📄 **Multi-page PDF** | Export any document as a multi-page PDF |
| 🖼️ **Image Export** | Export pages as JPEG or PNG |
| 💾 **Local Storage** | All documents saved in IndexedDB — persistent, offline, no cloud |
| 📥 **File Import** | Import existing images from your device |
| 📱 **PWA** | Install as a native-like app on mobile and desktop |
| 🌙 **Offline** | Works without an internet connection after first load |

---

## 🚀 Getting Started

### Run locally

```bash
# Install dev dependency (optional serve tool)
npm install

# Start dev server at http://localhost:3000
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

> **Note:** Camera access requires HTTPS or `localhost`. If you deploy to a server, ensure you use HTTPS.

### Deploy

Leus is a static web app. Deploy the entire repository to any static hosting:

- **GitHub Pages** — push to a `gh-pages` branch
- **Netlify / Vercel** — drag & drop or connect the repo
- **Any web server** — just `serve .`

---

## 🛠️ Architecture

```
/
├── index.html          Single-page app shell
├── manifest.json       PWA manifest
├── sw.js               Service worker (offline cache)
├── src/
│   ├── css/
│   │   └── main.css    All styles (dark theme, mobile-first)
│   └── js/
│       ├── app.js      Main app controller & routing
│       ├── camera.js   WebRTC camera + live detection overlay
│       ├── scanner.js  OpenCV.js edge detection + JS homography warp
│       ├── filters.js  Canvas-based image filters (no dependencies)
│       ├── ocr.js      Tesseract.js OCR wrapper
│       ├── export.js   jsPDF PDF + image download
│       └── storage.js  IndexedDB local document store
```

### Third-party libraries (CDN, loaded lazily)

| Library | Purpose | Size |
|---|---|---|
| [OpenCV.js 4.8](https://opencv.org/) | Document edge detection, perspective warp | ~9 MB (cached) |
| [Tesseract.js 5](https://tesseract.projectnaptha.com/) | On-device OCR | ~12 MB worker + models |
| [jsPDF 2.5](https://parall.ax/products/jspdf) | PDF generation | ~250 KB |

All libraries run **client-side only** — no data is sent to any server.

---

## 📱 Usage

1. **Scan** — Open the app → point camera at a document → tap the white button
2. **Adjust** — Drag the green corner handles to fit the document edges, then tap **Crop & Continue**
3. **Filter** — Choose a filter (Document for B&W text, Whiteboard for boards, etc.)
4. **OCR** — Tap **Text** to extract text from the scan
5. **Save** — Tap **Save** to store in your browser's local storage
6. **Export** — Tap **Export** → choose PDF, JPEG, or PNG

---

## 🔒 Privacy

- **Zero telemetry** — no analytics, no tracking
- **No account** — nothing to sign up for
- **Local only** — documents are stored in your browser's IndexedDB
- **Open source** — MIT licensed, audit the code yourself
