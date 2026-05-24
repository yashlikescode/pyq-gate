/**
 * app.js – GATE PYQ static SPA
 *
 * Architecture:
 *  - State machine: home → subject → papers → viewer
 *  - Lazy-loads metadata: index.json on start, subject_<id>.json on demand
 *  - Papers only fetched when user opens a specific PDF
 *  - Service Worker registered for user-opened file caching
 */

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.mjs";

let _currentRenderTask = null;

// ── Cached subject metadata ───────────────────────────────────────
const _subjectCache = new Map();

// ── App State ─────────────────────────────────────────────────────
const State = {
  view: "home", // 'home' | 'subject' | 'papers' | 'pdf'
  subjects: [], // from index.json
  activeSubject: null, // { id, name, fullName, years, paperCount, meta }
  activeYear: null, // string '2024'
  activePapers: [], // papers for active year
  selectedPaper: null,
  answerKeyPath: null,
  pdfMode: "paper", // 'paper' | 'key'
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
  pdfViewTabs: $("pdfViewTabs"),
  pdfLoading: $("pdfLoading"),
  pdfPages: $("pdfPages"),
  pdfContainer: $("pdfContainer"),
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
    // Cancel any in-flight PDF render
    if (_currentRenderTask) {
      _currentRenderTask.cancelled = true;
      _currentRenderTask = null;
    }
    els.pdfPages.innerHTML = "";
    els.pdfLoading.style.display = "none";
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

function getAnswerKeyPathForPaper(paper) {
  const subject = State.activeSubject;
  if (!subject) return null;

  const year = Number(paper.year);
  const part = Number(paper.part) || 1;
  const subjectId = subject.id;
  const subjectCode = subject.name.replace(/-/g, "").toUpperCase();

  if (year < 2021 || year > 2025) return null;

  if (year === 2025) {
    if (subjectId === "ce") {
      return `Answer_Keys/2025_Keys/${part === 1 ? "CE1" : "CE2"}_Keys.pdf`;
    }
    if (subjectId === "cs") {
      return `Answer_Keys/2025_Keys/${part === 1 ? "CS1" : "CS2"}_Keys.pdf`;
    }
    if (subjectId === "gg") {
      return `Answer_Keys/2025_Keys/${part === 1 ? "GG1" : "GG2"}_Keys.pdf`;
    }
    if (subjectId.startsWith("xh_")) {
      return `Answer_Keys/2025_Keys/${subjectCode}_Keys.pdf`;
    }
    return `Answer_Keys/2025_Keys/${subjectCode}_Keys.pdf`;
  }

  if (year === 2024) {
    if (subjectId === "ce") {
      return `Answer_Keys/2024_Keys/${part === 1 ? "CE1" : "CE2"}FinalAnswerKey.pdf`;
    }
    if (subjectId === "cs") {
      return `Answer_Keys/2024_Keys/${part === 1 ? "CS1" : "CS2"}FinalAnswerKey.pdf`;
    }
    if (subjectId === "gg") {
      return `Answer_Keys/2024_Keys/${part === 1 ? "GG1" : "GG2"}FinalAnswerKey.pdf`;
    }
    if (subjectId.startsWith("xh_")) {
      return `Answer_Keys/2024_Keys/${subject.name}FinalAnswerKey.pdf`;
    }
    return `Answer_Keys/2024_Keys/${subjectCode}FinalAnswerKey.pdf`;
  }

  if (year === 2023) {
    if (subjectId === "ce") {
      return `Answer_Keys/2023_Keys/${part === 1 ? "CE1" : "CE2"}_ANS_GATE2023.pdf`;
    }
    if (subjectId === "cs") {
      return "Answer_Keys/2023_Keys/CS_ANS_GATE2023.pdf";
    }
    if (subjectId === "gg") {
      return `Answer_Keys/2023_Keys/${part === 1 ? "GG_G1" : "GG_G2"}_ANS_GATE2023.pdf`;
    }
    if (subjectId.startsWith("xh_")) {
      return "Answer_Keys/2023_Keys/XH_ANS_GATE2023.pdf";
    }
    return `Answer_Keys/2023_Keys/${subjectCode}_ANS_GATE2023.pdf`;
  }

  if (year === 2022) {
    if (subjectId === "gg") {
      return "Answer_Keys/2022_Keys/gg-merged_2022.pdf";
    }
    if (subjectId === "me") {
      return "Answer_Keys/2022_Keys/me-merged_2022.pdf";
    }
    if (subjectId.startsWith("xh_")) {
      return "Answer_Keys/2022_Keys/xh_2022.pdf";
    }
    return `Answer_Keys/2022_Keys/${subjectId}_${year}.pdf`;
  }

  if (subjectId === "ce") {
    return "Answer_Keys/2021_Keys/ce_merged_2021.pdf";
  }
  if (subjectId === "cs") {
    return "Answer_Keys/2021_Keys/cs_merged_2021.pdf";
  }
  if (subjectId === "me") {
    return "Answer_Keys/2021_Keys/me_merged_2021.pdf";
  }
  if (subjectId === "xe") {
    return "Answer_Keys/2021_Keys/xe_2021_merged.pdf";
  }
  if (subjectId === "xl") {
    return "Answer_Keys/2021_Keys/xl-2021_merged.pdf";
  }
  if (subjectId.startsWith("xh_")) {
    return "Answer_Keys/2021_Keys/xh-2021_merged.pdf";
  }

  return `Answer_Keys/2021_Keys/${subjectId}_${year}.pdf`;
}

function renderPdfTabs() {
  const hasKey = Boolean(State.answerKeyPath);
  els.pdfViewTabs.classList.toggle("hidden", !hasKey);
  els.pdfViewTabs.innerHTML = "";

  if (!hasKey) {
    return;
  }

  ["paper", "key"].forEach((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pdf-tab ${State.pdfMode === mode ? "active" : ""}`;
    button.dataset.view = mode;
    button.textContent = mode === "paper" ? "Question Paper" : "Answer Key";
    button.setAttribute("aria-pressed", String(State.pdfMode === mode));
    button.addEventListener("click", () => switchPdfView(mode));
    els.pdfViewTabs.appendChild(button);
  });
}

function switchPdfView(mode) {
  if (!State.answerKeyPath && mode === "key") {
    return;
  }

  State.pdfMode = mode;
  renderPdfTabs();
  renderCurrentPdf();
}

function renderCurrentPdf() {
  if (_currentRenderTask) {
    _currentRenderTask.cancelled = true;
  }

  const task = { cancelled: false };
  _currentRenderTask = task;

  els.pdfPages.innerHTML = "";
  els.pdfLoading.style.display = "flex";
  $("pdfLoadingText").textContent =
    State.pdfMode === "key" ? "Loading answer key…" : "Loading paper…";

  const url =
    State.pdfMode === "key"
      ? encodeRelPath(State.answerKeyPath)
      : encodeRelPath(State.selectedPaper.rel_path);

  renderPdf(url, task, State.pdfMode === "key" ? "Loading answer key…" : "Loading paper…");
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
  State.selectedPaper = paper;
  State.answerKeyPath = getAnswerKeyPathForPaper(paper);
  State.pdfMode = "paper";
  els.pdfTitle.textContent = label;

  setHeader(label, `${State.activeSubject.name} ${State.activeYear}`);
  showView("viewPdf");
  els.pdfContainer.scrollTop = 0;
  renderPdfTabs();
  renderCurrentPdf();
}

async function renderPdf(url, task) {
  try {
    const loadingTask = pdfjsLib.getDocument({
      url,
      cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/cmaps/",
      cMapPacked: true,
    });
    const pdf = await loadingTask.promise;
    if (task.cancelled) return;

    const totalPages = pdf.numPages;

    // Render pages sequentially; show spinner until first page is painted
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (task.cancelled) return;
      $("pdfLoadingText").textContent =
        `Rendering page ${pageNum} / ${totalPages}\u2026`;

      const page = await pdf.getPage(pageNum);
      if (task.cancelled) return;

      // Scale so the page width exactly fills the container
      const containerWidth = els.pdfContainer.clientWidth;
      const viewport0 = page.getViewport({ scale: 1 });
      const scale = containerWidth / viewport0.width;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      // Use device pixel ratio for crisp rendering on hi-DPI screens
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      els.pdfPages.appendChild(canvas);

      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Hide spinner after first page is painted
      if (pageNum === 1) {
        els.pdfLoading.style.display = "none";
      }
    }
  } catch (err) {
    if (task.cancelled) return;
    els.pdfLoading.style.display = "none";
    els.pdfPages.innerHTML = `<div class="empty-state">
      <div class="icon">⚠️</div>
      <h3>Could not load PDF</h3>
      <p>${escapeHtml(err.message)}</p>
    </div>`;
  }
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
