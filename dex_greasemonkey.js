// ==UserScript==
// @name         Dex Pair Clipboard & Tool Links
// @namespace    http://example.com/
// @version      2.0
// @description  Copy Solana DEX pair/token addresses, open GMGN/pump.fun/Twitter/Telegram links, hide unwanted coins, attach custom labels/notes, and export token data to a .txt file.
// @match        *://dexscreener.com/*
// @match        *://*.dexscreener.com/*
// @match        *://gmgn.ai/*
// @match        *://*.gmgn.ai/*
// @match        *://pump.fun/*
// @match        *://solscan.io/*
// @match        *://*.solscan.io/*
// @match        *://dextools.io/*
// @match        *://*.dextools.io/*
// @match        *://birdeye.so/*
// @match        *://*.birdeye.so/*
// @connect      api.dexscreener.com
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // Constants
    // ================================================================

    const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const SOL_SCAN_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

    const PAIR_PATH_RE =
        /^\/solana\/(?:token\/)?([A-Za-z0-9]{32,44})(?:\/|$)/;

    const PAIR_HREF_RE =
        /\/solana\/(?:token\/)?([A-Za-z0-9]{32,44})(?:\/|[?#].*)?$/;

    const ANY_ADDRESS_RE =
        /([A-Za-z0-9]{32,44})/;

    const CACHE_KEY = 'dex-enhance-pair-info-cache';
    const HIDDEN_KEY = 'dex-enhance-hidden-pairs';
    const LABELS_KEY = 'dex-enhance-pair-labels';

    const OPEN_TAB_PREFIX = 'dex-screener-open-tab:';

    const CACHE_TTL = 5 * 60 * 1000;

    // ================================================================
    // OPEN TAB SETTINGS
    // ================================================================
    //
    // Background browser tabs can have their JavaScript timers heavily
    // throttled. A 5-second heartbeat can therefore sometimes become
    // delayed for much longer than 15 seconds.
    //
    // 2 minutes gives the heartbeat plenty of room while still allowing
    // genuinely closed/crashed tabs to disappear reasonably quickly.
    //
    const OPEN_TAB_HEARTBEAT_MS = 5000;
    const OPEN_TAB_STALE_MS = 2 * 60 * 1000;
    const OPEN_TAB_CLEANUP_MS = 15000;

    const ORPHAN_WRAPPER_GRACE_MS = 2500;

    // Delay used after DexScreener adds/replaces rows.
    const SCAN_DELAY = 500;

    // Minimum interval between expensive list scans.
    const MIN_SCAN_INTERVAL = 250;

    const INJECTED_SELECTOR =
        '#dex-header-quick-links, ' +
        '[data-dex-copy-wrapper="1"], ' +
        '#dex-pair-clipboard-overlay, ' +
        '#dex-label-popup';

    const DEFAULT_LABEL_COLOR = '#ffd54f';

    const LABEL_COLORS = [
        '#ffd54f',
        '#81c784',
        '#64b5f6',
        '#e57373',
        '#ba68c8',
        '#ffb74d',
        '#4db6ac',
        '#bdbdbd'
    ];

    const LABEL_PRESETS = [
        { text: 'good', color: '#81c784' },
        { text: 'bad', color: '#e57373' },
        { text: 'scam', color: '#ffb74d' },
        { text: 're-entry', color: '#ba68c8' }
    ];

    const MAX_LABEL_LEN = 80;

    // ================================================================
    // Small helpers
    // ================================================================

    const enc = encodeURIComponent;

    const storage = {
        get(key) {
            try {
                return localStorage.getItem(key);
            } catch {
                return null;
            }
        },

        set(key, value) {
            try {
                localStorage.setItem(key, value);
            } catch (e) {
                console.warn(
                    'localStorage write failed:',
                    key,
                    e
                );
            }
        },

        remove(key) {
            try {
                localStorage.removeItem(key);
            } catch (e) {
                console.warn(
                    'localStorage remove failed:',
                    key,
                    e
                );
            }
        }
    };

    function debounce(fn, delay = 200) {
        let timer = null;

        return (...args) => {
            if (timer) {
                clearTimeout(timer);
            }

            timer = setTimeout(() => {
                timer = null;
                fn(...args);
            }, delay);
        };
    }

    async function mapWithConcurrency(items, limit, iterator) {
        const results = new Array(items.length);
        let index = 0;

        const workers = Array.from(
            {
                length: Math.max(
                    1,
                    Math.min(limit, items.length)
                )
            },
            async () => {
                while (index < items.length) {
                    const current = index++;

                    try {
                        results[current] = {
                            ok: true,
                            value: await iterator(
                                items[current],
                                current
                            )
                        };
                    } catch (error) {
                        results[current] = {
                            ok: false,
                            error
                        };
                    }
                }
            }
        );

        await Promise.all(workers);

        return results;
    }

    const firstMatch = selectors => {
        for (const selector of selectors) {
            const el = document.querySelector(selector);

            if (el) {
                return el;
            }
        }

        return null;
    };

    // ================================================================
    // Address helpers
    // ================================================================

    function normalizeSolanaAddress(address) {
        if (typeof address !== 'string' || !address) {
            return null;
        }

        const cleaned = address.trim();

        if (SOL_RE.test(cleaned)) {
            return cleaned;
        }

        if (cleaned.length > 44) {
            const candidate = cleaned.slice(0, 44);

            if (SOL_RE.test(candidate)) {
                return candidate;
            }
        }

        return cleaned.match(SOL_SCAN_RE)?.[0] || null;
    }

    const getPrimaryAddress = pair =>
        normalizeSolanaAddress(
            pair?.baseToken?.address ||
            pair?.pairAddress ||
            ''
        );

    function requirePrimaryAddress(pair) {
        const address = getPrimaryAddress(pair);

        if (!address) {
            throw new Error(
                'No valid token address found for this pair'
            );
        }

        return address;
    }

    function buildResult(pairs, mode = 'tokens') {
        return [...pairs.values()]
            .map(entry => {
                if (mode === 'contracts') {
                    return (
                        entry.pairAddress ||
                        entry.tokenAddress
                    );
                }

                const address =
                    entry.tokenAddress ||
                    entry.pairAddress;

                if (!address) {
                    return '';
                }

                if (mode === 'labels') {
                    return entry.label
                        ? `${address}\t${entry.label}`
                        : address;
                }

                return address;
            })
            .filter(Boolean)
            .join('\n');
    }

    // ================================================================
    // Site / URL helpers
    // ================================================================

    const isDexscreenerHost = () =>
        /(^|\.)dexscreener\.com$/.test(
            location.hostname
        );

    function getPairIdFromPath(pathname) {
        if (!pathname) {
            return null;
        }

        return (
            pathname.match(PAIR_PATH_RE)?.[1] ||
            null
        );
    }

    function getPairIdFromHref(href) {
        if (!href) {
            return null;
        }

        try {
            const fromPath = getPairIdFromPath(
                new URL(href, location.origin).pathname
            );

            if (fromPath) {
                return fromPath;
            }
        } catch {
            // Fall through to regex.
        }

        return href.match(PAIR_HREF_RE)?.[1] || null;
    }

    const getAddressFromHref = href =>
        href?.match(ANY_ADDRESS_RE)?.[1] || null;

    const getDetailPairId = () =>
        getPairIdFromPath(location.pathname);

    const isDetailPage = () =>
        Boolean(getDetailPairId());

    // ================================================================
    // DOM helpers
    // ================================================================

    const getCopyWrapper = anchor => {
        const next = anchor?.nextElementSibling;

        return next?.dataset?.dexCopyWrapper === '1'
            ? next
            : null;
    };

    const getRowFromAnchor = anchor =>
        anchor
            ? (
                anchor.closest?.(
                    'a.ds-dex-table-row'
                ) || anchor
            )
            : null;

    function isSelfMutation(record) {
        if (
            record.target?.closest?.(
                INJECTED_SELECTOR
            )
        ) {
            return true;
        }

        return [
            ...record.addedNodes,
            ...record.removedNodes
        ].some(
            node =>
                node.nodeType === 1 &&
                node.closest?.(INJECTED_SELECTOR)
        );
    }

    const getMutationRoot = () =>
        firstMatch([
            '.ds-dex-table',
            '[data-testid="pairs-scrollable"]',
            '.scroller',
            '.pair-list',
            'main',
            '#app'
        ]) ||
        document.querySelector(
            'a.ds-dex-table-row'
        )?.parentElement ||
        document.body;

    const getDetailRoot = () =>
        firstMatch([
            '.pair-right-panel',
            '.pair-info',
            '.pair-details',
            '.pair-header',
            '.detail-page__header',
            '.pair-page-header',
            '.details-panel',
            '.page-right',
            '.right-panel',
            'aside',
            'main',
            'body'
        ]) ||
        document.querySelector(
            'h1, h2, .pair-name, .title'
        )?.parentElement ||
        document.body;

    function getHeaderRoot() {
        for (
            const el of document.querySelectorAll(
                'th, div, span'
            )
        ) {
            if (
                el.textContent
                    ?.trim()
                    .toUpperCase() !== 'TOKEN'
            ) {
                continue;
            }

            const row =
                el.closest('tr') ||
                el.closest(
                    '.table-header, .header, .row, .pair-list, .ds-dex-table'
                );

            if (row) {
                return row;
            }
        }

        return (
            firstMatch([
                'thead',
                '.ds-dex-table',
                '.pair-list',
                '.scroller',
                'main'
            ]) || document.body
        );
    }

    // ================================================================
    // Toast / clipboard
    // ================================================================

    let toastTimer = null;

    function showToast(message, duration = 1800) {
        document
            .getElementById('dex-pair-toast')
            ?.remove();

        if (toastTimer) {
            clearTimeout(toastTimer);
        }

        const toast =
            document.createElement('div');

        toast.id = 'dex-pair-toast';
        toast.textContent = message;

        document.body.appendChild(toast);

        toastTimer = setTimeout(() => {
            toast.remove();
            toastTimer = null;
        }, duration);
    }

    function writeClipboard(text) {
        if (
            typeof GM_setClipboard ===
            'function'
        ) {
            GM_setClipboard(text);
            return Promise.resolve();
        }

        return navigator.clipboard.writeText(text);
    }

    // ================================================================
    // Styles
    // ================================================================

    function injectStyles() {
        if (
            document.getElementById(
                'dex-enhance-styles'
            )
        ) {
            return;
        }

        const style =
            document.createElement('style');

        style.id = 'dex-enhance-styles';

        style.textContent = `
            .dex-open-tab-indicator {
                opacity: 0.55 !important;
                filter: grayscale(0.65) !important;
            }

            .dex-open-tab-indicator [data-dex-copy-wrapper="1"],
            .dex-open-tab-indicator a {
                opacity: 0.8 !important;
            }

            .dex-hidden-row {
                opacity: 0.25 !important;
                filter: grayscale(1) !important;
                background-color: rgba(0,0,0,0.4) !important;
                text-decoration: line-through !important;
            }

            .dex-hidden-row:hover {
                opacity: 0.9 !important;
                filter: grayscale(0) !important;
                transition: all 0.2s ease-in-out;
            }

            .dex-hidden-row button[data-dex-action-button="1"] {
                text-decoration: none !important;
            }

            .dex-btn {
                padding: 2px 8px;
                border: none;
                border-radius: 6px;
                font-size: 11px;
                color: #fff;
                cursor: pointer;
                line-height: 1;
                white-space: nowrap;
            }

            .dex-btn[data-dex-action-key="toggleHide"] {
                background: rgba(220,53,69,0.95);
            }

            .dex-btn[data-dex-action-key="toggleHide"].is-hidden {
                background: rgba(108,117,125,0.95);
            }

            .dex-btn[data-dex-action-key="label"] {
                background: rgba(120,120,120,0.95);
            }

            .dex-btn[data-dex-action-key="label"].has-label {
                background: rgba(60,60,60,0.95);
            }

            .dex-btn[data-dex-action-key="ca"] {
                background: rgba(38,166,154,0.95);
            }

            .dex-btn[data-dex-action-key="gmgn"] {
                background: rgba(66,133,244,0.95);
            }

            .dex-btn[data-dex-action-key="pumpfun"] {
                background: rgba(255,161,0,0.95);
            }

            .dex-btn[data-dex-action-key="xca"] {
                background: rgba(255,99,71,0.95);
            }

            .dex-btn[data-dex-action-key="xticker"] {
                background: rgba(155,89,182,0.95);
            }

            .dex-btn[data-dex-action-key="telegram"] {
                background: rgba(0,136,204,0.95);
            }

            .dex-label-chip {
                padding: 2px 8px;
                border: none;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 700;
                color: #111;
                cursor: pointer;
                line-height: 1.35;
                white-space: nowrap;
                max-width: 180px;
                overflow: hidden;
                text-overflow: ellipsis;
                text-decoration: none !important;
            }

            .dex-hidden-row .dex-label-chip {
                text-decoration: none !important;
            }

            .dex-btn-row {
                display: inline-flex;
                gap: 4px;
                align-items: center;
                margin-left: 6px;
            }

            .dex-btn-row-detail {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                align-items: center;
                margin: 10px 0 14px;
                padding: 4px 0;
            }

            .dex-header-links {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                margin-bottom: 8px;
            }

            .dex-header-link {
                padding: 6px 10px;
                border: none;
                border-radius: 8px;
                background: rgba(42,118,255,0.95);
                color: #fff;
                font-size: 12px;
                cursor: pointer;
                line-height: 1;
                white-space: nowrap;
            }

            #dex-pair-toast {
                position: fixed;
                top: 16px;
                right: 16px;
                z-index: 2147483648;
                background: rgba(20,20,20,0.95);
                color: #fff;
                padding: 10px 14px;
                border-radius: 10px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.35);
                font-family: system-ui, sans-serif;
                font-size: 13px;
                pointer-events: none;
                max-width: 320px;
            }

            .dex-overlay {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                background: rgba(0,0,0,0.85);
                color: #eee;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 1rem;
                backdrop-filter: blur(4px);
            }

            .dex-overlay-panel {
                max-width: 100%;
                width: 760px;
                background: #111;
                border: 1px solid #444;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 0 60px rgba(0,0,0,0.6);
            }

            .dex-overlay-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                background: #131313;
                border-bottom: 1px solid #333;
                font-family: system-ui, sans-serif;
                font-size: 14px;
            }

            .dex-overlay-actions {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                padding: 12px 16px;
                background: #111;
            }

            .dex-overlay-textarea {
                width: 100%;
                height: 56vh;
                padding: 16px;
                border: none;
                background: #000;
                color: #0f0;
                font-family: monospace, ui-monospace, sans-serif;
                font-size: 13px;
                line-height: 1.4;
                resize: none;
                outline: none;
                box-sizing: border-box;
            }

            .dex-ui-btn {
                border: none;
                background: #2a2a2a;
                color: #eee;
                padding: 8px 12px;
                border-radius: 8px;
                cursor: pointer;
            }

            #dex-label-popup {
                position: fixed;
                z-index: 2147483647;
                width: 280px;
                background: #17181c;
                border: 1px solid #3a3d45;
                border-radius: 10px;
                box-shadow: 0 14px 44px rgba(0,0,0,0.55);
                padding: 10px;
                font-family: system-ui, sans-serif;
                color: #eee;
                font-size: 12px;
            }

            #dex-label-popup .dex-label-title {
                font-size: 11px;
                opacity: 0.7;
                margin-bottom: 6px;
            }

            #dex-label-popup input.dex-label-input {
                width: 100%;
                box-sizing: border-box;
                padding: 7px 8px;
                border-radius: 7px;
                border: 1px solid #3a3d45;
                background: #0d0e11;
                color: #fff;
                font-size: 13px;
                outline: none;
            }

            #dex-label-popup .dex-label-section {
                margin-top: 8px;
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }

            #dex-label-popup .dex-label-preset {
                border: none;
                border-radius: 6px;
                padding: 3px 7px;
                font-size: 11px;
                font-weight: 700;
                color: #111;
                cursor: pointer;
            }

            #dex-label-popup .dex-label-swatch {
                width: 20px;
                height: 20px;
                border-radius: 50%;
                border: 2px solid transparent;
                cursor: pointer;
                padding: 0;
            }

            #dex-label-popup .dex-label-swatch.is-active {
                border-color: #fff;
            }

            #dex-label-popup .dex-label-footer {
                margin-top: 10px;
                display: flex;
                gap: 6px;
                justify-content: flex-end;
            }

            #dex-label-popup .dex-label-footer button {
                border: none;
                border-radius: 7px;
                padding: 6px 10px;
                font-size: 12px;
                cursor: pointer;
            }

            #dex-label-popup .dex-label-save {
                background: #2a76ff;
                color: #fff;
            }

            #dex-label-popup .dex-label-remove {
                background: #6c1c23;
                color: #fff;
            }

            #dex-label-popup .dex-label-cancel {
                background: #2a2a2a;
                color: #ddd;
            }
        `;

        document.head?.appendChild(style);
    }

    // ================================================================
    // Pair info cache
    // ================================================================

    const pairInfoCache = new Map();
    const pairInfoInFlight = new Map();

    function loadPairInfoCache() {
        let parsed;

        try {
            parsed = JSON.parse(
                storage.get(CACHE_KEY)
            );
        } catch {
            return;
        }

        if (
            !parsed ||
            typeof parsed !== 'object'
        ) {
            return;
        }

        const now = Date.now();

        for (
            const [pairId, entry] of
            Object.entries(parsed)
        ) {
            if (
                entry &&
                typeof entry.timestamp ===
                    'number' &&
                entry.data &&
                now - entry.timestamp <=
                    CACHE_TTL
            ) {
                pairInfoCache.set(
                    pairId,
                    entry
                );
            }
        }
    }

    function savePairInfoCache() {
        const now = Date.now();
        const payload = {};

        pairInfoCache.forEach(
            (entry, pairId) => {
                if (
                    now - entry.timestamp <=
                    CACHE_TTL
                ) {
                    payload[pairId] = entry;
                }
            }
        );

        storage.set(
            CACHE_KEY,
            JSON.stringify(payload)
        );
    }

    function getCachedPairInfo(
        pairId,
        allowStale = false
    ) {
        const entry =
            pairInfoCache.get(pairId);

        if (!entry) {
            return null;
        }

        if (
            Date.now() - entry.timestamp >
                CACHE_TTL &&
            !allowStale
        ) {
            pairInfoCache.delete(pairId);
            return null;
        }

        return entry.data;
    }

    function cachePairInfo(pairId, data) {
        if (!pairId || !data) {
            return;
        }

        pairInfoCache.set(pairId, {
            timestamp: Date.now(),
            data
        });

        savePairInfoCache();
    }

    function invalidatePairInfo(pairId) {
        if (!pairId) {
            return;
        }

        pairInfoCache.delete(pairId);

        let parsed;

        try {
            parsed = JSON.parse(
                storage.get(CACHE_KEY)
            );
        } catch {
            return;
        }

        if (
            !parsed ||
            typeof parsed !== 'object'
        ) {
            return;
        }

        delete parsed[pairId];

        storage.set(
            CACHE_KEY,
            JSON.stringify(parsed)
        );
    }

    function clearAllPairInfoCache() {
        pairInfoCache.clear();
        storage.remove(CACHE_KEY);

        showToast(
            'Cleared pair info cache'
        );
    }

    // ================================================================
    // Hidden pairs
    // ================================================================

    let hiddenPairs = new Set();

    function loadHiddenPairs() {
        let parsed;

        try {
            parsed = JSON.parse(
                storage.get(HIDDEN_KEY)
            );
        } catch {
            return;
        }

        if (Array.isArray(parsed)) {
            hiddenPairs = new Set(parsed);
        }
    }

    function saveHiddenPairs() {
        storage.set(
            HIDDEN_KEY,
            JSON.stringify([
                ...hiddenPairs
            ])
        );
    }

    function applyHideBtnState(
        btn,
        isHidden
    ) {
        if (!btn) {
            return;
        }

        btn.textContent =
            isHidden ? '↺' : '✖';

        btn.title = isHidden
            ? 'Unhide / Restore this coin'
            : 'Cross out / hide this coin';

        btn.classList.toggle(
            'is-hidden',
            isHidden
        );
    }

    function toggleHidePair(
        pairId,
        row,
        btn
    ) {
        if (!pairId) {
            return;
        }

        const isHidden =
            !hiddenPairs.has(pairId);

        if (isHidden) {
            hiddenPairs.add(pairId);
        } else {
            hiddenPairs.delete(pairId);
        }

        row?.classList.toggle(
            'dex-hidden-row',
            isHidden
        );

        applyHideBtnState(
            btn,
            isHidden
        );

        saveHiddenPairs();

        showToast(
            isHidden
                ? 'Coin crossed out / hidden'
                : 'Coin restored'
        );
    }

    // ================================================================
    // Labels
    // ================================================================

    let pairLabels =
        Object.create(null);

    function loadLabels() {
        let parsed;

        try {
            parsed = JSON.parse(
                storage.get(LABELS_KEY)
            );
        } catch {
            return;
        }

        if (
            !parsed ||
            typeof parsed !== 'object'
        ) {
            return;
        }

        const next =
            Object.create(null);

        for (
            const [pairId, entry] of
            Object.entries(parsed)
        ) {
            if (!entry) {
                continue;
            }

            if (typeof entry === 'string') {
                if (entry.trim()) {
                    next[pairId] = {
                        text: entry
                            .trim()
                            .slice(
                                0,
                                MAX_LABEL_LEN
                            ),
                        color:
                            DEFAULT_LABEL_COLOR,
                        ts: Date.now()
                    };
                }
            } else if (
                typeof entry.text ===
                    'string' &&
                entry.text.trim()
            ) {
                next[pairId] = {
                    text: entry.text
                        .trim()
                        .slice(
                            0,
                            MAX_LABEL_LEN
                        ),
                    color:
                        typeof entry.color ===
                            'string'
                            ? entry.color
                            : DEFAULT_LABEL_COLOR,
                    ts:
                        typeof entry.ts ===
                        'number'
                            ? entry.ts
                            : Date.now()
                };
            }
        }

        pairLabels = next;
    }

    function saveLabels() {
        storage.set(
            LABELS_KEY,
            JSON.stringify(pairLabels)
        );
    }

    const getLabel = pairId =>
        (pairId &&
            pairLabels[pairId]) ||
        null;

    const getLabelText = pairId =>
        getLabel(pairId)?.text || '';

    function setLabel(
        pairId,
        text,
        color
    ) {
        if (!pairId) {
            return;
        }

        const clean = (text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_LABEL_LEN);

        if (!clean) {
            removeLabel(pairId);
            return;
        }

        pairLabels[pairId] = {
            text: clean,
            color:
                color ||
                DEFAULT_LABEL_COLOR,
            ts: Date.now()
        };

        saveLabels();
        refreshLabelsUI();

        showToast(
            'Label saved: ' + clean
        );
    }

    function removeLabel(pairId) {
        if (
            !pairId ||
            !pairLabels[pairId]
        ) {
            refreshLabelsUI();
            return;
        }

        delete pairLabels[pairId];

        saveLabels();
        refreshLabelsUI();

        showToast(
            'Label removed'
        );
    }

    function applyLabelUI(wrapper) {
        if (!wrapper) {
            return;
        }

        const pairId =
            wrapper.dataset.pairId;

        const info =
            getLabel(pairId);

        let chip =
            wrapper.querySelector(
                '.dex-label-chip'
            );

        if (!info) {
            chip?.remove();
        } else {
            if (!chip) {
                chip =
                    document.createElement(
                        'button'
                    );

                chip.type = 'button';
                chip.className =
                    'dex-label-chip';

                chip.dataset.dexActionButton =
                    '1';

                chip.dataset.dexActionKey =
                    'label';

                wrapper.insertBefore(
                    chip,
                    wrapper.firstChild
                );
            }

            chip.textContent =
                info.text;

            chip.title =
                'Label: ' +
                info.text +
                ' (click to edit)';

            chip.style.background =
                info.color ||
                DEFAULT_LABEL_COLOR;
        }

        const btn =
            wrapper.querySelector(
                'button[data-dex-action-key="label"]:not(.dex-label-chip)'
            );

        if (btn) {
            btn.classList.toggle(
                'has-label',
                Boolean(info)
            );

            btn.title = info
                ? 'Edit label: ' +
                  info.text
                : 'Add a label / note for this coin';
        }
    }

    function refreshLabelsUI() {
        document
            .querySelectorAll(
                'span[data-dex-copy-wrapper="1"]'
            )
            .forEach(applyLabelUI);
    }

    // ================================================================
    // Label editor
    // ================================================================

    let labelPopupCleanup = null;

    function closeLabelEditor() {
        document
            .getElementById(
                'dex-label-popup'
            )
            ?.remove();

        if (labelPopupCleanup) {
            labelPopupCleanup();
            labelPopupCleanup = null;
        }
    }

    function openLabelEditor(
        pairId,
        event
    ) {
        closeLabelEditor();

        if (!pairId) {
            return;
        }

        injectStyles();

        const existing =
            getLabel(pairId);

        let color =
            existing?.color ||
            DEFAULT_LABEL_COLOR;

        const popup =
            document.createElement(
                'div'
            );

        popup.id =
            'dex-label-popup';

        popup.innerHTML =
            '<div class="dex-label-title">' +
            'Label for ' +
            pairId.slice(0, 6) +
            '…' +
            pairId.slice(-4) +
            '</div>' +

            '<input type="text" class="dex-label-input" maxlength="' +
            MAX_LABEL_LEN +
            '" placeholder="e.g. watch, dev sold, re-entry @ 60k">' +

            '<div class="dex-label-section dex-label-presets"></div>' +

            '<div class="dex-label-section dex-label-swatches"></div>' +

            '<div class="dex-label-footer">' +
            '<button type="button" class="dex-label-remove">Remove</button>' +
            '<button type="button" class="dex-label-cancel">Cancel</button>' +
            '<button type="button" class="dex-label-save">Save</button>' +
            '</div>';

        document.body.appendChild(
            popup
        );

        const input =
            popup.querySelector(
                '.dex-label-input'
            );

        input.value =
            existing?.text || '';

        // Presets
        const presetBox =
            popup.querySelector(
                '.dex-label-presets'
            );

        LABEL_PRESETS.forEach(
            preset => {
                const b =
                    document.createElement(
                        'button'
                    );

                b.type = 'button';
                b.className =
                    'dex-label-preset';

                b.textContent =
                    preset.text;

                b.style.background =
                    preset.color;

                b.addEventListener(
                    'click',
                    () => {
                        input.value =
                            preset.text;

                        color =
                            preset.color;

                        syncSwatches();

                        setLabel(
                            pairId,
                            preset.text,
                            preset.color
                        );

                        closeLabelEditor();
                    }
                );

                presetBox.appendChild(b);
            }
        );

        // Color swatches
        const swatchBox =
            popup.querySelector(
                '.dex-label-swatches'
            );

        const swatches =
            LABEL_COLORS.map(c => {
                const s =
                    document.createElement(
                        'button'
                    );

                s.type = 'button';

                s.className =
                    'dex-label-swatch';

                s.style.background =
                    c;

                s.dataset.color =
                    c;

                s.title = c;

                s.addEventListener(
                    'click',
                    () => {
                        color = c;
                        syncSwatches();
                        input.focus();
                    }
                );

                swatchBox.appendChild(s);

                return s;
            });

        const syncSwatches =
            () => {
                swatches.forEach(
                    s =>
                        s.classList.toggle(
                            'is-active',
                            s.dataset.color ===
                                color
                        )
                );
            };

        syncSwatches();

        const save = () => {
            setLabel(
                pairId,
                input.value,
                color
            );

            closeLabelEditor();
        };

        popup
            .querySelector(
                '.dex-label-save'
            )
            .addEventListener(
                'click',
                save
            );

        popup
            .querySelector(
                '.dex-label-cancel'
            )
            .addEventListener(
                'click',
                closeLabelEditor
            );

        popup
            .querySelector(
                '.dex-label-remove'
            )
            .addEventListener(
                'click',
                () => {
                    removeLabel(pairId);
                    closeLabelEditor();
                }
            );

        input.addEventListener(
            'keydown',
            e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    save();
                } else if (
                    e.key === 'Escape'
                ) {
                    e.preventDefault();
                    closeLabelEditor();
                }
            }
        );

        popup.addEventListener(
            'click',
            e =>
                e.stopPropagation()
        );

        // Position popup.
        const anchorEl =
            event?.target?.closest?.(
                'button'
            ) || null;

        const rect = anchorEl
            ? anchorEl.getBoundingClientRect()
            : {
                left:
                    window.innerWidth /
                        2 -
                    140,
                bottom: 120,
                top: 120
            };

        const width = 280;
        const height =
            popup.offsetHeight || 220;

        let left = Math.min(
            Math.max(8, rect.left),
            window.innerWidth -
                width -
                8
        );

        let top =
            rect.bottom + 6;

        if (
            top + height >
            window.innerHeight - 8
        ) {
            top = Math.max(
                8,
                rect.top -
                    height -
                    6
            );
        }

        popup.style.left =
            left + 'px';

        popup.style.top =
            top + 'px';

        input.focus();
        input.select();

        const onDocClick =
            e => {
                if (
                    !popup.contains(
                        e.target
                    )
                ) {
                    closeLabelEditor();
                }
            };

        const onKey =
            e => {
                if (e.key === 'Escape') {
                    closeLabelEditor();
                }
            };

        const onScroll =
            () => closeLabelEditor();

        setTimeout(
            () =>
                document.addEventListener(
                    'click',
                    onDocClick,
                    true
                ),
            0
        );

        document.addEventListener(
            'keydown',
            onKey,
            true
        );

        window.addEventListener(
            'resize',
            onScroll,
            true
        );

        labelPopupCleanup =
            () => {
                document.removeEventListener(
                    'click',
                    onDocClick,
                    true
                );

                document.removeEventListener(
                    'keydown',
                    onKey,
                    true
                );

                window.removeEventListener(
                    'resize',
                    onScroll,
                    true
                );
            };
    }

    // ================================================================
    // Networking
    // ================================================================

    function gmFetchJson(url) {
        if (
            typeof GM_xmlhttpRequest ===
            'function'
        ) {
            return new Promise(
                (resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url,
                        timeout: 10000,

                        onload:
                            response => {
                                if (
                                    response.status <
                                        200 ||
                                    response.status >=
                                        300
                                ) {
                                    reject(
                                        new Error(
                                            'Request failed: ' +
                                            response.status
                                        )
                                    );
                                    return;
                                }

                                try {
                                    resolve(
                                        JSON.parse(
                                            response.responseText
                                        )
                                    );
                                } catch (e) {
                                    reject(e);
                                }
                            },

                        onerror:
                            () =>
                                reject(
                                    new Error(
                                        'Network error'
                                    )
                                ),

                        ontimeout:
                            () =>
                                reject(
                                    new Error(
                                        'Request timed out'
                                    )
                                )
                    });
                }
            );
        }

        return fetch(url).then(
            response => {
                if (!response.ok) {
                    throw new Error(
                        'Request failed: ' +
                        response.status
                    );
                }

                return response.json();
            }
        );
    }

    async function fetchPairInfo(
        pairId
    ) {
        const cached =
            getCachedPairInfo(pairId);

        if (cached) {
            return cached;
        }

        if (
            pairInfoInFlight.has(pairId)
        ) {
            return pairInfoInFlight.get(
                pairId
            );
        }

        const request =
            (async () => {
                const stale =
                    getCachedPairInfo(
                        pairId,
                        true
                    );

                try {
                    const json =
                        await gmFetchJson(
                            'https://api.dexscreener.com/latest/dex/pairs/solana/' +
                                pairId
                        );

                    const pair =
                        Array.isArray(
                            json.pairs
                        )
                            ? json.pairs[0]
                            : json.pair ||
                              null;

                    if (!pair) {
                        if (stale) {
                            return stale;
                        }

                        throw new Error(
                            'Pair data missing for ' +
                            pairId
                        );
                    }

                    cachePairInfo(
                        pairId,
                        pair
                    );

                    return pair;
                } catch (e) {
                    if (stale) {
                        return stale;
                    }

                    throw e;
                } finally {
                    pairInfoInFlight.delete(
                        pairId
                    );
                }
            })();

        pairInfoInFlight.set(
            pairId,
            request
        );

        return request;
    }

    async function withPair(
        pairId,
        callback,
        failureMessage
    ) {
        try {
            await callback(
                await fetchPairInfo(
                    pairId
                )
            );
        } catch (e) {
            console.warn(
                failureMessage,
                e
            );

            showToast(
                failureMessage,
                2600
            );
        }
    }

    const toolLink =
        (
            buildUrl,
            failureMessage
        ) =>
        pairId =>
            withPair(
                pairId,
                async pair =>
                    window.open(
                        buildUrl(pair),
                        '_blank'
                    ),
                failureMessage
            );

    // ================================================================
    // Open-tab indicators
    // ================================================================

    const currentTabId =
        'dexscreener-tab-' +
        Math.random()
            .toString(36)
            .slice(2, 10);

    let openTabHeartbeatTimer =
        null;

    let openTabCleanupTimer =
        null;

    function extractOpenTabEntries() {
        const now = Date.now();
        const openIds = new Set();
        const keys = [];

        for (
            let i = 0;
            i < localStorage.length;
            i++
        ) {
            const key =
                localStorage.key(i);

            if (
                key?.startsWith(
                    OPEN_TAB_PREFIX
                )
            ) {
                keys.push(key);
            }
        }

        for (const key of keys) {
            let entry = null;

            try {
                entry = JSON.parse(
                    storage.get(key)
                );
            } catch {
                // Invalid entry.
            }

            if (
                entry &&
                typeof entry.pairId ===
                    'string' &&
                typeof entry.ts ===
                    'number' &&
                now - entry.ts <=
                    OPEN_TAB_STALE_MS
            ) {
                openIds.add(
                    entry.pairId
                );
            } else {
                // Only remove genuinely stale/invalid entries.
                storage.remove(key);
            }
        }

        return openIds;
    }

    function updateOpenTabEntry(
        pairId
    ) {
        const key =
            OPEN_TAB_PREFIX +
            currentTabId;

        if (!pairId) {
            storage.remove(key);
            return;
        }

        storage.set(
            key,
            JSON.stringify({
                pairId,
                ts: Date.now()
            })
        );
    }

    function markAnchorAsOpenInOtherTab(
        anchor,
        isOpen
    ) {
        const row =
            getRowFromAnchor(anchor);

        if (!row) {
            return;
        }

        const wrapper =
            getCopyWrapper(anchor);

        row.classList.toggle(
            'dex-open-tab-indicator',
            isOpen
        );

        anchor.title = isOpen
            ? 'Already open in another tab'
            : '';

        wrapper?.classList.toggle(
            'dex-open-tab-indicator',
            isOpen
        );
    }

    function refreshOpenTabStyles() {
        injectStyles();

        const openIds =
            extractOpenTabEntries();

        document
            .querySelectorAll(
                'a.ds-dex-table-row[href*="/solana/"]'
            )
            .forEach(anchor => {
                const pairId =
                    getPairIdFromHref(
                        anchor.href
                    );

                markAnchorAsOpenInOtherTab(
                    anchor,
                    Boolean(
                        pairId &&
                        openIds.has(
                            pairId
                        )
                    )
                );
            });
    }

    function startOpenTabHeartbeat(
        pairId
    ) {
        if (!pairId) {
            return;
        }

        // Write immediately.
        updateOpenTabEntry(pairId);

        if (
            openTabHeartbeatTimer
        ) {
            clearInterval(
                openTabHeartbeatTimer
            );
        }

        openTabHeartbeatTimer =
            setInterval(
                () =>
                    updateOpenTabEntry(
                        pairId
                    ),
                OPEN_TAB_HEARTBEAT_MS
            );
    }

    function stopOpenTabHeartbeat() {
        if (
            openTabHeartbeatTimer
        ) {
            clearInterval(
                openTabHeartbeatTimer
            );

            openTabHeartbeatTimer =
                null;
        }

        updateOpenTabEntry(null);
    }

    function startOpenTabListener() {
        refreshOpenTabStyles();

        window.addEventListener(
            'storage',
            event => {
                if (
                    event.key ===
                    HIDDEN_KEY
                ) {
                    loadHiddenPairs();
                    scheduleDexScan();
                } else if (
                    event.key ===
                    LABELS_KEY
                ) {
                    loadLabels();
                    refreshLabelsUI();
                } else if (
                    event.key?.startsWith(
                        OPEN_TAB_PREFIX
                    )
                ) {
                    // Another tab opened/closed/renewed a pair.
                    refreshOpenTabStyles();
                }
            }
        );

        if (
            openTabCleanupTimer
        ) {
            clearInterval(
                openTabCleanupTimer
            );
        }

        openTabCleanupTimer =
            setInterval(
                refreshOpenTabStyles,
                OPEN_TAB_CLEANUP_MS
            );
    }

    // ================================================================
    // Copy features & TXT Export
    // ================================================================

    let copyPairsInProgress =
        false;

    function mergePairEntry(
        pairs,
        address,
        info
    ) {
        const existing =
            pairs.get(address);

        pairs.set(
            address,
            existing
                ? {
                    ticker:
                        existing.ticker ||
                        info.ticker,

                    name:
                        existing.name ||
                        info.name,

                    label:
                        existing.label ||
                        info.label,

                    pairAddress:
                        existing.pairAddress ||
                        info.pairAddress,

                    tokenAddress:
                        existing.tokenAddress ||
                        info.tokenAddress
                }
                : info
        );
    }

    async function copyPairs(
        mode = 'tokens'
    ) {
        if (
            copyPairsInProgress
        ) {
            showToast(
                'Copy already in progress'
            );
            return;
        }

        copyPairsInProgress =
            true;

        loadHiddenPairs();
        loadLabels();

        try {
            const anchors = [
                ...document.querySelectorAll(
                    'a[href*="/solana/"]'
                )
            ];

            const pairIds = new Set();

            for (const anchor of anchors) {
                const pairId =
                    getPairIdFromHref(
                        anchor.href
                    );

                if (
                    pairId &&
                    !hiddenPairs.has(
                        pairId
                    )
                ) {
                    pairIds.add(
                        pairId
                    );
                }
            }

            if (pairIds.size === 0) {
                showToast(
                    'No Solana pair links found (or all visible were hidden)'
                );
                return;
            }

            const pairs = new Map();

            if (
                isDexscreenerHost()
            ) {
                const outcomes =
                    await mapWithConcurrency(
                        [...pairIds],
                        6,
                        async pairId => {
                            const pair =
                                await fetchPairInfo(
                                    pairId
                                );

                            const pairAddress =
                                pair.pairAddress;

                            const tokenAddress =
                                pair.baseToken
                                    ?.address ||
                                pairAddress;

                            mergePairEntry(
                                pairs,
                                mode ===
                                    'contracts'
                                    ? pairAddress
                                    : tokenAddress,
                                {
                                    ticker:
                                        mode ===
                                        'contracts'
                                            ? ''
                                            : pair
                                                  .baseToken
                                                  ?.symbol ||
                                              '',

                                    name:
                                        mode ===
                                        'contracts'
                                            ? ''
                                            : pair
                                                  .baseToken
                                                  ?.name ||
                                              '',

                                    label:
                                        getLabelText(
                                            pairId
                                        ),

                                    pairAddress,

                                    tokenAddress
                                }
                            );
                        }
                    );

                const failures =
                    outcomes.filter(
                        outcome =>
                            !outcome.ok
                    ).length;

                if (failures) {
                    console.warn(
                        `Failed to fetch ${failures} pair(s) while copying`
                    );
                }
            } else {
                for (const anchor of anchors) {
                    const pairId =
                        getPairIdFromHref(
                            anchor.href
                        );

                    const address =
                        pairId ||
                        getAddressFromHref(
                            anchor.href
                        );

                    if (
                        !address ||
                        hiddenPairs.has(
                            address
                        )
                    ) {
                        continue;
                    }

                    const text =
                        (
                            anchor.textContent ||
                            ''
                        )
                            .replace(
                                /\s+/g,
                                ' '
                            )
                            .trim();

                    const match =
                        text.match(
                            /(.+?)\s*\/\s*SOL\s*(.+)/i
                        );

                    let name =
                        match
                            ? match[2].trim()
                            : '';

                    if (name) {
                        name =
                            name.replace(
                                /\s*\$\S.*$/,
                                ''
                            ).trim();
                    }

                    mergePairEntry(
                        pairs,
                        address,
                        {
                            ticker:
                                match
                                    ? match[1].trim()
                                    : '',

                            name,

                            label:
                                getLabelText(
                                    address
                                ),

                            pairAddress:
                                address,

                            tokenAddress:
                                address
                        }
                    );
                }
            }

            if (pairs.size === 0) {
                showToast(
                    'No addresses could be resolved'
                );
                return;
            }

            try {
                await writeClipboard(
                    buildResult(
                        pairs,
                        mode
                    )
                );

                showToast(
                    `Copied ${pairs.size} addresses to clipboard`
                );
            } catch {
                alert(
                    'Failed to copy automatically; please use the overlay text box.'
                );

                showResultOverlay(
                    pairs,
                    mode
                );
            }
        } finally {
            copyPairsInProgress =
                false;
        }
    }

    async function copySingleAddress(
        pairId
    ) {
        await withPair(
            pairId,
            async pair => {
                await writeClipboard(
                    requirePrimaryAddress(
                        pair
                    )
                );

                showToast(
                    'Copied token contract address'
                );
            },
            'Unable to copy contract address automatically.'
        );
    }

    async function exportPairsToTxt() {
        loadHiddenPairs();
        loadLabels();

        const anchors = [...document.querySelectorAll('a[href*="/solana/"]')];
        const pairIds = new Set();

        for (const anchor of anchors) {
            const pairId = getPairIdFromHref(anchor.href);
            if (pairId && !hiddenPairs.has(pairId)) {
                pairIds.add(pairId);
            }
        }

        if (pairIds.size === 0) {
            showToast('No Solana pairs found to export');
            return;
        }

        showToast(`Fetching details for ${pairIds.size} pairs...`);

        let output = "DEXSCREENER TOKEN EXPORT\n";
        output += "=".repeat(50) + "\n\n";

        const outcomes = await mapWithConcurrency([...pairIds], 6, async pairId => {
            try {
                const pair = await fetchPairInfo(pairId);
                if (!pair) return null;

                const name = pair.baseToken?.name || 'Unknown';
                const symbol = pair.baseToken?.symbol || 'UNKNOWN';
                const mcap = pair.marketCap || pair.fdv || 'N/A';
                const h6Chg = pair.priceChange?.h6 ?? 'N/A';
                const h24Chg = pair.priceChange?.h24 ?? 'N/A';

                const websites = pair.info?.websites?.map(w => w.url).join(', ') || '';
                const twitter = pair.info?.socials?.find(s => s.type === 'twitter')?.url || '';
                const websiteUrl = websites || 'N/A';
                const twitterUrl = twitter || 'N/A';

                let line = `Name: ${name} (${symbol})\n`;
                line += `Contract: ${pair.baseToken?.address || pair.pairAddress}\n`;
                line += `Market Cap: $${typeof mcap === 'number' ? mcap.toLocaleString() : mcap}\n`;
                line += `6h Change: ${h6Chg}%\n`;
                line += `24h Change: ${h24Chg}%\n`;
                line += `Website: ${websiteUrl}\n`;
                line += `Twitter: ${twitterUrl}\n`;
                line += "-".repeat(40) + "\n";

                return line;
            } catch (e) {
                return null;
            }
        });

        const lines = outcomes.filter(o => o && o.ok).map(o => o.value);

        if (lines.length === 0) {
            showToast('Failed to retrieve token details for export.');
            return;
        }

        output += lines.join('\n');

        const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dexscreener_export_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Successfully exported ${lines.length} tokens to TXT!`);
    }

    // ================================================================
    // Result overlay
    // ================================================================

    function showResultOverlay(
        pairs,
        mode = 'tokens'
    ) {
        document
            .getElementById(
                'dex-pair-clipboard-overlay'
            )
            ?.remove();

        const actions = [
            {
                id: 'dex-copy-contracts',
                label: 'Copy pair CAs',
                mode: 'contracts',
                noun: 'pair'
            },

            {
                id: 'dex-copy-tokens',
                label: 'Copy token CAs',
                mode: 'tokens',
                noun: 'token'
            },

            {
                id: 'dex-copy-labeled',
                label: 'Copy token CAs + labels',
                mode: 'labels',
                noun: 'labelled token'
            }
        ];

        const overlay =
            document.createElement(
                'div'
            );

        overlay.id =
            'dex-pair-clipboard-overlay';

        overlay.className =
            'dex-overlay';

        overlay.innerHTML =
            '<div class="dex-overlay-panel">' +

            '<div class="dex-overlay-header">' +
            '<span>DEX Contract Addresses</span>' +
            '<button id="dex-pair-clipboard-close" type="button" class="dex-ui-btn">Close</button>' +
            '</div>' +

            '<div class="dex-overlay-actions">' +
            actions
                .map(
                    a =>
                        `<button id="${a.id}" type="button" class="dex-ui-btn">${a.label}</button>`
                )
                .join('') +
            '</div>' +

            '<textarea id="dex-pair-clipboard-textarea" readonly class="dex-overlay-textarea"></textarea>' +

            '</div>';

        document.body.appendChild(
            overlay
        );

        const textarea =
            overlay.querySelector(
                '#dex-pair-clipboard-textarea'
            );

        const setMode =
            newMode => {
                textarea.value =
                    buildResult(
                        pairs,
                        newMode
                    );
            };

        actions.forEach(
            action => {
                overlay
                    .querySelector(
                        '#' +
                            action.id
                    )
                    .addEventListener(
                        'click',
                        () => {
                            writeClipboard(
                                buildResult(
                                    pairs,
                                    action.mode
                                )
                            )
                                .then(
                                    () =>
                                        showToast(
                                            `Copied ${pairs.size} ${action.noun} CAs to clipboard`
                                        )
                                );

                            setMode(
                                action.mode
                            );
                        }
                    );
            }
        );

        overlay
            .querySelector(
                '#dex-pair-clipboard-close'
            )
            .addEventListener(
                'click',
                () =>
                    overlay.remove()
            );

        setMode(mode);
    }

    // ================================================================
    // Action buttons
    // ================================================================

    const twitterSearch =
        query =>
            'https://twitter.com/search?q=' +
            enc(query);

    function toggleHide(
        pairId,
        event
    ) {
        const button =
            event.target.closest?.(
                'button[data-dex-action-button="1"]'
            );

        const prev =
            button
                ?.closest(
                    'span[data-dex-copy-wrapper="1"]'
                )
                ?.previousElementSibling;

        const row =
            prev &&
            prev.tagName === 'A'
                ? getRowFromAnchor(prev)
                : null;

        toggleHidePair(
            pairId,
            row,
            button
        );
    }

    const BUTTONS = [
        {
            key: 'toggleHide',
            label: '✖',
            title: 'Cross out / hide this coin',
            run: toggleHide
        },

        {
            key: 'label',
            label: '🏷',
            title: 'Add a label / note for this coin',
            run: openLabelEditor
        },

        {
            key: 'ca',
            label: 'CA',
            title: 'Copy token contract address',
            run: copySingleAddress
        },

        {
            key: 'gmgn',
            label: 'GMGN',
            title: 'Open on GMGN',

            run: toolLink(
                pair =>
                    'https://gmgn.ai/sol/token/' +
                    enc(
                        requirePrimaryAddress(
                            pair
                        )
                    ),

                'Unable to open GMGN for this contract.'
            )
        },

        {
            key: 'pumpfun',
            label: 'pfun',
            title: 'Open on pump.fun',

            run: toolLink(
                pair =>
                    'https://pump.fun/coin/' +
                    enc(
                        requirePrimaryAddress(
                            pair
                        )
                    ),

                'Unable to open pump.fun for this contract.'
            )
        },

        {
            key: 'xca',
            label: 'X CA',
            title: 'Search contract address on Twitter/X',

            run: toolLink(
                pair =>
                    twitterSearch(
                        requirePrimaryAddress(
                            pair
                        )
                    ),

                'Unable to open Twitter search for this contract.'
            )
        },

        {
            key: 'xticker',
            label: 'X $',
            title: 'Search ticker on Twitter/X',

            run: toolLink(
                pair => {
                    const symbol =
                        pair.baseToken
                            ?.symbol ||
                        '';

                    if (!symbol) {
                        throw new Error(
                            'Ticker missing'
                        );
                    }

                    return twitterSearch(
                        '$' +
                        symbol.replace(
                            /^[^A-Za-z0-9]+/,
                            ''
                        )
                    );
                },

                'Unable to open Twitter search for this ticker.'
            )
        },

        {
            key: 'telegram',
            label: 'TG',
            title: 'Open Rick bot on Telegram',

            run: toolLink(
                pair =>
                    'https://t.me/rick?start=' +
                    enc(
                        requirePrimaryAddress(
                            pair
                        )
                    ),

                'Unable to open Telegram for this contract.'
            )
        }
    ];

    function createButton(spec) {
        const btn =
            document.createElement(
                'button'
            );

        btn.type = 'button';

        btn.className =
            'dex-btn';

        btn.textContent =
            spec.label;

        btn.title =
            spec.title;

        btn.setAttribute(
            'aria-label',
            spec.title
        );

        btn.dataset.dexActionKey =
            spec.key;

        btn.dataset.dexActionButton =
            '1';

        return btn;
    }

    function buildActionWrapper(
        pairId
    ) {
        const wrapper =
            document.createElement(
                'span'
            );

        wrapper.dataset.dexCopyWrapper =
            '1';

        wrapper.dataset.pairId =
            pairId;

        for (const spec of BUTTONS) {
            const btn =
                createButton(spec);

            if (
                spec.key ===
                'toggleHide'
            ) {
                applyHideBtnState(
                    btn,
                    hiddenPairs.has(
                        pairId
                    )
                );
            }

            wrapper.appendChild(btn);
        }

        applyLabelUI(wrapper);

        return wrapper;
    }

    function handleDexActionEvent(
        event
    ) {
        const button =
            event.target.closest?.(
                'button[data-dex-action-button="1"]'
            );

        if (
            !button ||
            event.button === 2
        ) {
            return;
        }

        const pairId =
            button
                .closest(
                    'span[data-dex-copy-wrapper="1"]'
                )
                ?.dataset.pairId;

        const spec =
            pairId &&
            BUTTONS.find(
                b =>
                    b.key ===
                    button.dataset
                        .dexActionKey
            );

        if (!spec) {
            return;
        }

        event.stopPropagation();
        event.preventDefault();

        spec.run(
            pairId,
            event
        );
    }

    function handleDexActionContextMenu(
        event
    ) {
        const button =
            event.target.closest?.(
                'button[data-dex-action-button="1"]'
            );

        if (!button) {
            return;
        }

        const pairId =
            button
                .closest(
                    'span[data-dex-copy-wrapper="1"]'
                )
                ?.dataset.pairId;

        if (!pairId) {
            return;
        }

        event.preventDefault();

        if (
            button.dataset.dexActionKey ===
            'label'
        ) {
            removeLabel(pairId);
            return;
        }

        invalidatePairInfo(pairId);

        showToast(
            'Cleared cached data for this pair — next click will refetch'
        );
    }

    function insertCopyButton(
        anchor
    ) {
        const pairId =
            getPairIdFromHref(
                anchor.href
            );

        if (!pairId) {
            return;
        }

        const existing =
            getCopyWrapper(anchor);

        if (existing) {
            if (
                existing.dataset.pairId ===
                pairId
            ) {
                applyHideBtnState(
                    existing.querySelector(
                        'button[data-dex-action-key="toggleHide"]'
                    ),
                    hiddenPairs.has(
                        pairId
                    )
                );

                applyLabelUI(existing);

                return;
            }

            existing.remove();
        }

        const wrapper =
            buildActionWrapper(
                pairId
            );

        wrapper.className =
            'dex-btn-row';

        anchor.insertAdjacentElement(
            'afterend',
            wrapper
        );
    }

    function insertDetailActionButtons() {
        const pairId =
            getDetailPairId();

        if (!pairId) {
            return;
        }

        const existing =
            document.getElementById(
                'dex-detail-action-buttons'
            );

        if (existing) {
            applyLabelUI(existing);
            return;
        }

        const wrapper =
            buildActionWrapper(
                pairId
            );

        wrapper.id =
            'dex-detail-action-buttons';

        wrapper.className =
            'dex-btn-row dex-btn-row-detail';

        const root =
            getDetailRoot();

        const heading =
            root.querySelector(
                'h1, h2, .pair-name, .title, .pair-info, .detail-page__header, .pair-page-header, .pair-header'
            );

        if (
            heading &&
            heading.parentElement ===
                root
        ) {
            root.insertBefore(
                wrapper,
                heading.nextSibling
            );
        } else {
            root.prepend(wrapper);
        }
    }

    // ================================================================
    // Efficient wrapper cleanup
    // ================================================================

    const orphanWrapperTimes =
        new Map();

    function cleanupCopyWrappers() {
        const anchors = [
            ...document.querySelectorAll(
                'a[href*="/solana/"]'
            )
        ];

        const anchorByPairId =
            new Map();

        for (const anchor of anchors) {
            const pairId =
                getPairIdFromHref(
                    anchor.href
                );

            if (pairId) {
                anchorByPairId.set(
                    pairId,
                    anchor
                );
            }
        }

        document
            .querySelectorAll(
                'span[data-dex-copy-wrapper="1"]'
            )
            .forEach(wrapper => {
                if (
                    wrapper.id ===
                    'dex-detail-action-buttons'
                ) {
                    return;
                }

                const pairId =
                    wrapper.dataset.pairId;

                if (!pairId) {
                    orphanWrapperTimes.delete(
                        wrapper
                    );

                    wrapper.remove();
                    return;
                }

                const anchor =
                    anchorByPairId.get(
                        pairId
                    );

                if (anchor) {
                    orphanWrapperTimes.delete(
                        wrapper
                    );

                    if (
                        anchor.nextElementSibling !==
                        wrapper
                    ) {
                        anchor.insertAdjacentElement(
                            'afterend',
                            wrapper
                        );
                    }

                    return;
                }

                const since =
                    orphanWrapperTimes.get(
                        wrapper
                    );

                if (!since) {
                    orphanWrapperTimes.set(
                        wrapper,
                        Date.now()
                    );
                } else if (
                    Date.now() - since >
                    ORPHAN_WRAPPER_GRACE_MS
                ) {
                    orphanWrapperTimes.delete(
                        wrapper
                    );

                    wrapper.remove();
                }
            });
    }

    // ================================================================
    // Header quick links
    // ================================================================

    const HEADER_LINKS = [
        [
            '1w <120k dip',
            'https://dexscreener.com/new-pairs/solana?rankBy=pairAge&order=asc&dexIds=pumpswap&minLiq=7000&minMarketCap=17000&maxMarketCap=120000&minAge=1&maxAge=168&min6HVol=2000&min1HVol=500&max24HChg=-1&max6HChg=-1&max1HChg=-1&profile=1'
        ],

        [
            '20-120k <7d',
            'https://dexscreener.com/new-pairs/solana?rankBy=pairAge&order=asc&dexIds=pumpswap,pumpfun&minLiq=5000&minMarketCap=20000&maxMarketCap=120000&minAge=1&maxAge=168&min6HVol=3333&min1HVol=333&profile=1&launchpads=1'
        ]
    ];

    function createHeaderLinkButton(
        label,
        url
    ) {
        const btn =
            document.createElement(
                'button'
            );

        btn.type = 'button';

        btn.className =
            'dex-header-link';

        btn.textContent =
            label;

        btn.title =
            label;

        btn.addEventListener(
            'click',
            event => {
                event.preventDefault();
                window.location.href =
                    url;
            }
        );

        return btn;
    }

    function insertHeaderQuickLinks() {
        if (
            document.getElementById(
                'dex-header-quick-links'
            )
        ) {
            return;
        }

        const root =
            getHeaderRoot();

        const container =
            document.createElement(
                'div'
            );

        container.id =
            'dex-header-quick-links';

        container.className =
            'dex-header-links';

        HEADER_LINKS.forEach(
            ([label, url]) =>
                container.append(
                    createHeaderLinkButton(
                        label,
                        url
                    )
                )
        );

        if (root.firstElementChild) {
            root.insertBefore(
                container,
                root.firstElementChild
            );
        } else {
            root.appendChild(
                container
            );
        }
    }

    // ================================================================
    // DexScreener list scanning
    // ================================================================

    let scanTimer = null;
    let lastScanTime = 0;
    let scanRunning = false;
    let scanAgain = false;

    function scanDexscreenerLinks() {
        if (scanRunning) {
            scanAgain = true;
            return;
        }

        const now = Date.now();

        if (
            now - lastScanTime <
            MIN_SCAN_INTERVAL
        ) {
            scheduleDexScan(
                MIN_SCAN_INTERVAL -
                    (now - lastScanTime)
            );

            return;
        }

        scanRunning = true;
        lastScanTime = now;

        try {
            cleanupCopyWrappers();

            const anchors = [
                ...document.querySelectorAll(
                    'a.ds-dex-table-row[href*="/solana/"]'
                )
            ];

            for (const anchor of anchors) {
                const pairId =
                    getPairIdFromHref(
                        anchor.href
                    );

                if (!pairId) {
                    continue;
                }

                const row =
                    getRowFromAnchor(
                        anchor
                    );

                row?.classList.toggle(
                    'dex-hidden-row',
                    hiddenPairs.has(
                        pairId
                    )
                );

                const existing =
                    getCopyWrapper(
                        anchor
                    );

                if (existing) {
                    applyHideBtnState(
                        existing.querySelector(
                            'button[data-dex-action-key="toggleHide"]'
                        ),
                        hiddenPairs.has(
                            pairId
                        )
                    );

                    applyLabelUI(
                        existing
                    );
                } else {
                    insertCopyButton(
                        anchor
                    );
                }
            }

            refreshOpenTabStyles();

        } finally {
            scanRunning = false;

            if (scanAgain) {
                scanAgain = false;
                scheduleDexScan(
                    100
                );
            }
        }
    }

    const debouncedScanDexscreenerLinks =
        debounce(
            scanDexscreenerLinks,
            SCAN_DELAY
        );

    function scheduleDexScan(
        delay = SCAN_DELAY
    ) {
        if (scanTimer) {
            clearTimeout(
                scanTimer
            );
        }

        scanTimer = setTimeout(
            () => {
                scanTimer = null;
                scanDexscreenerLinks();
            },
            Math.max(0, delay)
        );
    }

    // ================================================================
    // Lightweight body observer
    // ================================================================

    function nodeContainsPairRow(
        node
    ) {
        if (
            !node ||
            node.nodeType !== 1
        ) {
            return false;
        }

        return Boolean(
            node.matches?.(
                'a.ds-dex-table-row[href*="/solana/"]'
            ) ||
            node.querySelector?.(
                'a.ds-dex-table-row[href*="/solana/"]'
            )
        );
    }

    function attachDexListObserver(
        onActivity
    ) {
        let scheduled = false;

        const schedule = () => {
            if (scheduled) {
                return;
            }

            scheduled = true;

            setTimeout(
                () => {
                    scheduled = false;
                    onActivity();
                },
                SCAN_DELAY
            );
        };

        const observer =
            new MutationObserver(
                records => {
                    let relevant =
                        false;

                    for (
                        const record of
                        records
                    ) {
                        if (
                            isSelfMutation(
                                record
                            )
                        ) {
                            continue;
                        }

                        if (
                            record.type !==
                            'childList'
                        ) {
                            continue;
                        }

                        for (
                            const node of
                            record.addedNodes
                        ) {
                            if (
                                nodeContainsPairRow(
                                    node
                                )
                            ) {
                                relevant =
                                    true;
                                break;
                            }
                        }

                        if (relevant) {
                            break;
                        }

                        for (
                            const node of
                            record.removedNodes
                        ) {
                            if (
                                nodeContainsPairRow(
                                    node
                                )
                            ) {
                                relevant =
                                    true;
                                break;
                            }
                        }

                        if (relevant) {
                            break;
                        }
                    }

                    if (relevant) {
                        schedule();
                    }
                }
            );

        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

        return observer;
    }

    // ================================================================
    // DexScreener observer
    // ================================================================

    function observeDexscreener() {
        initState();

        startOpenTabListener();

        setupActionListeners();

        const onActivity =
            () => {
                insertHeaderQuickLinks();

                debouncedScanDexscreenerLinks();
            };

        setTimeout(
            onActivity,
            SCAN_DELAY
        );

        attachDexListObserver(
            onActivity
        );
    }

    // ================================================================
    // Detail page observer
    // ================================================================

    function observeDexscreenerDetail() {
        initState();

        setupActionListeners();

        const pairId =
            getDetailPairId();

        if (pairId) {
            startOpenTabHeartbeat(
                pairId
            );

            document.addEventListener(
                'visibilitychange',
                () => {
                    if (
                        !document.hidden
                    ) {
                        updateOpenTabEntry(
                            pairId
                        );

                        refreshOpenTabStyles();
                    }
                }
            );

            window.addEventListener(
                'focus',
                () => {
                    updateOpenTabEntry(
                        pairId
                    );
                }
            );

            [
                'beforeunload',
                'pagehide'
            ].forEach(type =>
                window.addEventListener(
                    type,
                    stopOpenTabHeartbeat
                )
            );
        }

        window.addEventListener(
            'storage',
            event => {
                if (
                    event.key ===
                    LABELS_KEY
                ) {
                    loadLabels();
                    refreshLabelsUI();
                }
            }
        );

        let scheduled = false;

        const scheduleDetail =
            () => {
                if (scheduled) {
                    return;
                }

                scheduled = true;

                setTimeout(
                    () => {
                        scheduled = false;
                        insertDetailActionButtons();
                    },
                    SCAN_DELAY
                );
            };

        const observer =
            new MutationObserver(
                records => {
                    if (
                        records.every(
                            isSelfMutation
                        )
                    ) {
                        return;
                    }

                    scheduleDetail();
                }
            );

        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

        setTimeout(
            insertDetailActionButtons,
            SCAN_DELAY
        );
    }

    // ================================================================
    // Initialization
    // ================================================================

    function initState() {
        loadPairInfoCache();
        loadHiddenPairs();
        loadLabels();
        injectStyles();
    }

    function setupActionListeners() {
        if (
            document.body.dataset
                .dexActionListeners === '1'
        ) {
            return;
        }

        document.body.dataset
            .dexActionListeners = '1';

        document.body.addEventListener(
            'click',
            handleDexActionEvent
        );

        document.body.addEventListener(
            'auxclick',
            handleDexActionEvent
        );

        document.body.addEventListener(
            'contextmenu',
            handleDexActionContextMenu
        );
    }

    // ================================================================
    // Bootstrap
    // ================================================================

    if (isDexscreenerHost()) {
        if (isDetailPage()) {
            observeDexscreenerDetail();
        } else {
            observeDexscreener();
        }
    }

    // ================================================================
    // Tampermonkey menu commands
    // ================================================================

    if (
        typeof GM_registerMenuCommand ===
        'function'
    ) {
        GM_registerMenuCommand(
            'Copy DEX pair addresses',
            () => copyPairs()
        );

        GM_registerMenuCommand(
            'Copy DEX addresses + labels',
            () =>
                copyPairs('labels')
        );

        GM_registerMenuCommand(
            'Export visible tokens to TXT',
            () => exportPairsToTxt()
        );

        GM_registerMenuCommand(
            'Clear pair info cache',
            clearAllPairInfoCache
        );

        GM_registerMenuCommand(
            'Label current pair…',
            () => {
                const pairId =
                    getDetailPairId();

                if (!pairId) {
                    showToast(
                        'Open a pair page first'
                    );

                    return;
                }

                openLabelEditor(
                    pairId,
                    null
                );
            }
        );

        GM_registerMenuCommand(
            'Export labels (copy JSON)',
            () => {
                loadLabels();

                writeClipboard(
                    JSON.stringify(
                        pairLabels,
                        null,
                        2
                    )
                )
                    .then(() =>
                        showToast(
                            `Copied ${Object.keys(pairLabels).length} labels as JSON`
                        )
                    )
                    .catch(() =>
                        alert(
                            JSON.stringify(
                                pairLabels,
                                null,
                                2
                            )
                        )
                    );
            }
        );

        GM_registerMenuCommand(
            'Import labels (paste JSON)',
            () => {
                const raw =
                    prompt(
                        'Paste labels JSON (merges with existing):'
                    );

                if (!raw) {
                    return;
                }

                let parsed;

                try {
                    parsed =
                        JSON.parse(raw);
                } catch {
                    showToast(
                        'Invalid JSON'
                    );

                    return;
                }

                if (
                    !parsed ||
                    typeof parsed !==
                        'object'
                ) {
                    showToast(
                        'Invalid JSON'
                    );

                    return;
                }

                let count = 0;

                for (
                    const [
                        pairId,
                        entry
                    ] of Object.entries(
                        parsed
                    )
                ) {
                    const text =
                        typeof entry ===
                        'string'
                            ? entry
                            : entry?.text;

                    if (
                        typeof text !==
                            'string' ||
                        !text.trim()
                    ) {
                        continue;
                    }

                    pairLabels[pairId] =
                        {
                            text: text
                                .trim()
                                .slice(
                                    0,
                                    MAX_LABEL_LEN
                                ),

                            color:
                                (
                                    typeof entry ===
                                        'object' &&
                                    entry.color
                                ) ||
                                DEFAULT_LABEL_COLOR,

                            ts: Date.now()
                        };

                    count++;
                }

                saveLabels();
                refreshLabelsUI();

                showToast(
                    `Imported ${count} labels`
                );
            }
        );

        GM_registerMenuCommand(
            'Clear all labels',
            () => {
                if (
                    !confirm(
                        'Delete ALL coin labels?'
                    )
                ) {
                    return;
                }

                pairLabels =
                    Object.create(
                        null
                    );

                saveLabels();
                refreshLabelsUI();

                showToast(
                    'All labels cleared'
                );
            }
        );

        GM_registerMenuCommand(
            'Clear hidden/crossed-out coins',
            () => {
                hiddenPairs.clear();

                saveHiddenPairs();

                document
                    .querySelectorAll(
                        '.dex-hidden-row'
                    )
                    .forEach(el =>
                        el.classList.remove(
                            'dex-hidden-row'
                        )
                    );

                document
                    .querySelectorAll(
                        'button[data-dex-action-key="toggleHide"]'
                    )
                    .forEach(btn =>
                        applyHideBtnState(
                            btn,
                            false
                        )
                    );

                showToast(
                    'Hidden coins cleared'
                );
            }
        );
    }
})();
