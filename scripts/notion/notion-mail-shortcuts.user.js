// ==UserScript==
// @name         Notion Mail compose shortcut blocker
// @namespace    local
// @version      2.0.0
// @description  Block Notion Mail's C compose shortcut, including the Ctrl/Cmd+C compose leak, while preserving normal copy.
// @match        https://mail.notion.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  let enabled = true;
  let blockedCount = 0;
  let lastBlocked = null;
  const installedTargets = new WeakSet();

  function isEditableTarget(target) {
    if (
      !target ||
      target.nodeType !== Node.ELEMENT_NODE ||
      typeof target.closest !== 'function'
    ) {
      return false;
    }

    return Boolean(
      target.closest(
        'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
      ),
    );
  }

  function isCKey(event) {
    return (
      String(event.key || '').toLowerCase() === 'c' || event.code === 'KeyC'
    );
  }

  function shouldBlockComposeShortcut(event) {
    if (
      !enabled ||
      event.type !== 'keydown' ||
      !isCKey(event) ||
      event.altKey
    ) {
      return false;
    }

    const copyChord = (event.ctrlKey || event.metaKey) && !event.shiftKey;
    const plainCompose =
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !isEditableTarget(event.target);

    return copyChord || plainCompose;
  }

  function blockComposeShortcut(event) {
    if (!shouldBlockComposeShortcut(event)) return;

    blockedCount += 1;
    lastBlocked = {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      target: event.target && event.target.nodeName,
      time: new Date().toISOString(),
    };

    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function installTarget(target) {
    if (
      !target ||
      installedTargets.has(target) ||
      typeof target.addEventListener !== 'function'
    ) {
      return;
    }

    installedTargets.add(target);
    target.addEventListener('keydown', blockComposeShortcut, true);
  }

  function installDocument(doc) {
    if (!doc) return;

    installTarget(doc.defaultView);
    installTarget(doc);
  }

  function installIframes(root = document) {
    if (!root.querySelectorAll) return;

    for (const iframe of root.querySelectorAll('iframe')) {
      try {
        installDocument(iframe.contentDocument);
        iframe.addEventListener(
          'load',
          () => installDocument(iframe.contentDocument),
          true,
        );
      } catch {}
    }
  }

  function observeIframes() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.tagName === 'IFRAME') {
            try {
              installDocument(node.contentDocument);
              node.addEventListener(
                'load',
                () => installDocument(node.contentDocument),
                true,
              );
            } catch {}
          } else {
            installIframes(node);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  window.notionMailComposeShortcutBlocker = {
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    status() {
      return {
        enabled,
        blockedCount,
        lastBlocked,
      };
    },
  };

  installDocument(document);

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        installIframes();
        observeIframes();
      },
      { once: true },
    );
  } else {
    installIframes();
    observeIframes();
  }
})();
