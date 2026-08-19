// ==UserScript==
// @name         Cloudflare deployment log guard
// @namespace    local
// @version      2.0.1
// @description  Prevent Cloudflare Pages deployment logs from freezing the dashboard while preserving full-log downloads.
// @match        https://dash.cloudflare.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const SCRIPT_NAME = "Cloudflare deployment log guard";
  const PREVIEW_BUTTON_ID = "violentmonkey-cloudflare-log-preview";
  const PREVIEW_LINE_LIMIT = 500;
  const PREVIEW_BYTE_LIMIT = 64 * 1024 * 1024;
  const PAGE_ROUTE =
    /^\/([0-9a-f]{32})\/pages\/view\/([^/]+)\/([0-9a-f-]{36})\/?$/i;
  const LOG_ENDPOINT =
    /\/accounts\/[^/]+\/pages\/projects\/[^/]+\/deployments\/[^/]+\/history\/logs(?:\?|$)/i;
  const BLOCKED_MESSAGE = `LOG LOADING BLOCKED BY VIOLENTMONKEY SCRIPT ${SCRIPT_NAME}`;

  const NativeXMLHttpRequest = window.XMLHttpRequest;
  const xhrPrototype = NativeXMLHttpRequest.prototype;
  const nativeXhrOpen = xhrPrototype.open;
  const nativeXhrSend = xhrPrototype.send;
  const nativeXhrSetRequestHeader = xhrPrototype.setRequestHeader;
  const nativeFetch = window.fetch.bind(window);
  const xhrMetadata = new WeakMap();
  const requestByPage = new Map();

  const currentPage = () => {
    const match = location.pathname.match(PAGE_ROUTE);
    if (!match) return null;

    return {
      accountId: match[1],
      projectName: match[2],
      deploymentId: match[3],
      key: `${match[2]}/${match[3]}`,
    };
  };

  const previewKey = (pageKey) =>
    `violentmonkey:${SCRIPT_NAME}:v2:preview:${pageKey}`;

  const previewEnabled = (pageKey) =>
    sessionStorage.getItem(previewKey(pageKey)) === "true";

  const requestUrl = (input) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input?.url;

    try {
      return raw ? new URL(raw, location.href) : null;
    } catch {
      return null;
    }
  };

  const isDeploymentLogRequest = (input) => {
    const url = requestUrl(input);
    return Boolean(url && LOG_ENDPOINT.test(url.pathname + url.search));
  };

  const blockedPayload = (message = BLOCKED_MESSAGE) => ({
    result: {
      data: [
        {
          ts: new Date().toISOString(),
          line: message,
        },
      ],
    },
    success: true,
    errors: [],
    messages: [],
  });

  const payloadEntries = (payload) => {
    if (Array.isArray(payload?.result?.data)) return payload.result.data;
    if (Array.isArray(payload?.data)) return payload.data;
    return null;
  };

  const cappedPayloadText = (text) => {
    if (text.length > PREVIEW_BYTE_LIMIT) {
      throw new Error(
        `response exceeded ${Math.round(PREVIEW_BYTE_LIMIT / 1024 / 1024)} MB`,
      );
    }

    const payload = JSON.parse(text);
    const entries = payloadEntries(payload);
    if (!entries) throw new Error("Cloudflare returned an unknown log format");

    const omitted = Math.max(0, entries.length - PREVIEW_LINE_LIMIT);
    if (omitted > 0) {
      const retained = entries.slice(-PREVIEW_LINE_LIMIT);
      retained.unshift({
        ts: retained[0]?.ts || new Date().toISOString(),
        line: `[Violentmonkey] ${omitted.toLocaleString()} earlier lines omitted. Showing the last ${PREVIEW_LINE_LIMIT.toLocaleString()} lines.`,
      });
      entries.splice(0, entries.length, ...retained);
    }

    return JSON.stringify(payload);
  };

  const defineValue = (target, property, value) => {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        get: () => value,
      });
    } catch {}
  };

  const dispatchXhrCompletion = (xhr, text, status = 200) => {
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}

    defineValue(xhr, "readyState", 4);
    defineValue(xhr, "status", status);
    defineValue(xhr, "statusText", status === 200 ? "OK" : "Error");
    defineValue(xhr, "responseText", text);
    defineValue(xhr, "response", xhr.responseType === "json" ? payload : text);

    try {
      Object.defineProperty(xhr, "getResponseHeader", {
        configurable: true,
        value: (name) =>
          name.toLowerCase() === "content-type" ? "application/json" : null,
      });
      Object.defineProperty(xhr, "getAllResponseHeaders", {
        configurable: true,
        value: () => "content-type: application/json\r\n",
      });
    } catch {}

    for (const eventName of ["readystatechange", "load", "loadend"]) {
      try {
        xhr.dispatchEvent(new Event(eventName));
      } catch {}
    }
  };

  const loadXhrText = (request) =>
    new Promise((resolve, reject) => {
      const transport = new NativeXMLHttpRequest();
      nativeXhrOpen.call(
        transport,
        request.method,
        request.url,
        true,
        request.username,
        request.password,
      );
      transport.withCredentials = request.withCredentials;
      transport.timeout = request.timeout;

      for (const [name, value] of request.headers) {
        nativeXhrSetRequestHeader.call(transport, name, value);
      }

      transport.addEventListener("load", () => {
        if (transport.status >= 200 && transport.status < 300) {
          resolve(transport.responseText);
        } else {
          reject(new Error(`Cloudflare returned HTTP ${transport.status}`));
        }
      });
      transport.addEventListener("error", () =>
        reject(new Error("Cloudflare log request failed")),
      );
      transport.addEventListener("timeout", () =>
        reject(new Error("Cloudflare log request timed out")),
      );
      nativeXhrSend.call(transport, request.body);
    });

  const reusableFetchRequest = (input, init) => {
    const source = input instanceof Request ? input : null;
    return {
      input: requestUrl(input).href,
      init: {
        method: init?.method || source?.method || "GET",
        headers: new Headers(init?.headers || source?.headers),
        credentials: init?.credentials || source?.credentials,
        mode: init?.mode || source?.mode,
        cache: init?.cache || source?.cache,
        redirect: init?.redirect || source?.redirect,
        referrer: init?.referrer || source?.referrer,
        referrerPolicy: init?.referrerPolicy || source?.referrerPolicy,
      },
    };
  };

  const loadFetchText = async (request) => {
    const response = await nativeFetch(request.input, request.init);
    if (!response.ok) {
      throw new Error(`Cloudflare returned HTTP ${response.status}`);
    }
    return response.text();
  };

  const rememberRequest = (pageKey, request) => {
    requestByPage.set(pageKey, request);
  };

  window.fetch = async function guardedFetch(input, init) {
    const page = currentPage();
    if (!page || !isDeploymentLogRequest(input)) {
      return nativeFetch(input, init);
    }

    const request = reusableFetchRequest(input, init);
    rememberRequest(page.key, {
      loadText: () => loadFetchText(request),
    });

    if (!previewEnabled(page.key)) {
      return new Response(JSON.stringify(blockedPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    try {
      const text = await loadFetchText(request);
      return new Response(cappedPayloadText(text), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify(
          blockedPayload(
            `SAFE LOG PREVIEW STOPPED BY ${SCRIPT_NAME}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
  };

  xhrPrototype.open = function guardedOpen(
    method,
    url,
    async = true,
    username,
    password,
  ) {
    xhrMetadata.set(this, {
      method,
      url: requestUrl(url)?.href || String(url),
      async,
      username,
      password,
      headers: [],
      body: null,
    });
    return nativeXhrOpen.apply(this, arguments);
  };

  xhrPrototype.setRequestHeader = function guardedSetRequestHeader(
    name,
    value,
  ) {
    const metadata = xhrMetadata.get(this);
    metadata?.headers.push([name, value]);
    return nativeXhrSetRequestHeader.apply(this, arguments);
  };

  xhrPrototype.send = function guardedSend(body) {
    const page = currentPage();
    const metadata = xhrMetadata.get(this);
    if (!page || !metadata || !isDeploymentLogRequest(metadata.url)) {
      return nativeXhrSend.apply(this, arguments);
    }

    const request = {
      ...metadata,
      body,
      withCredentials: this.withCredentials,
      timeout: this.timeout,
    };
    rememberRequest(page.key, {
      loadText: () => loadXhrText(request),
    });

    if (!previewEnabled(page.key)) {
      queueMicrotask(() =>
        dispatchXhrCompletion(this, JSON.stringify(blockedPayload())),
      );
      return;
    }

    loadXhrText(request)
      .then(cappedPayloadText)
      .then((text) => dispatchXhrCompletion(this, text))
      .catch((error) =>
        dispatchXhrCompletion(
          this,
          JSON.stringify(
            blockedPayload(
              `SAFE LOG PREVIEW STOPPED BY ${SCRIPT_NAME}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        ),
      );
  };

  const downloadText = (text, filename) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const downloadFullLog = async (button) => {
    const page = currentPage();
    const request = page && requestByPage.get(page.key);
    if (!page || !request) {
      window.alert(
        "The log request is not available yet. Reload and try again.",
      );
      return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Downloading…";

    try {
      const payload = JSON.parse(await request.loadText());
      const entries = payloadEntries(payload);
      if (!entries)
        throw new Error("Cloudflare returned an unknown log format");

      const text = entries
        .map((entry) => `${entry.ts || ""}\t${entry.line || ""}`)
        .join("\n");
      downloadText(text, `${page.projectName}.${page.deploymentId}.log`);
    } catch (error) {
      window.alert(
        `Log download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  };

  const isNativeDownloadButton = (button) =>
    button &&
    button.closest('[data-sentry-component="KumoBuildLogCard"]') &&
    button.textContent.trim() === "Download log";

  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.("button");
      if (!isNativeDownloadButton(button)) return;

      const page = currentPage();
      if (!page || !requestByPage.has(page.key)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      downloadFullLog(button);
    },
    true,
  );

  const setPreview = (enabled) => {
    const page = currentPage();
    if (!page) return;

    if (enabled) sessionStorage.setItem(previewKey(page.key), "true");
    else sessionStorage.removeItem(previewKey(page.key));
    location.reload();
  };

  const installPreviewButton = () => {
    const page = currentPage();
    if (!page) return;

    const downloadButton = [...document.querySelectorAll("button")].find(
      isNativeDownloadButton,
    );
    if (!downloadButton) return;

    const enabled = previewEnabled(page.key);
    let button = document.getElementById(PREVIEW_BUTTON_ID);
    if (!button) {
      button = document.createElement("button");
      button.id = PREVIEW_BUTTON_ID;
      button.type = "button";
      button.className = downloadButton.className;
      downloadButton.before(button);
    }

    const label = enabled ? "Block log rendering" : "Load safe preview";
    if (button.textContent !== label) button.textContent = label;
    button.onclick = () => setPreview(!enabled);
  };

  const replaceBlockedPlaceholder = () => {
    const page = currentPage();
    if (!page || previewEnabled(page.key)) return;

    const code = document.querySelector(
      '[data-sentry-component="KumoBuildLogCard"] .kumo-shiki code',
    );
    if (
      !code ||
      !/^Getting things ready(?:…|\.\.\.)$/.test(code.textContent.trim())
    ) {
      return;
    }

    code.textContent = BLOCKED_MESSAGE;
  };

  const refreshUi = () => {
    installPreviewButton();
    replaceBlockedPlaceholder();
  };

  const startObserver = () => {
    const observer = new MutationObserver(refreshUi);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    refreshUi();
  };

  if (document.documentElement) startObserver();
  else
    document.addEventListener("DOMContentLoaded", startObserver, {
      once: true,
    });
})();
