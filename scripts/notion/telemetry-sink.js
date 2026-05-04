// ==UserScript==
// @name         Notion telemetry sink
// @namespace    local
// @version      1.2.0
// @description  Sink Notion Amplitude/EventTrail, Statsig, and Sentry telemetry that causes blocked-request retry noise.
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const getUrl = input => {
    const raw = typeof input === "string" ? input : input && input.url;
    if (!raw) return null;

    try {
      return new URL(raw, location.href);
    } catch {
      return null;
    }
  };

  const sinkKind = input => {
    const url = getUrl(input);
    if (!url) return null;

    if (
      (url.hostname === "www.notion.so" || url.hostname === "notion.so") &&
      url.pathname === "/api/v3/etClient"
    ) {
      return "amplitude";
    }

    if (url.hostname === "exp.notion.so" && url.pathname === "/v1/rgstr") {
      return "statsig-events";
    }

    if (url.hostname === "exp.notion.so" && url.pathname === "/v1/initialize") {
      return "statsig-init";
    }

    if (/\.ingest\.sentry\.io$/.test(url.hostname) && url.pathname.includes("/envelope/")) {
      return "sentry";
    }

    return null;
  };

  const jsonResponse = body =>
    new Response(JSON.stringify(body), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json" },
    });

  const fakeTelemetryResponse = () =>
    jsonResponse({
      code: 200,
      events_ingested: 999,
      payload_size_bytes: 0,
      server_upload_time: Date.now(),
    });

  const noContentResponse = () =>
    new Response(null, {
      status: 204,
      statusText: "No Content",
    });

  const okEmptyResponse = () =>
    new Response("", {
      status: 200,
      statusText: "OK",
    });

  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (
        /^AMP_/i.test(key) ||
        /^amp_/i.test(key) ||
        /^amplitude_/i.test(key) ||
        /^statsig\.failed_logs\./i.test(key)
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {}

  const nativeFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    const kind = sinkKind(input);

    if (kind === "statsig-init") {
      return Promise.resolve(noContentResponse());
    }

    if (kind === "sentry") {
      return Promise.resolve(okEmptyResponse());
    }

    if (kind) {
      return Promise.resolve(fakeTelemetryResponse());
    }

    return nativeFetch.apply(this, arguments);
  };

  const nativeSendBeacon = navigator.sendBeacon;
  if (nativeSendBeacon) {
    navigator.sendBeacon = function patchedSendBeacon(url, data) {
      if (sinkKind(url)) {
        return true;
      }

      return nativeSendBeacon.apply(this, arguments);
    };
  }
})();
