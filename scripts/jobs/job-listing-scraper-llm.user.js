// ==UserScript==
// @name         Job listing scraper (LLM)
// @namespace    local
// @version      1.0.9
// @description  Summarise LinkedIn and SEEK job listings with a local Ollama model.
// @match        https://www.linkedin.com/jobs/view/*
// @match        https://www.linkedin.com/jobs/search/*
// @match        https://www.linkedin.com/jobs/search-results/*
// @match        https://au.linkedin.com/jobs/view/*
// @match        https://au.linkedin.com/jobs/search/*
// @match        https://au.linkedin.com/jobs/search-results/*
// @match        https://au.seek.com/job/*
// @match        https://au.seek.com/jobs*
// @match        https://au.seek.com/*-jobs/*
// @match        https://www.seek.com.au/job/*
// @match        https://www.seek.com.au/jobs*
// @match        https://www.seek.com.au/*-jobs/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    // HIGHLIGHTING
    workGood: 0,
    workBad: 3,

    // Tech names are matched against these regexes.
    goodTech: [
      /JavaScript|TypeScript/i,
      /React/i,
      /Node(?:\.js)?/i,
      /Next(?:\.js)?/i,
    ],
    badTech: [
      /\.NET/i,
      /\bJava\b/i,
      /(^|[^\w])C#($|[^\w])/i,
      /(^|[^\w])C\+\+($|[^\w])/i,
    ],

    // LLM CRITERIA
    // ['<criteria>', '<optional category for grouping>']
    good: [
      ['pay > 165k or $110+/hour', 'pay'],
      ['fully remote', 'work-arrangement'],
    ],
    bad: [
      ['pay < 160k or $100/hour', 'pay'],
      ['hybrid >= 3 days in office', 'work-arrangement'],
      ['on-site role', 'work-arrangement'],
      '.NET, Java, C#, C++ required',
      ['hybrid but not based in Sydney/NSW', 'work-arrangement'],
    ],

    // COLORS
    statusColors: {
      good: '#86efac',
      bad: '#fca5a5',
      uncertain: '#93c5fd',
    },
    confidenceColor: '#666b71',
    confidenceColors: {
      low: '#4b5563',
      medium: '#666b71',
      high: '#8a9098',
    },
    matchColors: {
      good: '#a8e5c4',
      bad: '#f4bcbc',
    },

    // ICONS
    statusIcons: {
      good: '✓',
      bad: '✕',
      uncertain: '?',
    },
    confidenceSymbols: {
      low: '▂',
      medium: '▅',
      high: '█',
    },

    // MODEL
    model: 'qwen2.5:7b',
    ollamaUrl: 'http://localhost:11434',
    timeout: 15000,
    numPredict: 1024,

    // LLM QUEUE
    queueMaxConcurrent: 2,
    queueLeaseMs: 30000,
    queueWaitFailOpenMs: 60000,
    queueStaleMs: 300000,
    queuePollMs: 300,
  };

  const PANEL_ID = 'job-scraper-llm-panel';
  const JSON_WINDOW_ID = 'job-scraper-llm-json-window';
  const DEBUG_WINDOW_ID = 'job-scraper-llm-debug-window';
  const PANEL_POSITION_KEY = 'jobScraperLlmPanelPosition';
  const PANEL_COLLAPSED_KEY = 'jobScraperLlmPanelCollapsed';
  const OLLAMA_QUEUE_KEY = 'jobScraperLlmOllamaQueue';
  const TAB_ID = makeId('tab');
  const VALID_WORK_TYPES = new Set(['remote', 'hybrid', 'onsite', 'unknown']);
  const VALID_PAY_TYPES = new Set(['annual', 'daily', 'hourly', 'unknown']);
  const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
  const VALID_FIT_CONFIDENCE = new Set([
    'high',
    'medium',
    'low',
    'inconclusive',
  ]);
  const VALID_ASSESSMENT = new Set(['good', 'bad', 'uncertain']);
  const RESULT_SCHEMA = buildResultSchema();

  const state = {
    site: detectSite(),
    panel: null,
    jsonWindow: null,
    jsonContent: null,
    debugWindow: null,
    debugContent: null,
    content: null,
    titleElement: null,
    currentResult: null,
    currentRawJson: '',
    currentOllamaDebug: null,
    currentJobText: '',
    currentPayEvidence: null,
    currentError: null,
    jobTitle: '',
    assessmentStatus: 'uncertain',
    assessment: null,
    lastSignature: '',
    runId: 0,
    collapsed: Boolean(GM_getValue(PANEL_COLLAPSED_KEY, false)),
    watchPaused: false,
  };
  let pendingRun = 0;
  let pendingRunFromWatcher = false;

  if (!state.site) return;

  try {
    addStyles();
    startWhenBodyReady();
  } catch (error) {
    console.error('[Job Scraper LLM]', error);
  }

  function startWhenBodyReady() {
    if (!document.body) {
      window.setTimeout(startWhenBodyReady, 50);
      return;
    }

    ensurePanel();
    scheduleRun(500);
    installUrlWatcher();
  }

  function detectSite() {
    const host = location.hostname.toLowerCase();

    if (host === 'au.seek.com' || host === 'www.seek.com.au') return 'seek';
    if (host === 'www.linkedin.com' || host === 'au.linkedin.com') {
      return 'linkedin';
    }

    return null;
  }

  function addStyles() {
    GM_addStyle(`
      #${PANEL_ID},
      #${JSON_WINDOW_ID},
      #${DEBUG_WINDOW_ID} {
        position: fixed;
        z-index: 2147483647;
        background: rgba(17, 24, 39, 0.94);
        color: #f9fafb;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.38);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow: hidden;
        backdrop-filter: blur(10px);
      }

      #${PANEL_ID} {
        top: 88px;
        right: 24px;
        width: min(380px, calc(100vw - 24px));
        max-height: calc(100vh - 120px);
      }

      #${JSON_WINDOW_ID},
      #${DEBUG_WINDOW_ID} {
        width: min(620px, calc(100vw - 24px));
        height: min(520px, calc(100vh - 24px));
        min-width: 320px;
        min-height: 180px;
        overflow: hidden;
        resize: both;
      }

      #${PANEL_ID}, #${PANEL_ID} *,
      #${JSON_WINDOW_ID}, #${JSON_WINDOW_ID} *,
      #${DEBUG_WINDOW_ID}, #${DEBUG_WINDOW_ID} * {
        box-sizing: border-box;
      }

      #${PANEL_ID}.job-scraper-llm--collapsed {
        max-height: 42px;
      }

      #${PANEL_ID}.job-scraper-llm--menu-open {
        overflow: visible;
      }

      #${PANEL_ID} .job-scraper-llm__header,
      #${JSON_WINDOW_ID} .job-scraper-llm__header,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__header {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 42px;
        padding: 8px 10px 8px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        cursor: move;
        user-select: none;
      }

      #${PANEL_ID}.job-scraper-llm--collapsed .job-scraper-llm__header {
        border-bottom: 0;
      }

      #${PANEL_ID} .job-scraper-llm__title,
      #${JSON_WINDOW_ID} .job-scraper-llm__title,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__title {
        flex: 1 1 auto;
        min-width: 0;
        color: #ffffff;
        font-weight: 700;
        letter-spacing: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${PANEL_ID} .job-scraper-llm__controls,
      #${JSON_WINDOW_ID} .job-scraper-llm__controls,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__controls {
        display: flex;
        flex: 0 0 auto;
        gap: 4px;
        position: relative;
        z-index: 3;
      }

      #${PANEL_ID} .job-scraper-llm__menu-wrap {
        position: relative;
        display: flex;
      }

      #${PANEL_ID} .job-scraper-llm__button,
      #${JSON_WINDOW_ID} .job-scraper-llm__button,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__button {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        color: #f9fafb;
        min-width: 32px;
        height: 26px;
        padding: 0 8px;
        font: inherit;
        font-size: 12px;
        line-height: 24px;
        cursor: pointer;
      }

      #${PANEL_ID} .job-scraper-llm__button:hover,
      #${JSON_WINDOW_ID} .job-scraper-llm__button:hover,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__button:hover {
        background: rgba(255, 255, 255, 0.16);
      }

      #${PANEL_ID} .job-scraper-llm__button--watch-paused {
        background: rgba(147, 197, 253, 0.12);
        border-color: rgba(147, 197, 253, 0.38);
        color: #dbeafe;
      }

      #${PANEL_ID} .job-scraper-llm__button--watch-paused:hover {
        background: rgba(147, 197, 253, 0.18);
      }

      #${PANEL_ID} .job-scraper-llm__button:disabled,
      #${JSON_WINDOW_ID} .job-scraper-llm__button:disabled,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__button:disabled {
        cursor: default;
        opacity: 0.48;
      }

      #${PANEL_ID} .job-scraper-llm__menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 154px;
        padding: 4px;
        background: rgba(17, 24, 39, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 6px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.34);
        z-index: 4;
      }

      #${PANEL_ID} .job-scraper-llm__menu[hidden] {
        display: none;
      }

      #${PANEL_ID} .job-scraper-llm__menu-item {
        appearance: none;
        display: block;
        width: 100%;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: #f9fafb;
        padding: 6px 8px;
        font: inherit;
        font-size: 12px;
        line-height: 1.2;
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
      }

      #${PANEL_ID} .job-scraper-llm__menu-item:hover,
      #${PANEL_ID} .job-scraper-llm__menu-item:focus {
        background: rgba(255, 255, 255, 0.14);
        outline: none;
      }

      #${JSON_WINDOW_ID} .job-scraper-llm__json-body,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__json-body {
        height: calc(100% - 42px);
        overflow: auto;
        padding: 12px;
      }

      #${JSON_WINDOW_ID} .job-scraper-llm__json-view,
      #${DEBUG_WINDOW_ID} .job-scraper-llm__json-view {
        margin: 0;
        padding: 8px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 6px;
        color: #e5e7eb;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }

      #${PANEL_ID} .job-scraper-llm__body {
        max-height: calc(100vh - 164px);
        overflow: auto;
        padding: 12px;
      }

      #${PANEL_ID}.job-scraper-llm--collapsed .job-scraper-llm__body {
        display: none;
      }

      #${PANEL_ID} .job-scraper-llm__divider {
        height: 1px;
        margin: 10px 0;
        background: rgba(255, 255, 255, 0.16);
      }

      #${PANEL_ID} .job-scraper-llm__line {
        margin: 4px 0;
        overflow-wrap: anywhere;
      }

      #${PANEL_ID} .job-scraper-llm__label {
        color: #bfdbfe;
        font-weight: 700;
      }

      #${PANEL_ID} .job-scraper-llm__muted {
        color: #cbd5e1;
      }

      #${PANEL_ID} .job-scraper-llm__status-icon {
        display: inline-block;
        padding-right: 8px;
      }

      #${PANEL_ID} .job-scraper-llm__confidence {
        display: inline-block;
        margin-left: 5px;
        position: relative;
        top: -0.08em;
        font-size: 0.6em;
        font-weight: 700;
        line-height: 1;
        vertical-align: baseline;
      }

      #${PANEL_ID} .job-scraper-llm__tech-line {
        position: relative;
        max-height: calc(1.45em * 2);
        overflow: hidden;
      }

      #${PANEL_ID} .job-scraper-llm__tech-line--overflow {
        cursor: pointer;
        padding-right: 34px;
      }

      #${PANEL_ID} .job-scraper-llm__tech-line--overflow:not(.job-scraper-llm__tech-line--expanded)::after {
        content: "...";
        position: absolute;
        right: 0;
        bottom: 0;
        width: 28px;
        color: #f9fafb;
        text-align: right;
      }

      #${PANEL_ID} .job-scraper-llm__tech-line--expanded {
        max-height: none;
        padding-right: 0;
      }

      #${PANEL_ID} .job-scraper-llm__fit-list {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 6px 18px;
        margin: 4px 0;
      }

      #${PANEL_ID} .job-scraper-llm__fit-item {
        display: inline-flex;
        align-items: baseline;
        min-width: 0;
        max-width: 100%;
      }

      #${PANEL_ID} .job-scraper-llm__fit-symbol {
        display: inline-block;
        padding-right: 6px;
        flex: 0 0 auto;
        font-weight: 700;
      }

      #${PANEL_ID} .job-scraper-llm__fit-text {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      #${PANEL_ID} .job-scraper-llm__error {
        color: #fecaca;
        font-weight: 700;
      }

      #${PANEL_ID} .job-scraper-llm__debug {
        margin-top: 10px;
        color: #d1d5db;
      }

      #${PANEL_ID} .job-scraper-llm__debug summary {
        cursor: pointer;
      }

      #${PANEL_ID} .job-scraper-llm__debug pre {
        margin: 8px 0 0;
        padding: 8px;
        max-height: 180px;
        overflow: auto;
        white-space: pre-wrap;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 6px;
        color: #e5e7eb;
      }

      #${PANEL_ID} .job-scraper-llm__loading {
        display: flex;
        align-items: center;
        gap: 9px;
        color: #dbeafe;
      }

      #${PANEL_ID} .job-scraper-llm__spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid rgba(147, 197, 253, 0.35);
        border-top-color: #93c5fd;
        animation: job-scraper-llm-spin 0.8s linear infinite;
      }

      @keyframes job-scraper-llm-spin {
        to { transform: rotate(360deg); }
      }
    `);
  }

  function ensurePanel() {
    if (state.panel && document.body.contains(state.panel)) return state.panel;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = `
      <div class="job-scraper-llm__header">
        <div class="job-scraper-llm__title">Job Scraper</div>
        <div class="job-scraper-llm__controls">
          <div class="job-scraper-llm__menu-wrap">
            <button class="job-scraper-llm__button" type="button" data-action="menu" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">⋮</button>
            <div class="job-scraper-llm__menu" role="menu" hidden>
              <button class="job-scraper-llm__menu-item" type="button" role="menuitem" data-menu-action="copy-results">⎘ Copy results</button>
              <button class="job-scraper-llm__menu-item" type="button" role="menuitem" data-menu-action="copy-url">⎘ Copy URL</button>
              <button class="job-scraper-llm__menu-item" type="button" role="menuitem" data-menu-action="view-json">◎ View JSON</button>
              <button class="job-scraper-llm__menu-item" type="button" role="menuitem" data-menu-action="view-debug">⚠ View Debug</button>
            </div>
          </div>
          <button class="job-scraper-llm__button" type="button" data-action="watch-toggle" title="Stop watching job changes" aria-label="Stop watching job changes" aria-pressed="false">▪</button>
          <button class="job-scraper-llm__button" type="button" data-action="retry" title="Retry analysis" aria-label="Retry analysis">⟳</button>
        </div>
      </div>
      <div class="job-scraper-llm__body"></div>
    `;

    state.panel = panel;
    state.titleElement = panel.querySelector('.job-scraper-llm__title');
    state.content = panel.querySelector('.job-scraper-llm__body');
    applySavedPanelPosition(panel);
    applyCollapsedState();
    applyWatchPausedState();
    renderPanelTitle();
    installPanelEvents(panel);
    document.body.appendChild(panel);
    renderLoading('Analysing...');

    return panel;
  }

  function applySavedPanelPosition(panel) {
    const saved = safeParseJson(GM_getValue(PANEL_POSITION_KEY, ''));
    if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) {
      return;
    }

    const left = clamp(saved.left, 8, window.innerWidth - 80);
    const top = clamp(saved.top, 8, window.innerHeight - 42);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
  }

  function installPanelEvents(panel) {
    const header = panel.querySelector('.job-scraper-llm__header');
    const menuButton = panel.querySelector('[data-action="menu"]');
    const menu = panel.querySelector('.job-scraper-llm__menu');
    const watchButton = panel.querySelector('[data-action="watch-toggle"]');
    const retryButton = panel.querySelector('[data-action="retry"]');
    let dragStart = null;

    header.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;

      const rect = panel.getBoundingClientRect();
      dragStart = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };

      event.preventDefault();
    });

    window.addEventListener('mousemove', (event) => {
      if (!dragStart) return;

      const dx = event.clientX - dragStart.pointerX;
      const dy = event.clientY - dragStart.pointerY;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragStart.moved = true;

      const rect = panel.getBoundingClientRect();
      const left = clamp(
        dragStart.left + dx,
        8,
        window.innerWidth - rect.width - 8,
      );
      const top = clamp(dragStart.top + dy, 8, window.innerHeight - 42);

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (!dragStart) return;

      if (!dragStart.moved) {
        toggleCollapsed();
      } else {
        persistPanelPosition();
      }

      dragStart = null;
    });

    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleActionMenu();
    });

    watchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeActionMenu();
      toggleWatchPaused();
    });

    menu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-menu-action]');
      if (!item || !menu.contains(item)) return;

      event.stopPropagation();
      closeActionMenu();
      runMenuAction(item.dataset.menuAction);
    });

    retryButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeActionMenu();
      scheduleRun(0, { force: true });
    });

    panel.addEventListener('click', (event) => {
      const techLine = event.target.closest(
        '.job-scraper-llm__tech-line--overflow',
      );
      if (!techLine || !panel.contains(techLine)) return;

      toggleTechLine(techLine);
    });

    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;

      const techLine = event.target.closest(
        '.job-scraper-llm__tech-line--overflow',
      );
      if (!techLine || !panel.contains(techLine)) return;

      event.preventDefault();
      toggleTechLine(techLine);
    });

    window.addEventListener('resize', () => {
      closeActionMenu();
      updateTitleTooltip();
      updateTechClampState();
    });

    document.addEventListener('click', (event) => {
      if (!panel.contains(event.target)) closeActionMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeActionMenu();
    });
  }

  function toggleActionMenu() {
    const menu = state.panel?.querySelector('.job-scraper-llm__menu');
    const button = state.panel?.querySelector('[data-action="menu"]');
    if (!menu || !button) return;

    const shouldOpen = menu.hidden;
    menu.hidden = !shouldOpen;
    state.panel.classList.toggle('job-scraper-llm--menu-open', shouldOpen);
    button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  function closeActionMenu() {
    const menu = state.panel?.querySelector('.job-scraper-llm__menu');
    const button = state.panel?.querySelector('[data-action="menu"]');
    if (!menu || !button) return;

    menu.hidden = true;
    state.panel.classList.remove('job-scraper-llm--menu-open');
    button.setAttribute('aria-expanded', 'false');
  }

  function runMenuAction(action) {
    if (action === 'copy-results') {
      copySummary();
      return;
    }

    if (action === 'copy-url') {
      copyUrl();
      return;
    }

    if (action === 'view-json') {
      openJsonWindow();
      return;
    }

    if (action === 'view-debug') {
      openDebugWindow();
    }
  }

  function toggleCollapsed() {
    state.collapsed = !state.collapsed;
    GM_setValue(PANEL_COLLAPSED_KEY, state.collapsed);
    applyCollapsedState();
  }

  function applyCollapsedState() {
    if (!state.panel) return;

    state.panel.classList.toggle('job-scraper-llm--collapsed', state.collapsed);
    if (!state.collapsed) window.requestAnimationFrame(updateTechClampState);
  }

  function toggleWatchPaused() {
    state.watchPaused = !state.watchPaused;
    if (state.watchPaused) cancelPendingWatcherRun();
    applyWatchPausedState();
  }

  function cancelPendingWatcherRun() {
    if (!pendingRun || !pendingRunFromWatcher) return;

    window.clearTimeout(pendingRun);
    pendingRun = 0;
    pendingRunFromWatcher = false;
  }

  function applyWatchPausedState() {
    const button = state.panel?.querySelector('[data-action="watch-toggle"]');
    if (!button) return;

    const paused = Boolean(state.watchPaused);
    const label = paused
      ? 'Resume watching job changes'
      : 'Stop watching job changes';

    button.textContent = paused ? '▶' : '▪';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', paused ? 'true' : 'false');
    button.classList.toggle('job-scraper-llm__button--watch-paused', paused);
  }

  function renderPanelTitle() {
    if (!state.titleElement) return;

    const title = cleanJobTitle(state.jobTitle);
    if (!title) {
      state.titleElement.textContent = 'Job Scraper';
      state.titleElement.removeAttribute('title');
      delete state.titleElement.dataset.fullTitle;
      state.titleElement.style.color = '';
      return;
    }

    const status = enumValue(
      state.assessmentStatus,
      VALID_ASSESSMENT,
      'uncertain',
    );
    const icon =
      CONFIG.statusIcons?.[status] || CONFIG.statusIcons?.uncertain || '';
    state.titleElement.innerHTML = `${icon ? `<span class="job-scraper-llm__status-icon">${escapeHtml(icon)}</span>` : ''}${escapeHtml(title)}`;
    state.titleElement.removeAttribute('title');
    state.titleElement.dataset.fullTitle = title;
    state.titleElement.style.color = statusColor(status);
    window.requestAnimationFrame(updateTitleTooltip);
  }

  function persistPanelPosition() {
    if (!state.panel) return;

    const rect = state.panel.getBoundingClientRect();
    GM_setValue(
      PANEL_POSITION_KEY,
      JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      }),
    );
  }

  function copySummary() {
    const text = state.currentResult
      ? formatCopyText(state.currentResult)
      : state.currentJobText || state.currentError?.message || '';

    if (!text) return;
    GM_setClipboard(text, 'text');
  }

  function copyUrl() {
    GM_setClipboard(location.href, 'text');
  }

  function openJsonWindow() {
    const win = ensureJsonWindow();
    updateJsonWindowContent();
    win.hidden = false;
  }

  function openDebugWindow() {
    const win = ensureDebugWindow();
    updateDebugWindowContent();
    win.hidden = false;
  }

  function ensureJsonWindow() {
    if (state.jsonWindow && document.body.contains(state.jsonWindow)) {
      return state.jsonWindow;
    }

    const win = createTextWindow({
      id: JSON_WINDOW_ID,
      label: 'Raw LLM JSON output',
      title: 'Raw JSON',
      copyAction: 'copy-json',
      closeAction: 'close-json',
    });

    state.jsonWindow = win;
    state.jsonContent = win.querySelector('.job-scraper-llm__json-view');
    positionTextWindow(win);
    installTextWindowEvents(win, {
      copyAction: 'copy-json',
      closeAction: 'close-json',
      copy: copyJson,
      close: closeJsonWindow,
    });
    document.body.appendChild(win);

    return win;
  }

  function ensureDebugWindow() {
    if (state.debugWindow && document.body.contains(state.debugWindow)) {
      return state.debugWindow;
    }

    const win = createTextWindow({
      id: DEBUG_WINDOW_ID,
      label: 'LLM debug output',
      title: 'Debug',
      copyAction: 'copy-debug',
      closeAction: 'close-debug',
    });

    state.debugWindow = win;
    state.debugContent = win.querySelector('.job-scraper-llm__json-view');
    positionTextWindow(win);
    installTextWindowEvents(win, {
      copyAction: 'copy-debug',
      closeAction: 'close-debug',
      copy: copyDebug,
      close: closeDebugWindow,
    });
    document.body.appendChild(win);

    return win;
  }

  function createTextWindow({ id, label, title, copyAction, closeAction }) {
    const win = document.createElement('section');
    win.id = id;
    win.setAttribute('aria-label', label);
    win.innerHTML = `
      <div class="job-scraper-llm__header">
        <div class="job-scraper-llm__title">${escapeHtml(title)}</div>
        <div class="job-scraper-llm__controls">
          <button class="job-scraper-llm__button" type="button" data-action="${escapeHtml(copyAction)}" title="Copy ${escapeHtml(title)}" aria-label="Copy ${escapeHtml(title)}">⎘</button>
          <button class="job-scraper-llm__button" type="button" data-action="${escapeHtml(closeAction)}" title="Close ${escapeHtml(title)}" aria-label="Close ${escapeHtml(title)}">×</button>
        </div>
      </div>
      <div class="job-scraper-llm__json-body">
        <pre class="job-scraper-llm__json-view"></pre>
      </div>
    `;

    return win;
  }

  function positionTextWindow(win) {
    const panelRect = state.panel?.getBoundingClientRect();
    const width = Math.min(620, window.innerWidth - 24);
    const height = Math.min(520, window.innerHeight - 24);
    const preferredLeft = panelRect ? panelRect.left - width - 12 : 24;
    const preferredTop = panelRect ? panelRect.top : 88;

    win.style.width = `${width}px`;
    win.style.height = `${height}px`;
    win.style.left = `${clamp(preferredLeft, 8, window.innerWidth - width - 8)}px`;
    win.style.top = `${clamp(preferredTop, 8, window.innerHeight - 80)}px`;
    win.style.right = 'auto';
  }

  function installTextWindowEvents(win, { copyAction, closeAction, copy, close }) {
    const header = win.querySelector('.job-scraper-llm__header');
    const copyButton = win.querySelector(`[data-action="${copyAction}"]`);
    const closeButton = win.querySelector(`[data-action="${closeAction}"]`);
    let dragStart = null;

    header.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;

      const rect = win.getBoundingClientRect();
      dragStart = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        left: rect.left,
        top: rect.top,
      };

      event.preventDefault();
    });

    window.addEventListener('mousemove', (event) => {
      if (!dragStart) return;

      const rect = win.getBoundingClientRect();
      const left = clamp(
        dragStart.left + event.clientX - dragStart.pointerX,
        8,
        window.innerWidth - rect.width - 8,
      );
      const top = clamp(
        dragStart.top + event.clientY - dragStart.pointerY,
        8,
        window.innerHeight - 42,
      );

      win.style.left = `${left}px`;
      win.style.top = `${top}px`;
      win.style.right = 'auto';
    });

    window.addEventListener('mouseup', () => {
      dragStart = null;
    });

    copyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      copy();
    });

    copyButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });

    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      close();
    });

    closeButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
  }

  function copyJson() {
    const text = state.jsonContent?.textContent || jsonWindowText();
    if (!text) return;

    GM_setClipboard(text, 'text');
  }

  function copyDebug() {
    const text = state.debugContent?.textContent || debugWindowText();
    if (!text) return;

    GM_setClipboard(text, 'text');
  }

  function closeJsonWindow() {
    if (!state.jsonWindow) return;

    state.jsonWindow.remove();
    state.jsonWindow = null;
    state.jsonContent = null;
  }

  function closeDebugWindow() {
    if (!state.debugWindow) return;

    state.debugWindow.remove();
    state.debugWindow = null;
    state.debugContent = null;
  }

  function updateJsonWindowContent() {
    if (!state.jsonContent) return;

    state.jsonContent.textContent = jsonWindowText();
  }

  function updateDebugWindowContent() {
    if (!state.debugContent) return;

    state.debugContent.textContent = debugWindowText();
  }

  function jsonWindowText() {
    return (
      state.currentRawJson ||
      (state.currentResult
        ? JSON.stringify(state.currentResult, null, 2)
        : '') ||
      'No JSON output available yet.'
    );
  }

  function debugWindowText() {
    return state.currentOllamaDebug
      ? JSON.stringify(state.currentOllamaDebug, null, 2)
      : 'No debug output available yet.';
  }

  function scheduleRun(delayMs, options = {}) {
    if (options.fromWatcher && state.watchPaused) return;

    window.clearTimeout(pendingRun);
    pendingRunFromWatcher = Boolean(options.fromWatcher);
    pendingRun = window.setTimeout(() => {
      pendingRun = 0;
      pendingRunFromWatcher = false;
      if (options.fromWatcher && state.watchPaused) return;

      runExtraction(options).catch((error) => {
        renderError(toUserError(error));
      });
    }, delayMs);
  }

  async function runExtraction({ force = false } = {}) {
    const runId = ++state.runId;
    ensurePanel();
    if (force) resetJobState();
    renderLoading('Scraping...');

    try {
      await delay(350);
      await ensureJobDetailsPaneOpen();

      if (state.site === 'linkedin') {
        renderLoading('Expanding description...');
        await ensureLinkedInDescriptionExpanded();
        renderLoading('Scraping...');
      }

      const extraction = await waitForExtraction();
      if (!extraction || !extraction.text) {
        throw userError('not_found', 'Could not find job description');
      }

      if (runId !== state.runId) return;

      const signature = `${location.href}\n${extraction.text.slice(0, 1500)}`;
      state.currentJobText = extraction.text;
      state.currentPayEvidence = extraction.payEvidence || null;
      state.jobTitle = extraction.title || '';
      renderPanelTitle();

      if (!force && signature === state.lastSignature && state.currentResult) {
        applyResultState(state.currentResult);
        renderSuccess(state.currentResult);
        return;
      }

      state.lastSignature = signature;
      renderLoading('Analysing...');
      const { result, rawJson, debug } = await queryLLM(
        extraction.text,
        (message) => {
          if (runId === state.runId) renderLoading(message);
        },
      );
      if (runId !== state.runId) return;

      state.currentResult = result;
      state.currentRawJson = rawJson;
      state.currentOllamaDebug = debug;
      state.currentError = null;
      updateJsonWindowContent();
      updateDebugWindowContent();
      applyResultState(result);
      renderSuccess(result);
    } catch (error) {
      if (runId !== state.runId) return;

      const friendly = toUserError(error);
      state.currentResult = null;
      state.currentRawJson = '';
      state.currentOllamaDebug = error.debug || null;
      state.currentError = friendly;
      updateJsonWindowContent();
      updateDebugWindowContent();
      state.currentPayEvidence = null;
      state.assessmentStatus = 'uncertain';
      state.assessment = null;
      renderPanelTitle();
      renderError(friendly);
    }
  }

  async function waitForExtraction() {
    const deadline = Date.now() + 9000;
    let lastExtraction = null;

    while (Date.now() < deadline) {
      lastExtraction =
        state.site === 'linkedin' ? extractLinkedIn() : extractSeek();
      if (
        lastExtraction &&
        lastExtraction.text &&
        lastExtraction.bodyText.length >= 80
      ) {
        return lastExtraction;
      }

      await delay(250);
    }

    return lastExtraction;
  }

  function extractLinkedIn() {
    const aboutTheJob = getLinkedInDescriptionRoot();
    const body = getLinkedInDescriptionBody(aboutTheJob);

    const bodyText = getLinkedInDescriptionText(aboutTheJob, body);
    if (!bodyText) return null;

    const metadata = [];
    const detailsRoot = getLinkedInDetailsRoot(aboutTheJob);
    const headerRoot = getLinkedInHeaderRoot(detailsRoot);
    const headerText = cleanMetadataText(getText(headerRoot));
    const beforeDescription = textBeforeNeedle(headerText, 'About the job');
    const headerContext = beforeDescription || headerText;
    const workplace = extractWorkplaceType(headerContext);
    const location = extractLinkedInLocation(headerContext);
    const payPills = extractLinkedInPayPills(headerRoot);
    const paySources = normalizeList([
      ...payPills,
      extractSalaryLine(headerContext),
      ...extractSalarySnippets(bodyText),
    ]);
    const salary = paySources.slice(0, 3).join(' | ');
    const payEvidence = buildPayEvidence(paySources, 'LinkedIn');
    const details = extractLinkedInDetails(headerContext);
    const title = extractLinkedInTitle(headerRoot);
    const htmlContext = buildLinkedInHtmlContext({
      detailsRoot,
      headerRoot,
      aboutTheJob,
      body,
      paySources,
    });

    addMetadata(metadata, 'Job Title', title);
    addMetadata(metadata, 'Workplace Type', workplace);
    addMetadata(metadata, 'LinkedIn Pay Pill', payPills.join(' | '));
    addMetadata(metadata, 'Salary Insight', salary);
    addMetadata(metadata, 'Pay Type', payEvidence?.type);
    addMetadata(metadata, 'Location', location);
    addMetadata(metadata, 'Job Details', details);

    return {
      bodyText,
      title,
      payEvidence,
      text: composeJobText(metadata, bodyText, htmlContext),
    };
  }

  function extractSeek() {
    const body = firstElement([
      '[data-automation="jobAdDetails"]',
      '[data-testid="jobAdDetails"]',
      '[data-automation="job-ad-details"]',
    ]);
    const bodyText = cleanDescriptionText(getText(body));
    if (!bodyText) return null;

    const locationText = cleanMetadataText(
      getText('[data-automation="job-detail-location"]'),
    );
    const workType = cleanMetadataText(
      getText('[data-automation="job-detail-work-type"]'),
    );
    const salary = cleanMetadataText(
      getText('[data-automation="job-detail-salary"]'),
    );
    const paySources = normalizeList([
      salary,
      ...extractSalarySnippets(bodyText),
    ]);
    const payEvidence = buildPayEvidence(paySources, 'SEEK');
    const title = extractSeekTitle();
    const metadata = [];
    const htmlContext = buildSeekHtmlContext(body);

    addMetadata(metadata, 'Job Title', title);
    addMetadata(metadata, 'Workplace Type', extractWorkplaceType(locationText));
    addMetadata(metadata, 'Salary Badge', paySources.slice(0, 3).join(' | '));
    addMetadata(metadata, 'Pay Type', payEvidence?.type);
    addMetadata(metadata, 'Work Type', workType);
    addMetadata(metadata, 'Location', stripWorkplaceSuffix(locationText));

    return {
      bodyText,
      title,
      payEvidence,
      text: composeJobText(metadata, bodyText, htmlContext),
    };
  }

  async function ensureJobDetailsPaneOpen() {
    if (hasExtractableDescription()) return;
    if (!isJobListPage()) return;

    const control = findJobRowControl();
    if (!control) return;

    safeClick(control);

    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (hasExtractableDescription()) return;
      await delay(250);
    }
  }

  function hasExtractableDescription() {
    if (state.site === 'linkedin') {
      const root = getLinkedInDescriptionRoot();
      return (
        getLinkedInDescriptionText(root, getLinkedInDescriptionBody(root))
          .length >= 80
      );
    }

    const body = firstElement([
      '[data-automation="jobAdDetails"]',
      '[data-testid="jobAdDetails"]',
      '[data-automation="job-ad-details"]',
    ]);

    return cleanDescriptionText(getText(body)).length >= 80;
  }

  function findJobRowControl() {
    const selectors =
      state.site === 'linkedin'
        ? [
            '.jobs-search-results-list a.job-card-list__title[href*="/jobs/view/"]',
            '.jobs-search-results-list .job-card-container a[href*="/jobs/view/"]',
            'li.jobs-search-results__list-item a[href*="/jobs/view/"]',
            '.job-card-container a[href*="/jobs/view/"]',
            'a[href*="/jobs/view/"]',
          ]
        : [
            '[data-testid="job-card"] [data-automation="jobTitle"] a',
            '[data-testid="job-card"] [data-testid="job-card-title"] a',
            '[data-testid="job-card"] [data-automation="job-list-view-job-link"]',
            '[data-testid="job-card"] [data-automation="job-list-item-link-overlay"]',
            '[data-testid="job-list-item-link-overlay"]',
            '[data-automation="job-list-item-link-overlay"]',
            'a[href*="/job/"]',
          ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && isVisibleElement(element)) return element;
    }

    return null;
  }

  function isVisibleElement(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isJobListPage() {
    const path = location.pathname;

    if (state.site === 'linkedin') {
      return (
        /^\/jobs\/search/.test(path) || /^\/jobs\/search-results/.test(path)
      );
    }

    return (
      !/^\/job\//.test(path) && (/\/jobs/.test(path) || /-jobs\/?$/.test(path))
    );
  }

  async function ensureLinkedInDescriptionExpanded() {
    const deadline = Date.now() + 6000;
    let attempts = 0;
    let preClickLength = 0;

    while (Date.now() < deadline) {
      const root = getLinkedInDescriptionRoot();
      const body = getLinkedInDescriptionBody(root);
      const bodyText = getLinkedInDescriptionText(root, body);
      const moreControl = findLinkedInDescriptionMoreControl(root);

      if (moreControl && attempts < 3) {
        preClickLength = Math.max(preClickLength, bodyText.length);
        attempts += 1;
        clickExpandableControl(moreControl);
        await delay(450);
        continue;
      }

      const expanded =
        !moreControl ||
        (attempts > 0 &&
          (bodyText.length >= preClickLength + 80 || bodyText.length >= 1500));
      const gaveUpWithContent = attempts >= 3 && bodyText.length >= 80;
      if (bodyText.length >= 80 && (expanded || gaveUpWithContent)) {
        return;
      }

      await delay(250);
    }
  }

  function getLinkedInDescriptionRoot() {
    return (
      document.querySelector(
        '[data-sdui-component="com.linkedin.sdui.generated.jobseeker.dsl.impl.aboutTheJob"]',
      ) ||
      firstElement([
        '.jobs-description__content',
        '.jobs-description-content__text',
        '#job-details',
      ])
    );
  }

  function getLinkedInDescriptionBody(root) {
    return (
      root?.querySelector('[data-testid="expandable-text-box"]') ||
      firstElementFrom(root || document, [
        '.jobs-box__html-content',
        '.show-more-less-html__markup',
        '.jobs-description-content__text',
        '.description__text',
        '#job-details',
      ])
    );
  }

  function getLinkedInDescriptionText(
    root,
    body = getLinkedInDescriptionBody(root),
  ) {
    return (
      cleanDescriptionText(getText(body)) || cleanDescriptionText(getText(root))
    );
  }

  function getLinkedInDetailsRoot(aboutTheJob) {
    const closestSelectors = [
      '[data-sdui-screen*="SemanticJobDetails"]',
      '.jobs-search__job-details--container',
      '.jobs-search__job-details',
      '.jobs-details',
      '.jobs-details__main-content',
      '.scaffold-layout__detail',
      '[role="main"]',
    ];

    for (const selector of closestSelectors) {
      const element = aboutTheJob?.closest(selector);
      if (element) return element;
    }

    return (
      firstElement([
        '[data-sdui-screen*="SemanticJobDetails"]',
        '.jobs-search__job-details--container',
        '.jobs-search__job-details',
        '.jobs-details',
        '.jobs-details__main-content',
        '.scaffold-layout__detail',
      ]) || document.body
    );
  }

  function getLinkedInHeaderRoot(detailsRoot) {
    const headerSelectors = [
      '.job-details-jobs-unified-top-card',
      '.jobs-unified-top-card',
      '.jobs-details-top-card',
    ];

    return (
      firstElementFrom(detailsRoot, headerSelectors) ||
      firstElement(headerSelectors) ||
      detailsRoot ||
      firstElement(['main']) ||
      document.body
    );
  }

  function findLinkedInDescriptionMoreControl(root) {
    if (!root) return null;

    const controls = root.querySelectorAll(
      '[data-testid="expandable-text-button"], button, [role="button"], a',
    );

    for (const control of controls) {
      const label = cleanMetadataText(
        control.innerText ||
          control.textContent ||
          control.getAttribute('aria-label') ||
          '',
      );
      if (isMoreDescriptionLabel(label)) return control;
    }

    return null;
  }

  function isMoreDescriptionLabel(label) {
    const text = cleanMetadataText(label);
    if (!text || /jobs like this|more jobs/i.test(text)) return false;
    return (
      /^(show|see|read)\s+more\b/i.test(text) ||
      /(^|\s)(…|\.\.\.)?\s*more$/i.test(text)
    );
  }

  function clickExpandableControl(control) {
    const clickable =
      control.querySelector('[style*="pointer-events: auto"]') || control;
    safeClick(clickable);
    if (clickable !== control) safeClick(control);
  }

  function installUrlWatcher() {
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      if (location.href === lastUrl) return;

      lastUrl = location.href;
      if (state.watchPaused) return;

      resetJobState();
      scheduleRun(state.site === 'linkedin' ? 800 : 500, {
        force: true,
        fromWatcher: true,
      });
    });

    const start = () => {
      if (!document.body) {
        window.setTimeout(start, 100);
        return;
      }

      observer.observe(document.body, { childList: true, subtree: true });
    };

    start();
  }

  async function queryLLM(jdText, onStatus = () => {}) {
    const ollama = await requestOllamaQueued(jdText, onStatus);
    const raw = ollama.response;

    try {
      const parsed = parseJsonResponse(raw);
      return {
        result: validateResult(parsed),
        rawJson: raw,
        debug: ollama.debug,
      };
    } catch (error) {
      error.debug = ollama.debug;
      throw error;
    }
  }

  async function requestOllamaQueued(jdText, onStatus = () => {}) {
    let release = null;
    const queueStartedAt = Date.now();
    let queueFinishedAt = queueStartedAt;

    try {
      release = await acquireOllamaQueueSlot(onStatus);
      queueFinishedAt = Date.now();
    } catch (error) {
      queueFinishedAt = Date.now();
      console.warn(
        '[Job Scraper LLM] Queue unavailable; running directly',
        error,
      );
      onStatus('Analysing...');
      try {
        const response = await requestOllama(jdText);
        response.debug.queue = queueDebug('direct_after_queue_error', {
          startedAt: queueStartedAt,
          finishedAt: queueFinishedAt,
          error,
        });
        return response;
      } catch (requestError) {
        attachQueueDebug(requestError, 'direct_after_queue_error', {
          startedAt: queueStartedAt,
          finishedAt: queueFinishedAt,
          error,
        });
        throw requestError;
      }
    }

    try {
      onStatus('Analysing...');
      const response = await requestOllama(jdText);
      response.debug.queue = queueDebug('queued', {
        startedAt: queueStartedAt,
        finishedAt: queueFinishedAt,
      });
      return response;
    } catch (error) {
      attachQueueDebug(error, 'queued', {
        startedAt: queueStartedAt,
        finishedAt: queueFinishedAt,
      });
      throw error;
    } finally {
      releaseOllamaQueueSlot(release);
    }
  }

  function attachQueueDebug(error, mode, options) {
    if (!error.debug) return;
    error.debug.queue = queueDebug(mode, options);
  }

  function queueDebug(mode, { startedAt, finishedAt = Date.now(), error = null }) {
    return {
      mode,
      waitMs: finishedAt - startedAt,
      error: error?.message || '',
    };
  }

  function acquireOllamaQueueSlot(onStatus = () => {}) {
    return new Promise((resolve, reject) => {
      const id = makeId('run');
      const startedAt = Date.now();
      let timer = 0;
      let listenerId = null;
      let settled = false;

      const cleanup = () => {
        if (timer) window.clearTimeout(timer);
        if (
          listenerId !== null &&
          typeof GM_removeValueChangeListener === 'function'
        ) {
          try {
            GM_removeValueChangeListener(listenerId);
          } catch {}
        }
      };

      const failOpen = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        releaseOllamaQueueSlot(id);
        reject(error);
      };

      const tick = () => {
        if (settled) return;

        try {
          const result = tryAcquireOllamaQueueSlot(id);
          if (result.acquired) {
            settled = true;
            cleanup();
            resolve(id);
            return;
          }

          onStatus(formatQueueStatus(result.ahead));

          if (Date.now() - startedAt > queueWaitFailOpenMs()) {
            failOpen(new Error('Queue wait timeout'));
            return;
          }

          timer = window.setTimeout(tick, queuePollMs());
        } catch (error) {
          failOpen(error);
        }
      };

      if (typeof GM_addValueChangeListener === 'function') {
        try {
          listenerId = GM_addValueChangeListener(OLLAMA_QUEUE_KEY, () => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(tick, 0);
          });
        } catch {}
      }

      tick();
    });
  }

  function tryAcquireOllamaQueueSlot(id) {
    const now = Date.now();
    const maxConcurrent = queueMaxConcurrent();
    const leaseMs = queueLeaseMs();
    const staleMs = queueStaleMs();
    const queue = readOllamaQueue()
      .filter((entry) => isValidQueueEntry(entry))
      .filter((entry) => {
        if (entry.running) return Number(entry.leaseUntil) > now;
        return now - Number(entry.createdAt) <= staleMs;
      });

    if (!queue.some((entry) => entry.id === id)) {
      queue.push({
        id,
        tabId: TAB_ID,
        url: location.href,
        createdAt: now,
        leaseUntil: 0,
        running: false,
      });
    }

    queue.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

    let activeRunning = 0;
    for (const entry of queue) {
      if (!entry.running) continue;

      activeRunning += 1;
      if (activeRunning > maxConcurrent) {
        entry.running = false;
        entry.leaseUntil = 0;
      }
    }

    let runningCount = queue.filter((entry) => entry.running).length;
    for (const entry of queue) {
      if (entry.running) continue;
      if (runningCount >= maxConcurrent) break;

      entry.running = true;
      entry.leaseUntil = now + leaseMs;
      runningCount += 1;
    }

    writeOllamaQueue(queue);

    const freshQueue = readOllamaQueue().filter((entry) =>
      isValidQueueEntry(entry),
    );
    freshQueue.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    const active = freshQueue
      .filter((entry) => entry.running && Number(entry.leaseUntil) > now)
      .slice(0, maxConcurrent);
    const index = freshQueue.findIndex((entry) => entry.id === id);

    return {
      acquired: active.some((entry) => entry.id === id),
      ahead: index > 0 ? index : 0,
    };
  }

  function releaseOllamaQueueSlot(id) {
    if (!id) return;

    try {
      writeOllamaQueue(readOllamaQueue().filter((entry) => entry.id !== id));
    } catch (error) {
      console.warn('[Job Scraper LLM] Queue release failed', error);
    }
  }

  function readOllamaQueue() {
    const queue = safeParseJson(GM_getValue(OLLAMA_QUEUE_KEY, '[]'));
    return Array.isArray(queue) ? queue : [];
  }

  function writeOllamaQueue(queue) {
    GM_setValue(OLLAMA_QUEUE_KEY, JSON.stringify(queue.slice(0, 50)));
  }

  function isValidQueueEntry(entry) {
    return Boolean(
      entry &&
      typeof entry.id === 'string' &&
      Number.isFinite(Number(entry.createdAt)),
    );
  }

  function queueMaxConcurrent() {
    const value = Number(CONFIG.queueMaxConcurrent);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 2;
  }

  function queueLeaseMs() {
    const value = Number(CONFIG.queueLeaseMs);
    const fallback = Math.max(Number(CONFIG.timeout) + 15000, 30000);
    return Number.isFinite(value) && value >= 5000 ? value : fallback;
  }

  function queueWaitFailOpenMs() {
    const value = Number(CONFIG.queueWaitFailOpenMs);
    return Number.isFinite(value) && value >= 5000 ? value : 60000;
  }

  function queueStaleMs() {
    const value = Number(CONFIG.queueStaleMs);
    return Number.isFinite(value) && value >= 30000 ? value : 300000;
  }

  function queuePollMs() {
    const value = Number(CONFIG.queuePollMs);
    return Number.isFinite(value) && value >= 100 ? value : 300;
  }

  function formatQueueStatus(ahead) {
    const count = Number.isFinite(Number(ahead)) ? Number(ahead) : 0;
    if (count <= 0) return 'Queued...';
    return `Queued (${count} ahead)...`;
  }

  function requestOllama(jdText) {
    return new Promise((resolve, reject) => {
      const prompt = buildPrompt(jdText, RESULT_SCHEMA);
      const payload = {
        model: CONFIG.model,
        prompt,
        format: RESULT_SCHEMA,
        stream: false,
        keep_alive: CONFIG.keepAlive,
        options: {
          temperature: 0,
          num_predict: CONFIG.numPredict,
        },
      };
      const startedAt = Date.now();

      GM_xmlhttpRequest({
        method: 'POST',
        url: `${CONFIG.ollamaUrl.replace(/\/+$/, '')}/api/generate`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        timeout: CONFIG.timeout,
        onload: (res) => {
          try {
            if (res.status < 200 || res.status >= 300) {
              const error = userError(
                'offline',
                `Ollama returned HTTP ${res.status}`,
                res.responseText,
              );
              error.debug = buildOllamaDebug({
                data: null,
                httpResponse: res,
                payload,
                prompt,
                jdText,
                startedAt,
              });
              reject(error);
              return;
            }

            const data = JSON.parse(res.responseText);
            const response =
              typeof data.response === 'string'
                ? data.response
                : JSON.stringify(data.response);
            resolve({
              response,
              debug: buildOllamaDebug({
                data,
                httpResponse: res,
                payload,
                prompt,
                jdText,
                startedAt,
              }),
            });
          } catch (error) {
            const parseError = userError(
              'parse',
              'Could not parse Ollama response',
              res.responseText,
              error,
            );
            parseError.debug = buildOllamaDebug({
              data: null,
              httpResponse: res,
              payload,
              prompt,
              jdText,
              startedAt,
            });
            reject(parseError);
          }
        },
        onerror: () => {
          const error = userError('offline', 'LLM offline - is Ollama running?');
          error.debug = buildOllamaDebug({
            data: null,
            httpResponse: null,
            payload,
            prompt,
            jdText,
            startedAt,
          });
          reject(error);
        },
        ontimeout: () => {
          const error = userError('offline', 'LLM timeout');
          error.debug = buildOllamaDebug({
            data: null,
            httpResponse: null,
            payload,
            prompt,
            jdText,
            startedAt,
          });
          reject(error);
        },
      });
    });
  }

  function buildOllamaDebug({
    data,
    httpResponse,
    payload,
    prompt,
    jdText,
    startedAt,
  }) {
    const now = Date.now();
    const promptEvalMs = nsToMs(data?.prompt_eval_duration);
    const evalMs = nsToMs(data?.eval_duration);

    return {
      capturedAt: new Date(now).toISOString(),
      page: {
        url: location.href,
        site: state.site,
        title: state.jobTitle || null,
      },
      request: {
        endpoint: `${CONFIG.ollamaUrl.replace(/\/+$/, '')}/api/generate`,
        model: payload.model,
        stream: payload.stream,
        keepAlive: payload.keep_alive,
        format: 'json_schema',
        options: payload.options,
        timeoutMs: CONFIG.timeout,
        promptChars: prompt.length,
        jobTextChars: String(jdText || '').length,
        schemaChars: JSON.stringify(payload.format).length,
      },
      http: {
        status: httpResponse?.status ?? null,
        statusText: httpResponse?.statusText || '',
        wallMs: now - startedAt,
        responseChars: String(httpResponse?.responseText || '').length,
      },
      ollama: {
        done: data?.done ?? null,
        doneReason: data?.done_reason || '',
        totalMs: nsToMs(data?.total_duration),
        loadMs: nsToMs(data?.load_duration),
        promptEvalMs,
        evalMs,
        promptEvalCount: numberOrNull(data?.prompt_eval_count),
        evalCount: numberOrNull(data?.eval_count),
        promptTokensPerSecond: tokensPerSecond(
          data?.prompt_eval_count,
          promptEvalMs,
        ),
        outputTokensPerSecond: tokensPerSecond(data?.eval_count, evalMs),
        contextLength: Array.isArray(data?.context) ? data.context.length : 0,
      },
    };
  }

  function nsToMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(number / 10000) / 100;
  }

  function tokensPerSecond(count, durationMs) {
    const tokens = Number(count);
    if (!Number.isFinite(tokens) || !Number.isFinite(durationMs)) return null;
    if (durationMs <= 0) return null;
    return Math.round((tokens / durationMs) * 100000) / 100;
  }

  function buildResultSchema() {
    const fitChecks = {
      bad: fitCheckListSchema(fitCriterionTexts(CONFIG.bad)),
      good: fitCheckListSchema(fitCriterionTexts(CONFIG.good)),
    };

    return strictObjectSchema({
      jobTitle: nullableSchema('string'),
      workArrangement: strictObjectSchema({
        type: enumStringSchema(VALID_WORK_TYPES),
        daysInOffice: nullableSchema('number'),
        daysInOfficeMin: nullableSchema('number'),
        daysInOfficeMax: nullableSchema('number'),
        details: { type: 'string' },
        confidence: enumStringSchema(VALID_CONFIDENCE),
      }),
      pay: strictObjectSchema({
        range: nullableSchema('string'),
        type: enumStringSchema(VALID_PAY_TYPES),
        includesSuper: { type: 'boolean' },
        isOTE: { type: 'boolean' },
        confidence: enumStringSchema(VALID_CONFIDENCE),
      }),
      techStack: strictObjectSchema({
        required: stringListSchema(),
        optional: stringListSchema(),
      }),
      fitChecks: strictObjectSchema(fitChecks),
    });
  }

  function strictObjectSchema(properties) {
    return {
      type: 'object',
      additionalProperties: false,
      properties,
      required: Object.keys(properties),
    };
  }

  function nullableSchema(type) {
    return { type: [type, 'null'] };
  }

  function enumStringSchema(values) {
    return { type: 'string', enum: Array.from(values) };
  }

  function stringListSchema() {
    return {
      type: 'array',
      items: { type: 'string' },
    };
  }

  function fitCheckListSchema(criteria) {
    return {
      type: 'array',
      minItems: criteria.length,
      maxItems: criteria.length,
      items: strictObjectSchema({
        criterion: criteria.length
          ? { type: 'string', enum: criteria }
          : { type: 'string' },
        matches: { type: 'boolean' },
        confidence: enumStringSchema(VALID_FIT_CONFIDENCE),
        details: { type: 'string', maxLength: 120 },
      }),
    };
  }

  function buildPrompt(jdText, schema = RESULT_SCHEMA) {
    const badCriteria = JSON.stringify(fitCriterionTexts(CONFIG.bad));
    const goodCriteria = JSON.stringify(fitCriterionTexts(CONFIG.good));
    const schemaText = JSON.stringify(schema);

    return `You are a job listing data extractor. Analyse the following job description and return one JSON object that validates against this JSON Schema:

${schemaText}

Bad criteria to evaluate one item at a time, in order:
${badCriteria}

Good criteria to evaluate one item at a time, in order:
${goodCriteria}

Rules:
- For jobTitle: use [Job Title] metadata if present. Otherwise infer only if the title is explicit in the text. If unclear, use null
- For fitChecks.bad: return exactly one object per bad criterion, same order, with criterion copied exactly
- For fitChecks.good: return exactly one object per good criterion, same order, with criterion copied exactly
- Keep fit check details concise. Use "" when matches is false and there is no important ambiguity or conflict
- Fit check default is matches false with confidence "inconclusive". Use "low" only when some direct evidence supports matches true
- matches true means the criterion statement is factually true for the listing, not merely relevant or evaluated
- A fit check may be matches true only with confidence "low", "medium", or "high"; use "high" only for direct unambiguous evidence
- For thresholds, determine the actual value first; contradictory thresholds cannot both be true
- Do not mark mutually exclusive fit criteria true. If evidence conflicts, set both false with confidence "inconclusive"
- If a fit criterion is absent, irrelevant, contradicted, or too unclear, set matches false with confidence "inconclusive"
- Evaluate each fit criterion independently from the raw listing. Do not infer one criterion from another
- "required": tech explicitly required of the candidate: requirements, must-have, essential, mandatory, "you have", "what you'll bring", "strong/proven experience", "expertise in", or "X+ years"
- "optional": tech under nice-to-have, preferred, desirable, bonus, advantage, familiarity, exposure, or tools/platforms merely mentioned without clear requirement
- If a heading or sentence says nice-to-have, preferred, desirable, bonus, advantage, familiarity, or exposure, every tech in that scope is optional even if it appears important
- Do not classify tech from responsibilities, product descriptions, company stack, or generic "we use" sections as required unless the candidate requirement wording is explicit
- If the same tech appears as both required and optional, include it only in required
- Order tech arrays from strongest and most prominent evidence to weakest: core role tech, title/summary tech, repeated tech, and explicit must-have tech first. Do not sort alphabetically
- For workArrangement: if the listing mentions a single specific day count, set daysInOffice, daysInOfficeMin, and daysInOfficeMax to that number
- For workArrangement: if the listing mentions a range such as "2-3 days in office", set daysInOffice and daysInOfficeMin to the lower number, daysInOfficeMax to the upper number, and mention the range in details
- For workArrangement: if the listing says "hybrid" but does not explicitly state the number of office days, set daysInOffice, daysInOfficeMin, and daysInOfficeMax to null. Do not assume hybrid means 2-3 days
- For workArrangement fit checks: never match day-count criteria from a generic "hybrid" label alone. Day-count criteria need explicit office-day evidence in the listing
- For workArrangement fit checks: compare hybrid day-count thresholds using daysInOfficeMin, the lower number of a range. For example, "2-3 days in office" counts as 2 for "hybrid >= 3 days in office", so that criterion is false unless other evidence supports 3+ required days
- For workArrangement: if conflicting signals exist, set confidence to "low" and note the conflict in details
- Input has metadata, compact source HTML, and plain text. Cross-check them; prefer explicit metadata/source HTML over inference
- For pay: preserve frequency; never convert hourly/daily to annual. Compare fit thresholds only with the same frequency
- If a field cannot be determined, set it to null/unknown with confidence "low"
- Only include programming languages, frameworks, libraries, tools, platforms, and infrastructure in techStack. Do not include soft skills or methodologies
- Return ONLY the JSON object, no other text

Job description:
---
${jdText}
---`;
  }

  function parseJsonResponse(raw) {
    if (raw && typeof raw === 'object') return raw;

    try {
      return JSON.parse(raw);
    } catch (firstError) {
      const trimmed = String(raw || '').trim();
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');

      if (start >= 0 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {}
      }

      throw userError('parse', 'Parse error', raw, firstError);
    }
  }

  function validateResult(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw userError(
        'shape',
        'Model returned a non-object JSON value',
        JSON.stringify(input),
      );
    }

    const work = input.workArrangement || {};
    const pay = input.pay || {};
    const tech = input.techStack || {};
    const workArrangement = normalizeWorkArrangement(
      work,
      state.currentJobText,
    );
    let fitChecks = {
      bad: normalizeFitChecks(input.fitChecks?.bad, CONFIG.bad),
      good: normalizeFitChecks(input.fitChecks?.good, CONFIG.good),
    };
    fitChecks = applyPayEvidenceToFitChecks(
      fitChecks,
      state.currentPayEvidence,
    );
    fitChecks = applyWorkArrangementToFitChecks(fitChecks, workArrangement);
    fitChecks = resolveFitCheckConflicts(fitChecks);
    const result = {
      jobTitle: cleanJobTitle(input.jobTitle),
      workArrangement,
      pay: {
        range: stringOrNull(pay.range),
        type: enumValue(pay.type, VALID_PAY_TYPES, 'unknown'),
        includesSuper: booleanValue(pay.includesSuper),
        isOTE: booleanValue(pay.isOTE),
        confidence: enumValue(pay.confidence, VALID_CONFIDENCE, 'low'),
      },
      techStack: {
        required: normalizeList(tech.required),
        optional: normalizeList(
          []
            .concat(Array.isArray(tech.optional) ? tech.optional : [])
            .concat(Array.isArray(tech.preferred) ? tech.preferred : [])
            .concat(Array.isArray(tech.mentioned) ? tech.mentioned : []),
        ),
      },
      fitChecks,
      assessment: null,
    };

    applyPayEvidenceToResult(result, state.currentPayEvidence);
    result.assessment = buildAssessment(result.fitChecks);

    const requiredKeys = new Set(
      result.techStack.required.map((item) => item.toLowerCase()),
    );
    result.techStack.optional = result.techStack.optional.filter(
      (item) => !requiredKeys.has(item.toLowerCase()),
    );

    return result;
  }

  function normalizeWorkArrangement(work, sourceText) {
    const type = enumValue(work?.type, VALID_WORK_TYPES, 'unknown');
    const hasOfficeDayEvidence =
      type === 'hybrid' && hasExplicitOfficeDayCount(sourceText);
    const workDays =
      type === 'hybrid' && hasOfficeDayEvidence
        ? normalizeWorkDays(work)
        : { min: null, max: null };

    return {
      type,
      daysInOffice: workDays.min,
      daysInOfficeMin: workDays.min,
      daysInOfficeMax: workDays.max,
      details: workDetailsWithoutUnsupportedDays(
        work?.details,
        type,
        hasOfficeDayEvidence,
      ),
      confidence: enumValue(work?.confidence, VALID_CONFIDENCE, 'low'),
    };
  }

  function workDetailsWithoutUnsupportedDays(
    details,
    type,
    hasOfficeDayEvidence,
  ) {
    const text = stringOrEmpty(details);
    if (type !== 'hybrid' || hasOfficeDayEvidence) return text;

    return explicitOfficeDayPhrasePattern().test(text) ? '' : text;
  }

  function hasExplicitOfficeDayCount(text) {
    return explicitOfficeDayPhrasePattern().test(cleanMetadataText(text));
  }

  function explicitOfficeDayPhrasePattern() {
    const number = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five)`;
    const range = String.raw`${number}\s*(?:-|–|—|\bto\b|\bor\b)\s*${number}`;
    const qualifier = String.raw`(?:(?:at\s+least|min(?:imum)?(?:\s+of)?|up\s+to|around|about|approx(?:imately)?)\s+)?`;
    const count = String.raw`${qualifier}(?:${range}|${number}\s*\+?)`;
    const office = String.raw`(?:office|on[-\s]?site|onsite|workplace|work\s+site|site)`;
    const day = String.raw`(?:d|day|days)`;
    const frequency = String.raw`(?:week|weekly|fortnight|fortnightly|month|monthly)`;
    const cadence = String.raw`(?:\s*(?:a|per|\/)\s*${frequency})?`;
    const countThenOffice = String.raw`${count}\s*${day}s?${cadence}[^.\n;:]{0,80}\b${office}\b`;
    const officeThenCount = String.raw`\b${office}\b[^.\n;:]{0,80}${count}\s*${day}s?${cadence}`;
    const officeDays = String.raw`${count}\s*\b${office}\b\s*${day}s?${cadence}`;

    return new RegExp(
      String.raw`(?:${countThenOffice}|${officeThenCount}|${officeDays})`,
      'i',
    );
  }

  function normalizeWorkDays(work) {
    const fromExplicitRange = normalizeNumberRange(
      work?.daysInOfficeMin,
      work?.daysInOfficeMax,
    );
    if (fromExplicitRange.min !== null || fromExplicitRange.max !== null) {
      return fromExplicitRange;
    }

    return normalizeWorkDaysValue(work?.daysInOffice);
  }

  function normalizeWorkDaysValue(value) {
    if (Array.isArray(value)) {
      return normalizeNumberRange(value[0], value[1]);
    }

    if (typeof value === 'string') {
      const matches = [...value.matchAll(/\d+(?:\.\d+)?/g)]
        .map((match) => Number(match[0]))
        .filter(Number.isFinite);
      if (matches.length >= 2) {
        return normalizeNumberRange(matches[0], matches[1]);
      }
      if (matches.length === 1) return normalizeNumberRange(matches[0], null);
    }

    return normalizeNumberRange(value, null);
  }

  function normalizeNumberRange(minValue, maxValue) {
    const min = numberOrNull(minValue);
    const max = numberOrNull(maxValue);
    if (!Number.isFinite(min) && !Number.isFinite(max)) {
      return { min: null, max: null };
    }

    if (!Number.isFinite(min)) return { min: max, max };
    if (!Number.isFinite(max)) return { min, max: min };

    return {
      min: Math.min(min, max),
      max: Math.max(min, max),
    };
  }

  function renderLoading(message) {
    ensurePanel();
    state.content.innerHTML = `
      <div class="job-scraper-llm__loading">
        <span class="job-scraper-llm__spinner" aria-hidden="true"></span>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  }

  function renderSuccess(result) {
    ensurePanel();

    const work = result.workArrangement;
    const pay = result.pay;
    const summaryLines = [
      renderValueLine('Work', renderWorkValue(work), hasWorkValue(work)),
      renderValueLine('Pay', renderPayValue(pay), hasPayValue(pay)),
    ].join('');
    const techLines = [
      renderTechLine('Required', result.techStack.required),
      renderTechLine('Optional', result.techStack.optional),
    ].join('');
    const fitCriteria = renderFitCriteria(result);
    const divider =
      summaryLines && (techLines || fitCriteria)
        ? '<div class="job-scraper-llm__divider"></div>'
        : '';

    state.content.innerHTML = `
      ${summaryLines}
      ${divider}
      ${techLines}
      ${fitCriteria}
    `;
    window.requestAnimationFrame(updateTechClampState);
  }

  function renderError(error) {
    ensurePanel();
    const raw = error.raw ? String(error.raw).slice(0, 4000) : '';
    const hint =
      error.code === 'not_found'
        ? 'Retry after the description finishes loading.'
        : 'Use Retry after fixing the issue.';
    const debug = raw
      ? `<details class="job-scraper-llm__debug"><summary>Debug response</summary><pre>${escapeHtml(raw)}</pre></details>`
      : '';

    state.content.innerHTML = `
      <div class="job-scraper-llm__error">${escapeHtml(error.message)}</div>
      <div class="job-scraper-llm__line job-scraper-llm__muted">${escapeHtml(hint)}</div>
      ${debug}
    `;
  }

  function renderTechLine(label, values) {
    if (!values.length) return '';

    return `
      <div class="job-scraper-llm__line job-scraper-llm__tech-line" data-tech-line>
        <span class="job-scraper-llm__label">${escapeHtml(label)}:</span>
        ${values.map(renderTechItem).join(', ')}
      </div>
    `;
  }

  function renderValueLine(label, value, shouldShow) {
    if (!shouldShow) return '';

    return `
      <div class="job-scraper-llm__line">
        <span class="job-scraper-llm__label">${escapeHtml(label)}:</span>
        ${value}
      </div>
    `;
  }

  function renderTechItem(value) {
    const text = cleanMetadataText(value);
    const kind = techMatchKind(text);
    const color = kind ? cleanMetadataText(CONFIG.matchColors?.[kind]) : '';
    const style = color ? ` style="color: ${escapeHtml(color)}"` : '';

    return `<span${style}>${escapeHtml(text)}</span>`;
  }

  function renderFitCriteria(result) {
    const items = collectFitCriteria(result);
    if (!items.length) return '';

    return `
      <div class="job-scraper-llm__divider"></div>
      <div class="job-scraper-llm__fit-list">
        ${items.map(renderFitCriterionItem).join('')}
      </div>
    `;
  }

  function renderFitCriterionItem(item) {
    const icon = CONFIG.statusIcons?.[item.kind] || '';
    const color = statusColor(item.kind);
    const style = color ? ` style="color: ${escapeHtml(color)}"` : '';
    const isHighConfidence = item.check.confidence === 'high';
    const textStyle =
      isHighConfidence && color ? ` style="color: ${escapeHtml(color)}"` : '';
    const details = cleanMetadataText(item.check.details);
    const title = details ? ` title="${escapeHtml(details)}"` : '';
    const confidence = renderConfidenceSymbol(
      item.check.confidence,
      hasActionableFitConfidence(item.check.confidence) && !isHighConfidence,
    );

    return `
      <span class="job-scraper-llm__fit-item"${title}>
        <span class="job-scraper-llm__fit-symbol"${style}>${escapeHtml(icon)}</span>
        <span class="job-scraper-llm__fit-text"${textStyle}>${escapeHtml(item.check.criterion)}</span>
        ${confidence}
      </span>
    `;
  }

  function updateTechClampState() {
    if (!state.content) return;

    for (const line of state.content.querySelectorAll('[data-tech-line]')) {
      line.classList.remove(
        'job-scraper-llm__tech-line--overflow',
        'job-scraper-llm__tech-line--expanded',
      );
      line.removeAttribute('role');
      line.removeAttribute('tabindex');
      line.removeAttribute('aria-expanded');
      line.removeAttribute('title');

      if (line.scrollHeight <= line.clientHeight + 1) continue;

      line.classList.add('job-scraper-llm__tech-line--overflow');
      line.setAttribute('role', 'button');
      line.setAttribute('tabindex', '0');
      line.setAttribute('aria-expanded', 'false');
    }
  }

  function updateTitleTooltip() {
    const element = state.titleElement;
    if (!element) return;

    const fullTitle = cleanMetadataText(element.dataset.fullTitle);
    element.removeAttribute('title');
    if (fullTitle && element.scrollWidth > element.clientWidth + 1) {
      element.setAttribute('title', fullTitle);
    }
  }

  function toggleTechLine(line) {
    const expanded = line.classList.toggle(
      'job-scraper-llm__tech-line--expanded',
    );
    line.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function renderWorkValue(work) {
    const text = escapeHtml(workText(work));
    const style = workMatchStyle(work);
    const value = style ? `<span${style}>${text}</span>` : text;
    return `${value}${renderConfidenceSymbol(work?.confidence, hasWorkValue(work))}`;
  }

  function renderPayValue(pay) {
    return `${escapeHtml(payText(pay))}${renderConfidenceSymbol(pay?.confidence, hasPayValue(pay))}`;
  }

  function formatWork(work) {
    return `${workText(work)}${plainConfidenceSymbol(work?.confidence, hasWorkValue(work))}`;
  }

  function formatPay(pay) {
    return `${payText(pay)}${plainConfidenceSymbol(pay?.confidence, hasPayValue(pay))}`;
  }

  function formatCopyText(result) {
    const lines = compactTextLines([
      `Title: ${state.jobTitle || result.jobTitle || 'Unknown'}`,
      `Fit: ${formatAssessmentTitle(result.assessment)}`,
      hasWorkValue(result.workArrangement)
        ? `Work: ${formatWork(result.workArrangement)}`
        : '',
      hasPayValue(result.pay) ? `Pay: ${formatPay(result.pay)}` : '',
    ]);
    const techLines = compactTextLines([
      result.techStack.required.length
        ? `Required: ${result.techStack.required.join(', ')}`
        : '',
      result.techStack.optional.length
        ? `Optional: ${result.techStack.optional.join(', ')}`
        : '',
    ]);

    if (techLines.length) {
      lines.push('', 'Tech:', ...techLines);
    }

    return lines.join('\n');
  }

  function workText(work) {
    const rawType = work?.type || 'unknown';
    const type =
      rawType === 'onsite'
        ? 'Onsite'
        : rawType.charAt(0).toUpperCase() + rawType.slice(1);
    const days = rawType === 'hybrid' ? workDaysText(work) : '';

    return `${type}${days}`;
  }

  function workDaysText(work) {
    const range = normalizeWorkDays(work);
    if (!Number.isFinite(range.min)) return '';

    const min = formatWorkDayCount(range.min);
    const max = Number.isFinite(range.max)
      ? formatWorkDayCount(range.max)
      : min;
    if (min !== max) return ` ${min}-${max}d`;

    return ` ${min}d`;
  }

  function formatWorkDayCount(value) {
    return Number.isInteger(value) ? String(value) : String(value);
  }

  function payText(pay) {
    const range = pay?.range || '';
    if (!range) return 'Not found';

    const type = enumValue(pay?.type, VALID_PAY_TYPES, 'unknown');
    if (
      (type === 'hourly' || type === 'daily') &&
      inferPayType(range) !== type
    ) {
      return `${range} (${type})`;
    }

    return range;
  }

  function hasWorkValue(work) {
    return Boolean(work?.type && work.type !== 'unknown');
  }

  function hasPayValue(pay) {
    return Boolean(pay?.range);
  }

  function plainConfidenceSymbol(confidence, shouldShow) {
    const symbol = confidenceSymbol(confidence, shouldShow);
    return symbol ? ` ${symbol}` : '';
  }

  function renderConfidenceSymbol(confidence, shouldShow) {
    const symbol = confidenceSymbol(confidence, shouldShow);
    if (!symbol) return '';

    const color = confidenceColor(confidence);
    const style = color ? ` style="color: ${escapeHtml(color)}"` : '';
    return `<span class="job-scraper-llm__confidence"${style} title="${escapeHtml(confidence)} confidence">${escapeHtml(symbol)}</span>`;
  }

  function confidenceSymbol(confidence, shouldShow) {
    if (!shouldShow) return '';

    const key = enumValue(confidence, VALID_CONFIDENCE, '');
    return key ? cleanMetadataText(CONFIG.confidenceSymbols?.[key]) : '';
  }

  function statusColor(status) {
    return cleanMetadataText(CONFIG.statusColors?.[status]);
  }

  function confidenceColor(confidence) {
    const key = enumValue(confidence, VALID_CONFIDENCE, '');
    return cleanMetadataText(
      CONFIG.confidenceColors?.[key] || CONFIG.confidenceColor,
    );
  }

  function workMatchStyle(work) {
    const kind = workMatchKind(work);
    const color = kind ? cleanMetadataText(CONFIG.matchColors?.[kind]) : '';
    return color ? ` style="color: ${escapeHtml(color)}"` : '';
  }

  function workMatchKind(work) {
    const score = workSetupScore(work);
    const workBad = configNumber(CONFIG.workBad);
    const workGood = configNumber(CONFIG.workGood);
    if (!Number.isFinite(score)) return '';

    const isBad = Number.isFinite(workBad) && score >= workBad;
    const isGood = Number.isFinite(workGood) && score <= workGood;
    if (isBad === isGood) return '';

    return isBad ? 'bad' : 'good';
  }

  function workSetupScore(work) {
    const type = enumValue(work?.type, VALID_WORK_TYPES, 'unknown');
    if (type === 'remote') return 0;
    if (type === 'onsite') return 5;
    if (type !== 'hybrid') return null;

    const { min } = normalizeWorkDays(work);
    if (!Number.isFinite(min)) return null;

    return clamp(min, 1, 4);
  }

  function configNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function techMatchKind(value) {
    if (regexListMatches(CONFIG.badTech, value)) return 'bad';
    if (regexListMatches(CONFIG.goodTech, value)) return 'good';
    return '';
  }

  function regexListMatches(patterns, value) {
    const text = String(value || '');
    if (!text || !Array.isArray(patterns)) return false;

    for (const pattern of patterns) {
      if (!(pattern instanceof RegExp)) continue;

      pattern.lastIndex = 0;
      if (pattern.test(text)) return true;
    }

    return false;
  }

  function collectFitCriteria(result) {
    const verdict = enumValue(
      result.assessment?.status,
      VALID_ASSESSMENT,
      'uncertain',
    );
    const items = [];

    for (const kind of ['bad', 'good']) {
      const checks = result.fitChecks?.[kind];
      if (!Array.isArray(checks)) continue;

      for (const check of checks) {
        if (check?.discounted) continue;
        if (!check?.matches) continue;
        if (!hasActionableFitConfidence(check.confidence)) continue;

        items.push({
          kind,
          check,
          active:
            verdict === kind &&
            check.matches &&
            check.confidence === 'high' &&
            !check.discounted,
        });
      }
    }

    return items;
  }

  function hasActionableFitConfidence(confidence) {
    return VALID_CONFIDENCE.has(
      enumValue(confidence, VALID_FIT_CONFIDENCE, ''),
    );
  }

  function resetJobState() {
    state.currentResult = null;
    state.currentRawJson = '';
    state.currentOllamaDebug = null;
    state.currentJobText = '';
    state.currentPayEvidence = null;
    state.currentError = null;
    state.jobTitle = '';
    state.assessmentStatus = 'uncertain';
    state.assessment = null;
    state.lastSignature = '';
    updateJsonWindowContent();
    updateDebugWindowContent();
    renderPanelTitle();
  }

  function applyResultState(result) {
    state.jobTitle =
      cleanJobTitle(state.jobTitle) || cleanJobTitle(result.jobTitle);
    state.assessment = result.assessment || null;
    state.assessmentStatus = enumValue(
      state.assessment?.status,
      VALID_ASSESSMENT,
      'uncertain',
    );
    renderPanelTitle();
  }

  function normalizeFitChecks(value, prompts) {
    const criteria = normalizeFitCriteria(prompts);
    const checks = Array.isArray(value) ? value : [];

    return criteria.map((criterionConfig, index) => {
      const matchingCheck =
        checks.find(
          (item) =>
            cleanMetadataText(item?.criterion).toLowerCase() ===
            criterionConfig.criterion.toLowerCase(),
        ) ||
        checks[index] ||
        {};

      return {
        criterion: criterionConfig.criterion,
        ids: criterionConfig.ids,
        matches:
          matchingCheck.matches === true ||
          String(matchingCheck.matches).toLowerCase() === 'true',
        confidence: enumValue(
          matchingCheck.confidence,
          VALID_FIT_CONFIDENCE,
          'inconclusive',
        ),
        details: stringOrEmpty(matchingCheck.details),
      };
    });
  }

  function fitCriterionTexts(value) {
    return normalizeFitCriteria(value).map((item) => item.criterion);
  }

  function normalizeFitCriteria(value) {
    return (Array.isArray(value) ? value : [])
      .map(normalizeFitCriterion)
      .filter((item) => item.criterion);
  }

  function normalizeFitCriterion(value) {
    if (Array.isArray(value)) {
      const criterion = cleanMetadataText(value[0]);
      return {
        criterion,
        ids: normalizeFitCriterionIds(value[1], criterion),
      };
    }

    if (value && typeof value === 'object') {
      const criterion = cleanMetadataText(value.criterion || value.text);
      return {
        criterion,
        ids: normalizeFitCriterionIds(value.id || value.ids, criterion),
      };
    }

    const criterion = cleanMetadataText(value);
    return {
      criterion,
      ids: normalizeFitCriterionIds(null, criterion),
    };
  }

  function normalizeFitCriterionIds(value, criterion) {
    const explicitIds = []
      .concat(value || [])
      .map((item) => cleanMetadataText(item))
      .filter(Boolean);
    const ids = explicitIds.length
      ? explicitIds
      : inferFitCriterionIds(criterion);

    return normalizeList(ids);
  }

  function inferFitCriterionIds(criterion) {
    const text = cleanMetadataText(criterion);
    const ids = [];

    if (isPayCriterion(text)) ids.push('pay');
    if (/\b(remote|hybrid|on[-\s]?site|onsite|office)\b/i.test(text)) {
      ids.push('work-arrangement');
    }

    return ids;
  }

  function applyPayEvidenceToResult(result, evidence) {
    if (!evidence?.range || !result?.pay) return;

    const type = enumValue(evidence.type, VALID_PAY_TYPES, 'unknown');
    result.pay.range = evidence.range;
    result.pay.type = type;
    result.pay.includesSuper = Boolean(evidence.includesSuper);
    result.pay.isOTE = Boolean(evidence.isOTE);
    result.pay.confidence = enumValue(
      evidence.confidence,
      VALID_CONFIDENCE,
      type === 'unknown' ? 'medium' : 'high',
    );
  }

  function applyPayEvidenceToFitChecks(fitChecks, evidence) {
    if (!evidence?.range || !evidence?.values) return fitChecks;

    return {
      bad: applyPayEvidenceToCheckList(fitChecks.bad, evidence, 'bad'),
      good: applyPayEvidenceToCheckList(fitChecks.good, evidence, 'good'),
    };
  }

  function applyPayEvidenceToCheckList(checks, evidence, kind) {
    if (!Array.isArray(checks)) return [];

    return checks.map((check) => {
      const evaluation = evaluatePayCriterion(check?.criterion, evidence, kind);
      return evaluation ? { ...check, ...evaluation } : check;
    });
  }

  function applyWorkArrangementToFitChecks(fitChecks, work) {
    if (!work || work.type === 'unknown') return fitChecks;

    return {
      bad: applyWorkArrangementToCheckList(fitChecks.bad, work),
      good: applyWorkArrangementToCheckList(fitChecks.good, work),
    };
  }

  function applyWorkArrangementToCheckList(checks, work) {
    if (!Array.isArray(checks)) return [];

    return checks.map((check) => {
      const evaluation = evaluateWorkCriterion(check?.criterion, work);
      return evaluation ? { ...check, ...evaluation } : check;
    });
  }

  function evaluateWorkCriterion(criterion, work) {
    const text = cleanMetadataText(criterion);
    if (!text) return null;
    if (/\blocation|based in|sydney|nsw\b/i.test(text)) return null;

    if (/\bfully\s+remote\b|\bremote\b/i.test(text)) {
      return formatWorkCriterionEvaluation(
        work,
        work.type === 'remote',
        'work type is remote',
        'work type is not remote',
      );
    }

    if (/\bon[-\s]?site\b|\bonsite\b/i.test(text)) {
      return formatWorkCriterionEvaluation(
        work,
        work.type === 'onsite',
        'work type is on-site',
        'work type is not on-site',
      );
    }

    if (/\bhybrid\b/i.test(text)) {
      const threshold = extractHybridDaysThreshold(text);
      if (!Number.isFinite(threshold)) return null;

      const score = workSetupScore(work);
      if (!Number.isFinite(score)) {
        return {
          matches: false,
          confidence: 'inconclusive',
          details: 'Hybrid work is mentioned, but office-day count is unclear',
        };
      }

      const matches = work.type === 'hybrid' && score >= threshold;
      return {
        matches,
        confidence: 'high',
        details: `${formatWorkForDetails(work)} counts as ${formatWorkDayCount(score)} day(s) for fit checks; ${matches ? 'meets' : 'does not meet'} hybrid >= ${formatWorkDayCount(threshold)} days in office`,
      };
    }

    return null;
  }

  function extractHybridDaysThreshold(text) {
    const match = cleanMetadataText(text).match(
      /(?:>=|≥|at least|minimum(?: of)?|min(?:imum)?\.?)\s*(\d+(?:\.\d+)?)\s*(?:d|day|days)?/i,
    );
    return match ? Number(match[1]) : null;
  }

  function formatWorkCriterionEvaluation(work, matches, trueText, falseText) {
    return {
      matches,
      confidence: 'high',
      details: `${formatWorkForDetails(work)}; ${matches ? trueText : falseText}`,
    };
  }

  function formatWorkForDetails(work) {
    return `Work arrangement is ${workText(work)}`;
  }

  function resolveFitCheckConflicts(fitChecks) {
    const byId = new Map();

    for (const kind of ['bad', 'good']) {
      for (const check of fitChecks[kind] || []) {
        if (!check?.matches) continue;
        if (!hasActionableFitConfidence(check.confidence)) continue;

        for (const id of check.ids || []) {
          if (!byId.has(id)) byId.set(id, { bad: [], good: [] });
          byId.get(id)[kind].push(check);
        }
      }
    }

    for (const [id, group] of byId) {
      if (!group.bad.length || !group.good.length) continue;

      markFitConflicts(id, group.bad, group.good);
      markFitConflicts(id, group.good, group.bad);
    }

    return fitChecks;
  }

  function markFitConflicts(id, checks, opposingChecks) {
    const opposingCriteria = opposingChecks
      .map((check) => cleanMetadataText(check.criterion))
      .filter(Boolean)
      .join(', ');

    for (const check of checks) {
      check.discounted = true;
      check.matches = false;
      check.confidence = 'inconclusive';
      check.details = opposingCriteria
        ? `Conflict discounted (${id}): also matched ${opposingCriteria}`
        : `Conflict discounted (${id})`;
    }
  }

  function evaluatePayCriterion(criterion, evidence, kind) {
    const text = cleanMetadataText(criterion);
    if (!isPayCriterion(text)) return null;

    const operator = extractPayCriterionOperator(text, kind);
    const threshold = extractPayCriterionThreshold(text, evidence.type);
    if (!operator || !Number.isFinite(threshold)) return null;

    const { min, max } = evidence.values;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

    const inclusive = payCriterionIsInclusive(text);
    const matched =
      operator === 'lt'
        ? max < threshold || (inclusive && max <= threshold)
        : min > threshold || (inclusive && min >= threshold);
    const partial =
      operator === 'lt'
        ? min < threshold || (inclusive && min <= threshold)
        : max > threshold || (inclusive && max >= threshold);
    const matches = matched || partial;
    const confidence = matched || !partial ? 'high' : 'medium';

    return {
      matches,
      confidence,
      details: formatPayCriterionDetails(
        evidence,
        operator,
        threshold,
        matches,
        confidence,
      ),
    };
  }

  function isPayCriterion(text) {
    return /\b(pay|salary|compensation|rate|package|OTE)\b|\$|\/\s*(?:hr|hour|day|yr|year)|\bk\b/i.test(
      text,
    );
  }

  function extractPayCriterionOperator(text, kind) {
    if (/[<≤]|less than|under|below/i.test(text)) return 'lt';
    if (/[>≥]|more than|greater than|over|above|at least|\d\s*\+/i.test(text)) {
      return 'gt';
    }

    return kind === 'bad' ? 'lt' : 'gt';
  }

  function extractPayCriterionThreshold(text, type) {
    const patterns = {
      hourly: [
        /(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)?\s*(\d[\d,]*(?:\.\d+)?)\s*\+?\s*(?:\/|\bper\s*)\s*(?:hr|hour)\b/i,
        /\b(?:hr|hour|hourly)\b[^\d$]*(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)?\s*(\d[\d,]*(?:\.\d+)?)/i,
      ],
      daily: [
        /(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|K)?\s*\+?\s*(?:\/|\bper\s*)\s*(?:day|daily)\b/i,
        /\b(?:day|daily|day\s*rate)\b[^\d$]*(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(k|K))?/i,
      ],
      annual: [
        /(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|K)\b/i,
        /(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)\s*(\d{3,}(?:,\d{3})*(?:\.\d+)?)/i,
        /\b(\d{3,}(?:,\d{3})*(?:\.\d+)?)\s*(?:\/|\bper\s*)\s*(?:yr|year|annum)\b/i,
      ],
    };

    for (const pattern of patterns[type] || []) {
      const match = text.match(pattern);
      if (!match) continue;

      const value = parsePayNumber(match[1], match[2]);
      if (Number.isFinite(value)) return value;
    }

    return null;
  }

  function payCriterionIsInclusive(text) {
    return /[≤≥]|at least|\d\s*\+/i.test(text);
  }

  function formatPayCriterionDetails(
    evidence,
    operator,
    threshold,
    matches,
    confidence,
  ) {
    const thresholdText = formatPayThreshold(threshold, evidence.type);
    const comparison = operator === 'lt' ? 'below' : 'above';
    const partial = operator === 'lt' ? 'partly falls below' : 'partly reaches';
    const outcome = matches
      ? confidence === 'high'
        ? `is ${comparison}`
        : partial
      : `is not ${comparison}`;

    return `Explicit pay is ${evidence.range} (${evidence.type}); ${outcome} ${thresholdText}`;
  }

  function formatPayThreshold(value, type) {
    if (type === 'annual') return `$${Math.round(value / 1000)}k annual`;
    if (type === 'hourly') return `$${formatPayNumber(value)}/hour`;
    if (type === 'daily') return `$${formatPayNumber(value)}/day`;
    return `$${formatPayNumber(value)}`;
  }

  function buildAssessment(fitChecks) {
    const badMatch = fitChecks.bad.find(
      (check) =>
        check.matches &&
        check.confidence === 'high' &&
        !check.discounted &&
        hasActionableFitConfidence(check.confidence),
    );
    if (badMatch) {
      return {
        status: 'bad',
        reason: `Bad: ${badMatch.criterion}`,
        match: badMatch,
      };
    }

    const goodMatch = fitChecks.good.find(
      (check) =>
        check.matches &&
        check.confidence === 'high' &&
        !check.discounted &&
        hasActionableFitConfidence(check.confidence),
    );
    if (goodMatch) {
      return {
        status: 'good',
        reason: `Good: ${goodMatch.criterion}`,
        match: goodMatch,
      };
    }

    return {
      status: 'uncertain',
      reason: 'No high-confidence preference match',
      match: null,
    };
  }

  function formatAssessmentTitle(assessment) {
    if (!assessment) return 'Job fit: uncertain';

    const status = enumValue(assessment.status, VALID_ASSESSMENT, 'uncertain');
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    const reason =
      assessment.match?.criterion ||
      assessment.reason ||
      'No high-confidence preference match';
    return `${label} - ${reason}`;
  }

  function composeJobText(metadata, bodyText, htmlContext = []) {
    const metadataText = metadata.filter(Boolean).join('\n');
    const htmlText = normalizeList(htmlContext).join('\n');
    const sections = [];

    if (metadataText) sections.push(metadataText);
    if (htmlText) sections.push(`[Source HTML]:\n${htmlText}`);
    if (bodyText) sections.push(bodyText);

    return sections.join('\n---\n');
  }

  function addMetadata(lines, label, value) {
    const text = cleanMetadataText(value);
    if (text) lines.push(`[${label}]: ${text}`);
  }

  function buildLinkedInHtmlContext({
    detailsRoot,
    headerRoot,
    aboutTheJob,
    body,
    paySources,
  }) {
    const chunks = [];
    const seen = new Set();
    const payArea =
      findSalaryContextElement(headerRoot, paySources) ||
      findSalaryContextElement(detailsRoot, paySources);
    const topCard =
      findLinkedInTopCardElement(detailsRoot, headerRoot, payArea) || payArea;
    const descriptionRoot = cleanMetadataText(getText(body))
      ? body
      : aboutTheJob;

    addHtmlContextChunk(chunks, seen, 'linkedin-top-card', topCard, 1400);
    addHtmlContextChunk(chunks, seen, 'linkedin-pay-area', payArea, 800);
    addHtmlContextChunk(
      chunks,
      seen,
      'linkedin-description-html',
      descriptionRoot,
      1600,
    );

    return chunks;
  }

  function buildSeekHtmlContext(body) {
    const chunks = [];
    const seen = new Set();

    addHtmlContextChunk(
      chunks,
      seen,
      'seek-title',
      firstElement([
        '[data-automation="job-detail-title"]',
        '[data-testid="job-detail-title"]',
        'h1',
      ]),
      700,
    );
    addHtmlContextChunk(
      chunks,
      seen,
      'seek-salary',
      firstElement([
        '[data-automation="job-detail-salary"]',
        '[data-testid="job-detail-salary"]',
        '[data-automation*="salary" i]',
        '[data-testid*="salary" i]',
      ]),
      900,
    );
    addHtmlContextChunk(
      chunks,
      seen,
      'seek-location-work',
      findSeekLocationWorkRoot(),
      1000,
    );
    addHtmlContextChunk(chunks, seen, 'seek-description-html', body, 1600);

    return chunks;
  }

  function findSeekLocationWorkRoot() {
    const elements = [
      firstElement([
        '[data-automation="job-detail-location"]',
        '[data-testid="job-detail-location"]',
      ]),
      firstElement([
        '[data-automation="job-detail-work-type"]',
        '[data-testid="job-detail-work-type"]',
      ]),
      firstElement([
        '[data-automation="job-detail-salary"]',
        '[data-testid="job-detail-salary"]',
      ]),
    ].filter(Boolean);

    if (!elements.length) return null;

    return (
      findCommonAncestor(elements) ||
      elements[0].closest('section, article, div') ||
      elements[0]
    );
  }

  function findLinkedInTopCardElement(detailsRoot, headerRoot, payArea) {
    if (!detailsRoot && !headerRoot) return null;

    const headerText = cleanMetadataText(getText(headerRoot));
    if (headerRoot && headerText.length <= 2500) return headerRoot;

    if (payArea) {
      return growContextElement(
        payArea,
        detailsRoot || document.body,
        120,
        1800,
      );
    }

    return findBestContextElement(detailsRoot || headerRoot, (text) =>
      /\b(apply|save|full[-\s]?time|part[-\s]?time|contract|remote|hybrid|on[-\s]?site|onsite)\b/i.test(
        text,
      ),
    );
  }

  function findSalaryContextElement(root, paySources = []) {
    if (!root) return null;

    const sources = normalizeList(paySources);
    const elements = root.querySelectorAll('a, button, span, p, li, div');
    for (const element of elements) {
      const text = cleanMetadataText(getText(element));
      if (!text || text.length > 500) continue;

      const matchesKnownSource = sources.some((source) =>
        text.includes(source),
      );
      if (!matchesKnownSource && !isSalaryText(text)) continue;

      return growContextElement(element, root, 35, 700);
    }

    return null;
  }

  function findBestContextElement(root, predicate) {
    if (!root) return null;

    let best = null;
    for (const element of root.querySelectorAll(
      'section, article, header, div',
    )) {
      const text = cleanMetadataText(getText(element));
      if (text.length < 40 || text.length > 1800 || !predicate(text)) continue;
      if (!best || text.length < cleanMetadataText(getText(best)).length) {
        best = element;
      }
    }

    return best;
  }

  function growContextElement(element, root, minLength, maxLength) {
    if (!element) return null;

    let candidate = element;
    let current = element;
    while (
      current?.parentElement &&
      (!root || root.contains(current.parentElement))
    ) {
      const parent = current.parentElement;
      const length = cleanMetadataText(getText(parent)).length;
      if (length > maxLength) break;

      candidate = parent;
      if (length >= minLength) current = parent;
      else current = parent;
    }

    return candidate;
  }

  function addHtmlContextChunk(chunks, seen, label, element, maxChars) {
    if (!element || seen.has(element)) return;

    const html = compactHtml(element, maxChars);
    if (!html) return;

    seen.add(element);
    chunks.push(`<${label}>${html}</${label}>`);
  }

  function compactHtml(element, maxChars = 1800) {
    const html = serializeCompactNode(element, { length: 0, max: maxChars });
    return truncateText(html, maxChars);
  }

  function serializeCompactNode(node, state) {
    if (!node || state.length >= state.max) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      return consumeHtmlBudget(normalizeInlineText(node.textContent), state);
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (
      /^(script|style|svg|path|use|img|picture|source|iframe|noscript|template)$/i.test(
        tag,
      )
    ) {
      return '';
    }

    const attrs = compactHtmlAttributes(node);
    if (
      !cleanMetadataText(node.textContent) &&
      !/(aria-label|title)=/.test(attrs)
    ) {
      return '';
    }

    const open = `<${tag}${attrs}>`;
    const close = `</${tag}>`;
    let html = consumeHtmlBudget(open, state);

    for (const child of node.childNodes) {
      html += serializeCompactNode(child, state);
      if (state.length >= state.max) break;
    }

    html += consumeHtmlBudget(close, state);
    return html;
  }

  function compactHtmlAttributes(element) {
    const attrs = [];
    for (const attr of element.attributes || []) {
      const name = attr.name.toLowerCase();
      const value = cleanMetadataText(attr.value);
      if (!value || !shouldKeepHtmlAttribute(name, value)) continue;

      attrs.push(
        `${name}="${escapeAttributeValue(compactAttributeValue(name, value))}"`,
      );
    }

    const classes = stableClassNames(element.className);
    if (classes) attrs.push(`class="${escapeAttributeValue(classes)}"`);

    return attrs.length ? ` ${attrs.join(' ')}` : '';
  }

  function shouldKeepHtmlAttribute(name, value) {
    return (
      /^data-(?:test|testid|automation|sdui|component|component-type)/.test(
        name,
      ) ||
      name === 'role' ||
      name === 'aria-label' ||
      name === 'href' ||
      name === 'title' ||
      (/^(id|name)$/.test(name) &&
        /job|salary|pay|location|work|title/i.test(value))
    );
  }

  function compactAttributeValue(name, value) {
    if (name === 'href') {
      try {
        const url = new URL(value, location.href);
        return truncateText(`${url.origin}${url.pathname}`, 180);
      } catch {
        return truncateText(value.split(/[?#]/)[0], 180);
      }
    }

    return truncateText(value, 180);
  }

  function stableClassNames(className) {
    const value =
      typeof className === 'string' ? className : String(className || '');
    return value
      .split(/\s+/)
      .filter((item) =>
        /(?:job|jobs|salary|pay|compensation|location|work|description|details|top-card|artdeco-pill)/i.test(
          item,
        ),
      )
      .slice(0, 6)
      .join(' ');
  }

  function consumeHtmlBudget(text, state) {
    if (!text || state.length >= state.max) return '';

    const remaining = state.max - state.length;
    const chunk = text.slice(0, remaining);
    state.length += chunk.length;
    return chunk;
  }

  function normalizeInlineText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeAttributeValue(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function truncateText(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  function findCommonAncestor(elements) {
    if (!elements.length) return null;

    let ancestor = elements[0];
    while (ancestor) {
      if (elements.every((element) => ancestor.contains(element))) {
        return ancestor;
      }

      ancestor = ancestor.parentElement;
    }

    return null;
  }

  function extractWorkplaceType(text) {
    const match = String(text || '').match(
      /\b(remote|hybrid|on[-\s]?site|onsite)\b/i,
    );
    if (!match) return '';

    const raw = match[1].toLowerCase().replace(/\s+/g, '-');
    if (raw === 'onsite' || raw === 'on-site') return 'Onsite';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function extractLinkedInLocation(text) {
    const lines = cleanMetadataText(text).split('\n');
    const locationLine = lines.find(
      (line) =>
        /\b(remote|hybrid|on[-\s]?site|onsite)\b/i.test(line) &&
        /\b(area|australia|nsw|vic|qld|sa|wa|tas|act|nt|sydney|melbourne|brisbane|perth|adelaide|canberra)\b/i.test(
          line,
        ),
    );

    return stripWorkplaceSuffix(locationLine || '');
  }

  function extractLinkedInPayPills(root) {
    if (!root) return [];

    const candidates = [];
    const elements = root.querySelectorAll('a, button, span, p, li, div');
    for (const element of elements) {
      const text = cleanMetadataText(getText(element));
      if (!text || text.length > 240 || !isSalaryText(text)) continue;

      const snippets = extractSalarySnippets(text);
      candidates.push(...(snippets.length ? snippets : [text]));
    }

    return normalizeList(candidates).slice(0, 3);
  }

  function buildPayEvidence(values, source) {
    const candidates = [];
    const seen = new Set();

    for (const value of [].concat(values || [])) {
      const contextType = inferPayType(value);
      const snippets = extractSalarySnippets(value);
      const ranges = snippets.length
        ? snippets
        : isSalaryText(value)
          ? [value]
          : [];

      for (const range of ranges) {
        const cleanRange = cleanMetadataText(range);
        const rangeType = inferPayType(cleanRange);
        const key = cleanRange.toLowerCase();
        if (!cleanRange || seen.has(key)) continue;

        seen.add(key);
        candidates.push({
          range: cleanRange,
          type: rangeType !== 'unknown' ? rangeType : contextType,
          contextType,
        });
      }
    }
    if (!candidates.length) return null;

    const candidate =
      candidates.find((item) => item.type !== 'unknown') || candidates[0];
    const range = candidate.range;
    const type = candidate.type || 'unknown';
    const parsedValues = parsePayValues(range, type);

    return {
      range,
      type,
      includesSuper: hasSuperText(range),
      isOTE: hasOteText(range),
      confidence: type === 'unknown' ? 'medium' : 'high',
      source: cleanMetadataText(source),
      values: parsedValues,
    };
  }

  function extractSalaryLine(text) {
    const lines = cleanMetadataText(text).split('\n');
    const salaryLine = lines.find(isSalaryText);

    if (salaryLine) {
      const snippets = extractSalarySnippets(salaryLine);
      return snippets[0] || salaryLine;
    }

    return extractSalarySnippets(text)[0] || '';
  }

  function extractSalarySnippets(text) {
    const normalized = cleanMetadataText(text).replace(/\s+/g, ' ');
    if (!isSalaryText(normalized)) return [];

    const snippets = [];
    const rangePattern = salaryRangePattern();
    for (const match of normalized.matchAll(rangePattern)) {
      if (isSalaryText(match[0])) snippets.push(match[0]);
    }

    if (!snippets.length) {
      const singlePattern = salarySinglePattern();
      for (const match of normalized.matchAll(singlePattern)) {
        if (isSalaryText(match[0])) snippets.push(match[0]);
      }
    }

    return normalizeList(snippets);
  }

  function isSalaryText(text) {
    const value = cleanMetadataText(text);
    if (!value || /salary match/i.test(value)) return false;

    return (
      /(?:\d|\$)/.test(value) &&
      /(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b|\b(?:salary|compensation|base pay|pay range|remuneration|package|OTE|super|hourly|daily|day rate)\b|\bper\s+(?:hour|hr|day|annum|year)\b|\d[\d,.]*\s*k\b.*\b(?:p\.?a\.?|per\s+(?:annum|year)|annum|year|yr)\b|\d[\d,.]*\s*(?:AUD|NZD|USD|GBP|EUR)?\s*\/\s*(?:hr|hour|day|yr|year)\b)/i.test(
        value,
      )
    );
  }

  function inferPayType(text) {
    const value = cleanMetadataText(text);
    if (!value) return 'unknown';

    if (
      /\b(hourly|hr|hours?)\b|\/\s*(?:h|hr|hour)\b|\bper\s+(?:h|hr|hour)\b/i.test(
        value,
      )
    ) {
      return 'hourly';
    }

    if (
      /\b(day\s*rate|daily|days?)\b|\/\s*(?:d|day)\b|\bper\s+(?:d|day)\b/i.test(
        value,
      )
    ) {
      return 'daily';
    }

    if (
      /\b(annual|annually|annum|yearly|years?|salary|base pay|base salary|package|remuneration)\b|\/\s*(?:yr|year)\b|p\.?a\.?/i.test(
        value,
      ) ||
      /\b\d[\d,.]*\s*k\b/i.test(value) ||
      /(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)\s*\d{3,}(?:,\d{3})/i.test(value)
    ) {
      return 'annual';
    }

    return 'unknown';
  }

  function parsePayValues(text, type) {
    const values = [];
    const pattern =
      /(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|K)?/g;

    for (const match of cleanMetadataText(text).matchAll(pattern)) {
      const value = parsePayNumber(match[1], match[2]);
      if (!Number.isFinite(value)) continue;

      if (type === 'annual' && !match[2] && value < 1000) continue;
      values.push(value);
    }

    if (!values.length) return null;

    return {
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  function parsePayNumber(value, suffix = '') {
    const number = Number.parseFloat(String(value || '').replace(/,/g, ''));
    if (!Number.isFinite(number)) return null;
    return /k/i.test(suffix) ? number * 1000 : number;
  }

  function hasSuperText(text) {
    return /\bsuper(?:annuation)?\b|\+\s*super|plus\s+super|incl(?:udes|uding)?\s+super/i.test(
      cleanMetadataText(text),
    );
  }

  function hasOteText(text) {
    return /\bOTE\b|on[-\s]?target earnings/i.test(cleanMetadataText(text));
  }

  function formatPayNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  function salaryAmountPattern() {
    const currency = String.raw`(?:A?\$|\b(?:AUD|NZD|USD|GBP|EUR)\b)`;
    const unit = String.raw`(?:(?:\/|\bper\s+)\s*(?:yr|year|annum|hr|hour|day)|p\.?a\.?\b|\b(?:annum|year|yr|hourly|hour|daily|day)\b)`;
    return String.raw`(?:${currency}\s*)?\d[\d,]*(?:\.\d+)?\s*(?:k|K)?(?:\s*\+(?=\s*(?:${currency}|${unit})))?(?:\s*${currency})?(?:\s*${unit})?`;
  }

  function salaryRangePattern() {
    const amount = salaryAmountPattern();
    return new RegExp(
      String.raw`${amount}\s*(?:-|–|—|\bto\b|\band\b)\s*${amount}(?:\s*(?:\+\s*super|plus\s+super|incl(?:udes|uding)?\s+super|package|OTE))?`,
      'gi',
    );
  }

  function salarySinglePattern() {
    const amount = salaryAmountPattern();
    return new RegExp(
      String.raw`${amount}(?:\s*(?:\+\s*super|plus\s+super|incl(?:udes|uding)?\s+super|package|OTE))?`,
      'gi',
    );
  }

  function extractLinkedInDetails(text) {
    const candidates = cleanMetadataText(text)
      .split('\n')
      .filter((line) =>
        /\b(full[-\s]?time|part[-\s]?time|contract|temporary|internship|entry level|associate|mid[-\s]?senior|director|executive)\b/i.test(
          line,
        ),
      )
      .slice(0, 4);

    return candidates.join(' | ');
  }

  function extractLinkedInTitle(root) {
    const selectors = [
      '.job-details-jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title a',
      '.jobs-unified-top-card__job-title',
      '.jobs-details-top-card__job-title',
      '[data-test-job-title]',
      '[data-testid="job-title"]',
    ];
    if (location.pathname.includes('/jobs/view/')) selectors.push('h1');
    const roots = [root, document];

    for (const candidateRoot of roots) {
      for (const selector of selectors) {
        const title = cleanJobTitle(
          getText(candidateRoot?.querySelector(selector)),
        );
        if (title) return title;
      }
    }

    return extractTitleFromDocument('linkedin');
  }

  function extractSeekTitle() {
    const candidates = [
      getText('[data-automation="job-detail-title"]') ||
        getText('[data-testid="job-detail-title"]'),
      extractSeekDataLayerTitle(),
      getText('h1'),
    ];

    for (const candidate of candidates) {
      const title = cleanJobTitle(candidate);
      if (title) return title;
    }

    return extractTitleFromDocument('seek');
  }

  function extractSeekDataLayerTitle() {
    for (const script of document.querySelectorAll('script')) {
      const match = String(script.textContent || '').match(
        /"jobTitle"\s*:\s*"((?:\\.|[^"\\])*)"/,
      );
      if (!match) continue;

      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return match[1].replace(/\\"/g, '"');
      }
    }

    return '';
  }

  function extractTitleFromDocument(site) {
    const title = cleanPageCountPrefix(cleanMetadataText(document.title));
    if (!title) return '';

    if (site === 'linkedin') {
      return cleanJobTitle(title.split(/\s+[|_]\s+/)[0]);
    }

    if (/\bJobs\s+in\b/i.test(title)) return '';

    return cleanJobTitle(
      title
        .replace(/\s+Job\s+in\s+.+?\s+-\s+SEEK$/i, '')
        .replace(/\s+[|_-]\s+SEEK$/i, ''),
    );
  }

  function cleanJobTitle(value) {
    const title = cleanPageCountPrefix(cleanMetadataText(value));
    if (!title || title.length > 140) return '';
    if (
      /\b(job search|jobs?\s+in|jobs?\s*$|linkedin|seek|sign in|open app)\b/i.test(
        title,
      )
    ) {
      return '';
    }
    return title;
  }

  function cleanPageCountPrefix(value) {
    return cleanMetadataText(value).replace(/^\(\d+\)\s*/, '');
  }

  function stripWorkplaceSuffix(text) {
    return cleanMetadataText(text).replace(
      /\s*\((Remote|Hybrid|On[-\s]?site|Onsite)\)\s*$/i,
      '',
    );
  }

  function textBeforeNeedle(text, needle) {
    const index = text.indexOf(needle);
    return index > 0 ? text.slice(0, index) : text;
  }

  function cleanDescriptionText(text) {
    return normalizeText(text)
      .replace(/^About the job\s*/i, '')
      .replace(/\n?Show more\s*$/i, '')
      .replace(/\s*(?:…|\.\.\.)\s*more\s*$/i, '')
      .trim();
  }

  function cleanMetadataText(text) {
    return normalizeText(text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  }

  function getText(input) {
    const element =
      typeof input === 'string' ? document.querySelector(input) : input;
    if (!element) return '';
    return element.innerText || element.textContent || '';
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function firstElement(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }

    return null;
  }

  function firstElementFrom(root, selectors) {
    if (!root) return null;

    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (element) return element;
    }

    return null;
  }

  function safeClick(element) {
    try {
      element.click();
    } catch {}
  }

  function enumValue(value, valid, fallback) {
    const normalized = String(value || '')
      .toLowerCase()
      .replace(/^on[-\s]?site$/, 'onsite');
    return valid.has(normalized) ? normalized : fallback;
  }

  function numberOrNull(value) {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
  }

  function booleanValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return Boolean(value);
  }

  function stringOrNull(value) {
    if (value === null || value === undefined) return null;
    const normalized = cleanMetadataText(value);
    return normalized || null;
  }

  function stringOrEmpty(value) {
    return cleanMetadataText(value);
  }

  function normalizeList(value) {
    if (!Array.isArray(value)) return [];

    const seen = new Set();
    const result = [];

    for (const item of value) {
      const text = cleanMetadataText(item);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;

      seen.add(key);
      result.push(text);
    }

    return result;
  }

  function compactTextLines(lines) {
    return (Array.isArray(lines) ? lines : []).filter((line) =>
      Boolean(cleanMetadataText(line)),
    );
  }

  function safeParseJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function userError(code, message, raw = '', cause = null) {
    const error = new Error(message);
    error.code = code;
    error.raw = raw;
    error.cause = cause;
    return error;
  }

  function toUserError(error) {
    if (error?.code === 'offline') {
      return userError(
        'offline',
        'LLM offline - is Ollama running?',
        error.raw || '',
        error,
      );
    }

    if (error?.code === 'parse') {
      return userError('parse', 'Parse error', error.raw || '', error);
    }

    if (error?.code === 'shape') {
      return userError(
        'shape',
        error.message || 'Invalid model JSON',
        error.raw || '',
        error,
      );
    }

    if (error?.code === 'not_found') {
      return userError(
        'not_found',
        'Could not find job description',
        error.raw || '',
        error,
      );
    }

    return userError(
      'unknown',
      error?.message || 'Unexpected error',
      error?.raw || '',
      error,
    );
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function makeId(prefix) {
    const random =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    return `${prefix}-${Date.now()}-${random}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
