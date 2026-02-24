/**
 * app.js – GATE PYQ static SPA
 *
 * Architecture:
 *  - State machine: home → subject → papers → viewer
 *  - Lazy-loads metadata: index.json on start, subject_<id>.json on demand
 *  - Papers only fetched when user opens a specific PDF
 *  - Service Worker registered for user-opened file caching
 */

"use strict";

// ── Cached subject metadata ───────────────────────────────────────
const _subjectCache = new Map();

// ── App State ─────────────────────────────────────────────────────
const State = {
  view: "home", // 'home' | 'subject' | 'papers' | 'pdf'
  subjects: [], // from index.json
  activeSubject: null, // { id, name, fullName, years, paperCount, meta }
  activeYear: null, // string '2024'
  activePapers: [], // papers for active year
};

// ── DOM refs ──────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  header: $("appHeader"),
  btnBack: $("btnBack"),
  appTitle: $("appTitle"),
  headerSub: $("headerSub"),
  viewHome: $("viewHome"),
  viewSubject: $("viewSubject"),
  viewPapers: $("viewPapers"),
  viewPdf: $("viewPdf"),
  subjectGrid: $("subjectGrid"),
  subjectSearch: $("subjectSearch"),
  yearList: $("yearList"),
  paperList: $("paperList"),
  pdfTitle: $("pdfTitle"),
  pdfOpenNew: $("pdfOpenNew"),
  pdfDownload: $("pdfDownload"),
  pdfLoading: $("pdfLoading"),
  pdfFrame: $("pdfFrame"),
  installBanner: $("installBanner"),
  installBtn: $("installBtn"),
  installDismiss: $("installDismiss"),
};

// ── Router / View manager ─────────────────────────────────────────
const VIEWS = ["viewHome", "viewSubject", "viewPapers", "viewPdf"];

function showView(viewId) {
  VIEWS.forEach((v) => {
    const el = $(v);
    el.classList.toggle("active", v === viewId);
  });
  State.view = viewId;

  const isHome = viewId === "viewHome";
  els.btnBack.classList.toggle("hidden", isHome);
  window.scrollTo({ top: 0, behavior: "instant" });
}

function goBack() {
  if (State.view === "viewPdf") {
    // Stop loading the PDF
    els.pdfFrame.src = "";
    els.pdfFrame.classList.remove("loaded");
    showView("viewPapers");
    setHeader(
      `${State.activeSubject.name} – ${State.activeYear}`,
      State.activeSubject.fullName,
    );
    return;
  }
  if (State.view === "viewPapers") {
    showView("viewSubject");
    setHeader(State.activeSubject.name, State.activeSubject.fullName);
    return;
  }
  if (State.view === "viewSubject") {
    showView("viewHome");
    setHeader("GATE PYQ", null);
    return;
  }
}

function setHeader(title, sub) {
  els.appTitle.textContent = title;
  if (sub) {
    els.headerSub.textContent = sub;
    els.headerSub.classList.remove("hidden");
  } else {
    els.headerSub.classList.add("hidden");
  }
}

// ── Fetch helpers ─────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

function showFetchError(container, message, retryFn) {
  container.innerHTML = `
    <div class="error-banner">
      <span>⚠️ ${message}</span>
      <button id="retryBtn">Retry</button>
    </div>`;
  if (retryFn) {
    container.querySelector("#retryBtn").addEventListener("click", retryFn);
  }
}

