// ==UserScript==
// @name         Job listing scraper (LLM)
// @namespace    local
// @version      1.0.7
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
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    model: 'qwen2.5:7b',
    ollamaUrl: 'http://localhost:11434',
    timeout: 15000,
    numPredict: 1024,
    good: ['pay > 165k or $110+/hour', 'fully remote'],
    bad: [
      'pay < 160k or $100/hour',
      'hybrid >= 3 days in office',
      'on-site role',
      '.NET, Java, C#, C++ required',
      'hybrid but not based in Sydney/NSW',
    ],
    goodTech: ['TypeScript', 'React', 'Node(?:\\.js)?', 'Next(?:\\.js)?', 'GraphQL'],
    badTech: ['\\.NET', '\\bJava\\b', '\\bC#\\b', '\\bC\\+\\+\\b'],
    statusIcons: {
      good: '✓',
      bad: '✕',
      uncertain: '?',
    },
    statusColors: {
      good: '#86efac',
      bad: '#fca5a5',
      uncertain: '#93c5fd',
    },
    confidenceSymbols: {
      low: '▂',
      medium: '▅',
      high: '█',
    },
    confidenceColor: '#666b71',
    confidenceColors: {
      low: '#4b5563',
      medium: '#666b71',
      high: '#8a9098',
    },
    techMatchColors: {
      good: '#6fbf92',
      bad: '#d18484',
    },
  };

  const PANEL_ID = 'job-scraper-llm-panel';
  const PANEL_POSITION_KEY = 'jobScraperLlmPanelPosition';
  const PANEL_COLLAPSED_KEY = 'jobScraperLlmPanelCollapsed';
  const VALID_WORK_TYPES = new Set(['remote', 'hybrid', 'onsite', 'unknown']);
  const VALID_PAY_TYPES = new Set(['annual', 'daily', 'hourly', 'unknown']);
  const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
  const VALID_ASSESSMENT = new Set(['good', 'bad', 'uncertain']);

  const state = {
    site: detectSite(),
    panel: null,
    content: null,
    titleElement: null,
    currentResult: null,
    currentJobText: '',
    currentError: null,
    jobTitle: '',
    assessmentStatus: 'uncertain',
    assessment: null,
    lastSignature: '',
    runId: 0,
    collapsed: Boolean(GM_getValue(PANEL_COLLAPSED_KEY, false)),
  };
  let pendingRun = 0;

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
      #${PANEL_ID} {
        position: fixed;
        top: 88px;
        right: 24px;
        width: min(380px, calc(100vw - 24px));
        max-height: calc(100vh - 120px);
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

      #${PANEL_ID}, #${PANEL_ID} * {
        box-sizing: border-box;
      }

      #${PANEL_ID}.job-scraper-llm--collapsed {
        max-height: 42px;
      }

      #${PANEL_ID} .job-scraper-llm__header {
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

      #${PANEL_ID} .job-scraper-llm__title {
        flex: 1 1 auto;
        min-width: 0;
        color: #ffffff;
        font-weight: 700;
        letter-spacing: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${PANEL_ID} .job-scraper-llm__controls {
        display: flex;
        flex: 0 0 auto;
        gap: 4px;
      }

      #${PANEL_ID} .job-scraper-llm__button {
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

      #${PANEL_ID} .job-scraper-llm__button:hover {
        background: rgba(255, 255, 255, 0.16);
      }

      #${PANEL_ID} .job-scraper-llm__button:disabled {
        cursor: default;
        opacity: 0.48;
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
          <button class="job-scraper-llm__button" type="button" data-action="copy" title="Copy summary" aria-label="Copy summary">⎘</button>
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
    const copyButton = panel.querySelector('[data-action="copy"]');
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

    copyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      copySummary();
    });

    retryButton.addEventListener('click', (event) => {
      event.stopPropagation();
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
      updateTitleTooltip();
      updateTechClampState();
    });
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

  function scheduleRun(delayMs, options = {}) {
    window.clearTimeout(pendingRun);
    pendingRun = window.setTimeout(() => {
      runExtraction(options).catch((error) => {
        renderError(toUserError(error));
      });
    }, delayMs);
  }

  async function runExtraction({ force = false } = {}) {
    const runId = ++state.runId;
    ensurePanel();
    if (force) resetJobState();
    renderLoading('Analysing...');

    try {
      await delay(350);
      if (state.site === 'linkedin') {
        renderLoading('Expanding description...');
        await ensureLinkedInDescriptionExpanded();
        renderLoading('Analysing...');
      }

      const extraction = await waitForExtraction();
      if (!extraction || !extraction.text) {
        throw userError('not_found', 'Could not find job description');
      }

      if (runId !== state.runId) return;

      const signature = `${location.href}\n${extraction.text.slice(0, 1500)}`;
      state.currentJobText = extraction.text;
      state.jobTitle = extraction.title || '';
      renderPanelTitle();

      if (!force && signature === state.lastSignature && state.currentResult) {
        applyResultState(state.currentResult);
        renderSuccess(state.currentResult);
        return;
      }

      state.lastSignature = signature;
      const result = await queryLLM(extraction.text);
      if (runId !== state.runId) return;

      state.currentResult = result;
      state.currentError = null;
      applyResultState(result);
      renderSuccess(result);
    } catch (error) {
      if (runId !== state.runId) return;

      const friendly = toUserError(error);
      state.currentResult = null;
      state.currentError = friendly;
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

    const bodyText = cleanDescriptionText(getText(body || aboutTheJob));
    if (!bodyText) return null;

    const metadata = [];
    const headerRoot =
      firstElement([
        '.job-details-jobs-unified-top-card',
        '.jobs-unified-top-card',
        '.jobs-details-top-card',
        'main',
      ]) || document.body;
    const headerText = cleanMetadataText(getText(headerRoot));
    const beforeDescription = textBeforeNeedle(headerText, 'About the job');
    const workplace = extractWorkplaceType(beforeDescription || headerText);
    const location = extractLinkedInLocation(beforeDescription || headerText);
    const salary = extractSalaryLine(beforeDescription || headerText);
    const details = extractLinkedInDetails(beforeDescription || headerText);
    const title = extractLinkedInTitle(headerRoot);

    addMetadata(metadata, 'Job Title', title);
    addMetadata(metadata, 'Workplace Type', workplace);
    addMetadata(metadata, 'Salary Insight', salary);
    addMetadata(metadata, 'Location', location);
    addMetadata(metadata, 'Job Details', details);

    return {
      bodyText,
      title,
      text: composeJobText(metadata, bodyText),
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
    const title = extractSeekTitle();
    const metadata = [];

    addMetadata(metadata, 'Job Title', title);
    addMetadata(metadata, 'Workplace Type', extractWorkplaceType(locationText));
    addMetadata(metadata, 'Salary Badge', salary);
    addMetadata(metadata, 'Work Type', workType);
    addMetadata(metadata, 'Location', stripWorkplaceSuffix(locationText));

    return {
      bodyText,
      title,
      text: composeJobText(metadata, bodyText),
    };
  }

  async function ensureLinkedInDescriptionExpanded() {
    const deadline = Date.now() + 6000;
    let attempts = 0;
    let preClickLength = 0;

    while (Date.now() < deadline) {
      const root = getLinkedInDescriptionRoot();
      const body = getLinkedInDescriptionBody(root);
      const bodyText = cleanDescriptionText(getText(body || root));
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
      resetJobState();
      scheduleRun(state.site === 'linkedin' ? 800 : 500, { force: true });
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

  function queryLLM(jdText) {
    return retryParse(async () => {
      const raw = await requestOllama(jdText);
      const parsed = parseJsonResponse(raw);
      return validateResult(parsed);
    });
  }

  async function retryParse(factory) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await factory();
      } catch (error) {
        lastError = error;
        if (error.code !== 'parse' && error.code !== 'shape') throw error;
      }
    }

    throw lastError;
  }

  function requestOllama(jdText) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${CONFIG.ollamaUrl.replace(/\/+$/, '')}/api/generate`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          model: CONFIG.model,
          prompt: buildPrompt(jdText),
          format: 'json',
          stream: false,
          options: {
            temperature: 0.1,
            num_predict: CONFIG.numPredict,
          },
        }),
        timeout: CONFIG.timeout,
        onload: (res) => {
          try {
            if (res.status < 200 || res.status >= 300) {
              reject(
                userError('offline', `Ollama returned HTTP ${res.status}`),
              );
              return;
            }

            const data = JSON.parse(res.responseText);
            resolve(
              typeof data.response === 'string'
                ? data.response
                : JSON.stringify(data.response),
            );
          } catch (error) {
            reject(
              userError(
                'parse',
                'Could not parse Ollama response',
                res.responseText,
                error,
              ),
            );
          }
        },
        onerror: () =>
          reject(userError('offline', 'LLM offline - is Ollama running?')),
        ontimeout: () => reject(userError('offline', 'LLM timeout')),
      });
    });
  }

  function buildPrompt(jdText) {
    const badCriteria = JSON.stringify(
      Array.isArray(CONFIG.bad) ? CONFIG.bad : [],
      null,
      2,
    );
    const goodCriteria = JSON.stringify(
      Array.isArray(CONFIG.good) ? CONFIG.good : [],
      null,
      2,
    );

    return `You are a job listing data extractor. Analyse the following job description and return a JSON object with exactly this shape:

{
  "jobTitle": "<job title or null>",
  "workArrangement": {
    "type": "remote" | "hybrid" | "onsite" | "unknown",
    "daysInOffice": <number or null>,
    "details": "<brief note, eg 'flexible 2-3 days per week'>",
    "confidence": "high" | "medium" | "low"
  },
  "pay": {
    "range": "<formatted string, eg '$130k-$160k + super' or null if not found>",
    "type": "annual" | "daily" | "hourly" | "unknown",
    "includesSuper": <boolean>,
    "isOTE": <boolean>,
    "confidence": "high" | "medium" | "low"
  },
  "techStack": {
    "required": ["<tech>", ...],
    "optional": ["<tech>", ...]
  },
  "fitChecks": {
    "bad": [
      {
        "criterion": "<exact bad criterion string>",
        "matches": <boolean>,
        "confidence": "high" | "medium" | "low",
        "details": "<brief evidence note>"
      }
    ],
    "good": [
      {
        "criterion": "<exact good criterion string>",
        "matches": <boolean>,
        "confidence": "high" | "medium" | "low",
        "details": "<brief evidence note>"
      }
    ]
  }
}

Bad criteria to evaluate one item at a time, in order:
${badCriteria}

Good criteria to evaluate one item at a time, in order:
${goodCriteria}

Rules:
- For jobTitle: use [Job Title] metadata if present. Otherwise infer only if the title is explicit in the text. If unclear, use null
- For fitChecks.bad: return exactly one object per bad criterion, same order, with criterion copied exactly
- For fitChecks.good: return exactly one object per good criterion, same order, with criterion copied exactly
- A fit check may be matches true with high confidence only when the listing directly and unambiguously satisfies the criterion
- If a fit criterion is absent, ambiguous, contradicted, or only weakly inferred, set matches false and confidence low or medium
- Evaluate each fit criterion independently from the raw listing. Do not infer one criterion from another
- "required": tech explicitly required of the candidate: requirements, must-have, essential, mandatory, "you have", "what you'll bring", "strong/proven experience", "expertise in", or "X+ years"
- "optional": tech under nice-to-have, preferred, desirable, bonus, advantage, familiarity, exposure, or tools/platforms merely mentioned without clear requirement
- If a heading or sentence says nice-to-have, preferred, desirable, bonus, advantage, familiarity, or exposure, every tech in that scope is optional even if it appears important
- Do not classify tech from responsibilities, product descriptions, company stack, or generic "we use" sections as required unless the candidate requirement wording is explicit
- If the same tech appears as both required and optional, include it only in required
- Order tech arrays from strongest and most prominent evidence to weakest: core role tech, title/summary tech, repeated tech, and explicit must-have tech first. Do not sort alphabetically
- For workArrangement: if the listing mentions specific days, extract the number. If conflicting signals exist, set confidence to "low" and note in details
- For pay: normalise to AUD annual where possible. If only hourly/daily is given, state the raw value and set type accordingly
- If a field cannot be determined, set it to null/unknown with confidence "low"
- Only include programming languages, frameworks, libraries, tools, platforms, and infrastructure in techStack. Do not include soft skills or methodologies
- Return ONLY the JSON object, no other text

Job description:
---
${jdText}
---`;
  }

  function parseJsonResponse(raw) {
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
    const fitChecks = {
      bad: normalizeFitChecks(input.fitChecks?.bad, CONFIG.bad),
      good: normalizeFitChecks(input.fitChecks?.good, CONFIG.good),
    };
    const assessment = buildAssessment(fitChecks);
    const result = {
      jobTitle: cleanJobTitle(input.jobTitle),
      workArrangement: {
        type: enumValue(work.type, VALID_WORK_TYPES, 'unknown'),
        daysInOffice: numberOrNull(work.daysInOffice),
        details: stringOrEmpty(work.details),
        confidence: enumValue(work.confidence, VALID_CONFIDENCE, 'low'),
      },
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
      assessment,
    };

    if (
      !input.workArrangement ||
      !input.pay ||
      !input.techStack ||
      !input.fitChecks
    ) {
      throw userError(
        'shape',
        'Model JSON missing required top-level fields',
        JSON.stringify(input, null, 2),
      );
    }

    const requiredKeys = new Set(
      result.techStack.required.map((item) => item.toLowerCase()),
    );
    result.techStack.optional = result.techStack.optional.filter(
      (item) => !requiredKeys.has(item.toLowerCase()),
    );

    return result;
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

    state.content.innerHTML = `
      <div class="job-scraper-llm__line">
        <span class="job-scraper-llm__label">Work:</span>
        ${renderWorkValue(work)}
      </div>
      <div class="job-scraper-llm__line">
        <span class="job-scraper-llm__label">Pay:</span>
        ${renderPayValue(pay)}
      </div>
      <div class="job-scraper-llm__divider"></div>
      ${renderTechLine('Required', result.techStack.required)}
      ${renderTechLine('Optional', result.techStack.optional)}
      ${renderFitCriteria(result)}
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
    return `
      <div class="job-scraper-llm__line job-scraper-llm__tech-line" data-tech-line>
        <span class="job-scraper-llm__label">${escapeHtml(label)}:</span>
        ${values.length ? values.map(renderTechItem).join(', ') : 'None found'}
      </div>
    `;
  }

  function renderTechItem(value) {
    const text = cleanMetadataText(value);
    const kind = techMatchKind(text);
    const color = kind ? cleanMetadataText(CONFIG.techMatchColors?.[kind]) : '';
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
    const textStyle =
      item.active && color ? ` style="color: ${escapeHtml(color)}"` : '';
    const details = cleanMetadataText(item.check.details);
    const title = details ? ` title="${escapeHtml(details)}"` : '';
    const confidence = renderConfidenceSymbol(
      item.check.confidence,
      item.check.confidence !== 'high',
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
      line.setAttribute('title', 'Click to expand');
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
    line.setAttribute(
      'title',
      expanded ? 'Click to collapse' : 'Click to expand',
    );
  }

  function renderWorkValue(work) {
    return `${escapeHtml(workText(work))}${renderConfidenceSymbol(work?.confidence, hasWorkValue(work))}`;
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
    const lines = [
      `Title: ${state.jobTitle || result.jobTitle || 'Unknown'}`,
      `Fit: ${formatAssessmentTitle(result.assessment)}`,
      `Work: ${formatWork(result.workArrangement)}`,
      `Pay: ${formatPay(result.pay)}`,
      '',
      'Tech:',
      `Required: ${result.techStack.required.join(', ') || 'None found'}`,
      `Optional: ${result.techStack.optional.join(', ') || 'None found'}`,
    ];

    return lines.join('\n');
  }

  function workText(work) {
    const rawType = work?.type || 'unknown';
    const type =
      rawType === 'onsite'
        ? 'Onsite'
        : rawType.charAt(0).toUpperCase() + rawType.slice(1);
    const days =
      rawType === 'hybrid' && Number.isFinite(work?.daysInOffice)
        ? ` ${work.daysInOffice}d`
        : '';

    return `${type}${days}`;
  }

  function payText(pay) {
    return pay.range || 'Not found';
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

  function techMatchKind(value) {
    if (regexListMatches(CONFIG.badTech, value)) return 'bad';
    if (regexListMatches(CONFIG.goodTech, value)) return 'good';
    return '';
  }

  function regexListMatches(patterns, value) {
    const text = String(value || '');
    if (!text || !Array.isArray(patterns)) return false;

    for (const pattern of patterns) {
      const source = cleanMetadataText(pattern);
      if (!source) continue;

      try {
        if (new RegExp(source, 'i').test(text)) return true;
      } catch {}
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
        if (!hasFitCriterionData(check)) continue;

        items.push({
          kind,
          check,
          active:
            verdict === kind && check.matches && check.confidence === 'high',
        });
      }
    }

    return items;
  }

  function hasFitCriterionData(check) {
    return Boolean(check?.matches || cleanMetadataText(check?.details));
  }

  function resetJobState() {
    state.currentResult = null;
    state.currentJobText = '';
    state.currentError = null;
    state.jobTitle = '';
    state.assessmentStatus = 'uncertain';
    state.assessment = null;
    state.lastSignature = '';
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
    const criteria = (Array.isArray(prompts) ? prompts : [])
      .map((item) => cleanMetadataText(item))
      .filter(Boolean);
    const checks = Array.isArray(value) ? value : [];

    return criteria.map((criterion, index) => {
      const matchingCheck =
        checks.find(
          (item) =>
            cleanMetadataText(item?.criterion).toLowerCase() ===
            criterion.toLowerCase(),
        ) ||
        checks[index] ||
        {};

      return {
        criterion,
        matches:
          matchingCheck.matches === true ||
          String(matchingCheck.matches).toLowerCase() === 'true',
        confidence: enumValue(
          matchingCheck.confidence,
          VALID_CONFIDENCE,
          'low',
        ),
        details: stringOrEmpty(matchingCheck.details),
      };
    });
  }

  function buildAssessment(fitChecks) {
    const badMatch = fitChecks.bad.find(
      (check) => check.matches && check.confidence === 'high',
    );
    if (badMatch) {
      return {
        status: 'bad',
        reason: `Bad: ${badMatch.criterion}`,
        match: badMatch,
      };
    }

    const goodMatch = fitChecks.good.find(
      (check) => check.matches && check.confidence === 'high',
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

  function composeJobText(metadata, bodyText) {
    const metadataText = metadata.filter(Boolean).join('\n');
    return metadataText ? `${metadataText}\n---\n${bodyText}` : bodyText;
  }

  function addMetadata(lines, label, value) {
    const text = cleanMetadataText(value);
    if (text) lines.push(`[${label}]: ${text}`);
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

  function extractSalaryLine(text) {
    const lines = cleanMetadataText(text).split('\n');
    const salaryLine = lines.find(
      (line) =>
        /(\$|salary|compensation|base pay|pay range|super)/i.test(line) &&
        !/salary match/i.test(line),
    );

    return salaryLine || '';
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

    if (error?.code === 'parse' || error?.code === 'shape') {
      return userError(error.code, 'Parse error', error.raw || '', error);
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
