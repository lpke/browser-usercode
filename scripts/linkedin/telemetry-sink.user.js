// ==UserScript==
// @name         LinkedIn telemetry sink
// @namespace    local
// @version      1.0.0
// @description  Sink LinkedIn tracking, RUM, client-sensor, and anti-abuse telemetry that creates blocked-request retry noise.
// @match        https://www.linkedin.com/*
// @match        https://linkedin.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BLOCKED_RETRY_DATABASES = [
    'beacons',
    'beacon-transporter',
    'idb-queue',
  ];
  const BLOCKED_NODE_URL = Symbol('linkedinTelemetrySinkBlockedUrl');

  const getUrl = (input) => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && input.url;

    if (!raw) return null;

    try {
      return new URL(raw, location.href);
    } catch {
      return null;
    }
  };

  const isLinkedInTrackingHost = (hostname) =>
    /(^|\.)linkedin(-ei)?\.com$/i.test(hostname) ||
    /(^|\.)linkedin\.cn$/i.test(hostname);

  const isMerchantpoolHost = (hostname) =>
    /^merchantpool\d*\.linkedin\.com$/i.test(hostname);

  const sinkKind = (input) => {
    const url = getUrl(input);
    if (!url) return null;

    if (url.protocol === 'chrome-extension:') {
      return 'extension-probe';
    }

    if (isMerchantpoolHost(url.hostname)) {
      return 'dfp-fingerprint';
    }

    if (url.hostname === 'li.protechts.net') {
      return 'human-fingerprint';
    }

    if (!isLinkedInTrackingHost(url.hostname)) {
      return null;
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (
      path === '/li/track' ||
      path === '/li/track/validate' ||
      path === '/li/tscp/sct'
    ) {
      return 'tracking';
    }

    if (path === '/platform-telemetry/li/apfcDf' || path === '/apfc/collect') {
      return 'apfc';
    }

    if (
      path === '/sensorCollect' &&
      url.searchParams.get('action') === 'reportMetrics'
    ) {
      return 'client-sensor';
    }

    if (
      path === '/realtime/realtimeFrontendClientConnectivityTracking' &&
      url.searchParams.get('action') === 'sendHeartbeat'
    ) {
      return 'realtime-heartbeat';
    }

    return null;
  };

  const shouldSink = (input) => Boolean(sinkKind(input));

  const shouldBlockElementLoad = (input) => {
    const kind = sinkKind(input);
    return kind === 'dfp-fingerprint' || kind === 'human-fingerprint';
  };

  const noContentResponse = () =>
    new Response(null, {
      status: 204,
      statusText: 'No Content',
    });

  const rejectExtensionProbe = () =>
    Promise.reject(new TypeError('Failed to fetch'));

  const fakeFetchResponse = (kind) => {
    if (kind === 'extension-probe') {
      return rejectExtensionProbe();
    }

    return Promise.resolve(noContentResponse());
  };

  const defer =
    typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (callback) => Promise.resolve().then(callback);

  const makeEvent = (name) => {
    try {
      return new Event(name);
    } catch {
      const event = document.createEvent('Event');
      event.initEvent(name, false, false);
      return event;
    }
  };

  const defineOwn = (target, property, value) => {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        get: () => value,
      });
    } catch {}
  };

  const completeSunkXhr = (xhr) => {
    defineOwn(xhr, 'readyState', 4);
    defineOwn(xhr, 'status', 204);
    defineOwn(xhr, 'statusText', 'No Content');
    defineOwn(xhr, 'response', '');
    defineOwn(xhr, 'responseText', '');
    defineOwn(xhr, 'responseURL', xhr.__linkedinTelemetrySinkUrl || '');

    for (const name of ['readystatechange', 'load', 'loadend']) {
      try {
        xhr.dispatchEvent(makeEvent(name));
      } catch {}
    }
  };

  const clearRetryDatabases = () => {
    if (!window.indexedDB) return;

    for (const name of BLOCKED_RETRY_DATABASES) {
      try {
        indexedDB.deleteDatabase(name);
      } catch {}
    }
  };

  clearRetryDatabases();

  const nativeFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    const kind = sinkKind(input);

    if (kind) {
      return fakeFetchResponse(kind);
    }

    return nativeFetch.apply(this, arguments);
  };

  const nativeSendBeacon = navigator.sendBeacon;
  if (nativeSendBeacon) {
    try {
      navigator.sendBeacon = function patchedSendBeacon(url, data) {
        if (shouldSink(url)) {
          return true;
        }

        return nativeSendBeacon.apply(this, arguments);
      };
    } catch {}
  }

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const nativeXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    const kind = sinkKind(url);

    if (kind) {
      this.__linkedinTelemetrySinkKind = kind;
      this.__linkedinTelemetrySinkUrl = String(url);
      defineOwn(this, 'readyState', 1);
      return;
    }

    return nativeXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(
    name,
    value,
  ) {
    if (this.__linkedinTelemetrySinkKind) {
      return;
    }

    return nativeXhrSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (this.__linkedinTelemetrySinkKind) {
      defer(() => completeSunkXhr(this));
      return;
    }

    return nativeXhrSend.apply(this, arguments);
  };

  const markBlockedNodeUrl = (node, value) => {
    node[BLOCKED_NODE_URL] = String(value);
  };

  const getNodeUrl = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;

    return (
      node[BLOCKED_NODE_URL] ||
      node.getAttribute('src') ||
      node.getAttribute('href')
    );
  };

  const isBlockedLoadNode = (node) => shouldBlockElementLoad(getNodeUrl(node));

  const patchSrcProperty = (Ctor) => {
    const proto = Ctor && Ctor.prototype;
    if (!proto) return;

    const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!descriptor || !descriptor.set || !descriptor.get) return;

    try {
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return descriptor.get.call(this);
        },
        set(value) {
          if (shouldBlockElementLoad(value)) {
            markBlockedNodeUrl(this, value);
            return;
          }

          descriptor.set.call(this, value);
        },
      });
    } catch {}
  };

  patchSrcProperty(window.HTMLScriptElement);
  patchSrcProperty(window.HTMLIFrameElement);
  patchSrcProperty(window.HTMLImageElement);

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSetAttribute(name, value) {
    if (String(name).toLowerCase() === 'src' && shouldBlockElementLoad(value)) {
      markBlockedNodeUrl(this, value);
      return;
    }

    return nativeSetAttribute.apply(this, arguments);
  };

  const nativeAppendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function patchedAppendChild(node) {
    if (isBlockedLoadNode(node)) {
      return node;
    }

    return nativeAppendChild.apply(this, arguments);
  };

  const nativeInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function patchedInsertBefore(node, child) {
    if (isBlockedLoadNode(node)) {
      return node;
    }

    return nativeInsertBefore.apply(this, arguments);
  };
})();