// ── Utility ───────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Encode a relative path for use as a URL (handles spaces etc.) */
function encodeRelPath(relPath) {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/** Build a display label for a paper file */
function paperLabel(paper, subjectName) {
  const part = paper.part ? ` – Set ${paper.part}` : "";
  return paper.type === "key"
    ? `${subjectName} ${paper.year}${part} Answer Key`
    : `${subjectName} ${paper.year}${part} Question Paper`;
}

// ── Home: Load Subjects ───────────────────────────────────────────
async function loadHome() {
  try {
    const data = await fetchJSON("metadata/index.json");
    State.subjects = data.subjects || [];
    renderSubjectGrid(State.subjects);
  } catch (err) {
    showFetchError(
      els.subjectGrid,
      `Failed to load subjects. ${err.message}`,
      loadHome,
    );
  }
}

function renderSubjectGrid(subjects) {
  if (!subjects.length) {
    els.subjectGrid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="icon">📭</div>
        <h3>No subjects found</h3>
        <p>Please run the metadata scanner first.</p>
      </div>`;
    return;
  }

  els.subjectGrid.innerHTML = "";
  for (const s of subjects) {
    const card = document.createElement("div");
    card.className = "subject-card";
    card.innerHTML = `
      <div class="code">${escapeHtml(s.name)}</div>
      <div class="full-name">${escapeHtml(s.fullName || s.name)}</div>
      <div class="paper-count">${s.paperCount || ""} papers</div>`;
    card.addEventListener("click", () => openSubject(s));
    els.subjectGrid.appendChild(card);
  }
}

// ── Subject: Load Years ───────────────────────────────────────────
async function openSubject(subject) {
  State.activeSubject = subject;
  setHeader(subject.name, subject.fullName);
  showView("viewSubject");

  // Try cache first
  if (_subjectCache.has(subject.id)) {
    renderYearList(_subjectCache.get(subject.id));
    return;
  }

  els.yearList.innerHTML =
    '<div class="skeleton-card" style="height:64px"></div>'.repeat(4);

  try {
    const data = await fetchJSON(`metadata/${subject.meta}`);
    _subjectCache.set(subject.id, data);
    renderYearList(data);
  } catch (err) {
    showFetchError(els.yearList, `Failed to load ${subject.name} data.`, () =>
      openSubject(subject),
    );
  }
}

function renderYearList(data) {
  const subject = State.activeSubject;
  const papers = data.papers || [];

  // Group papers by year to count
  const yearMap = new Map();
  for (const p of papers) {
    if (!yearMap.has(p.year)) yearMap.set(p.year, []);
    yearMap.get(p.year).push(p);
  }

  // Sort years descending
  const years = [...yearMap.keys()].sort((a, b) => b - a);

  let html = `
    <div class="subject-header">
      <h2>${escapeHtml(subject.name)}</h2>
      <p>${escapeHtml(subject.fullName || "")} &nbsp;·&nbsp; ${papers.length} papers across ${years.length} years</p>
    </div>`;

  if (!years.length) {
    html += `<div class="empty-state">
      <div class="icon">📂</div>
      <h3>No papers found</h3>
      <p>Check that the scanner ran on the correct folder.</p>
    </div>`;
  } else {
    for (const year of years) {
      const yPapers = yearMap.get(year);
      const questionPapers = yPapers.filter((p) => p.type === "paper").length;
      const keys = yPapers.filter((p) => p.type === "key").length;
      const metaLine = [
        questionPapers
          ? `${questionPapers} QP${questionPapers > 1 ? "s" : ""}`
          : "",
        keys ? `${keys} key${keys > 1 ? "s" : ""}` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      html += `
        <div class="year-item" data-year="${escapeHtml(year)}">
          <div>
            <div class="year-label">GATE ${escapeHtml(year)}</div>
            <div class="year-meta">${escapeHtml(metaLine)}</div>
          </div>
          <svg class="year-arrow" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>`;
    }
  }

  els.yearList.innerHTML = html;

  // Event delegation
  els.yearList.querySelectorAll(".year-item").forEach((item) => {
    item.addEventListener("click", () => {
      const year = item.dataset.year;
      const yearPapers = yearMap.get(year) || [];
      openYearPapers(year, yearPapers);
    });
  });
}

// ── Papers: Show papers for a year ───────────────────────────────
function openYearPapers(year, papers) {
  State.activeYear = year;
  State.activePapers = papers;
  setHeader(
    `${State.activeSubject.name} – ${year}`,
    State.activeSubject.fullName,
  );
  showView("viewPapers");
  renderPaperList(papers);
}

function renderPaperList(papers) {
  const subject = State.activeSubject;

  if (!papers.length) {
    els.paperList.innerHTML = `
      <div class="empty-state">
        <div class="icon">📄</div>
        <h3>No files found for this year</h3>
      </div>`;
    return;
  }

  // Sort: QPs first, then keys; within each: by part asc
  const sorted = [...papers].sort((a, b) => {
    if (a.type !== b.type) return a.type === "paper" ? -1 : 1;
    return (a.part || 0) - (b.part || 0);
  });

  els.paperList.innerHTML = "";
  for (const paper of sorted) {
    const label = paperLabel(paper, subject.name);
    const item = document.createElement("div");
    item.className = "paper-item";

    const iconText = paper.type === "key" ? "KEY" : "QP";
    item.innerHTML = `
      <div class="paper-icon type-${paper.type}">${iconText}</div>
      <div class="paper-info">
        <div class="paper-name">${escapeHtml(label)}</div>
        <div class="paper-size">${formatBytes(paper.size)}</div>
      </div>
      <span class="paper-type-badge type-${paper.type}">${paper.type === "key" ? "Answer Key" : "Question Paper"}</span>`;

    item.addEventListener("click", () => openPdf(paper, label));
    els.paperList.appendChild(item);
  }
}

// ── PDF Viewer ────────────────────────────────────────────────────
function openPdf(paper, label) {
  const encodedPath = encodeRelPath(paper.rel_path);
  els.pdfTitle.textContent = label;
  els.pdfOpenNew.href = encodedPath;
  els.pdfDownload.onclick = () =>
    downloadFile(encodedPath, paper.rel_path.split("/").pop());

  els.pdfFrame.classList.remove("loaded");
  els.pdfLoading.style.display = "flex";

  setHeader(label, `${State.activeSubject.name} ${State.activeYear}`);
  showView("viewPdf");

  // onload fires for HTML pages but is unreliable for PDFs in some browsers.
  // Use a fallback timeout so the spinner always clears.
  let _loadHandled = false;
  const _showPdf = () => {
    if (_loadHandled) return;
    _loadHandled = true;
    els.pdfLoading.style.display = "none";
    els.pdfFrame.classList.add("loaded");
  };
  els.pdfFrame.onload = _showPdf;
  setTimeout(_showPdf, 2500); // fallback: reveal iframe after 2.5 s
  els.pdfFrame.src = encodedPath;
}

function downloadFile(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

// ── Search ────────────────────────────────────────────────────────
els.subjectSearch.addEventListener("input", () => {
  const q = els.subjectSearch.value.trim().toLowerCase();
  const filtered = q
    ? State.subjects.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.fullName || "").toLowerCase().includes(q),
      )
    : State.subjects;
  renderSubjectGrid(filtered);
});

// ── Back button & browser history ────────────────────────────────
els.btnBack.addEventListener("click", goBack);

window.addEventListener("popstate", () => {
  if (State.view !== "viewHome") goBack();
});

// Push a history entry whenever we navigate so the Android back button works
const _origShowView = showView;
// Patch showView to manage history
(function patchHistory() {
  const origFn = window.showView;
})();

// ── PWA Install ───────────────────────────────────────────────────
let _deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Show banner only if not dismissed before
  if (!localStorage.getItem("installDismissed")) {
    els.installBanner.classList.remove("hidden");
  }
});

els.installBtn.addEventListener("click", async () => {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  if (outcome === "accepted") {
    els.installBanner.classList.add("hidden");
  }
  _deferredInstallPrompt = null;
});

els.installDismiss.addEventListener("click", () => {
  els.installBanner.classList.add("hidden");
  localStorage.setItem("installDismissed", "1");
});

window.addEventListener("appinstalled", () => {
  els.installBanner.classList.add("hidden");
});

// ── Service Worker ────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // SW registration failure is non-fatal
    });
  });
}

// ── Security: XSS escape ──────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Init ──────────────────────────────────────────────────────────
(function init() {
  setHeader("GATE PYQ", null);
  showView("viewHome");
  loadHome();
})();
