// ==UserScript==
// @name         Dex Pair Clipboard
// @namespace    http://example.com/
// @version      1.0
// @description  Copy Solana DEX pair addresses from links on any page
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    function formatTicker(ticker) {
        const normalized = ticker.replace(/^(#\d+)([A-Za-z].*)$/, '$1 $2');
        return normalized.trim();
    }

    function buildResult(pairs) {
        return Array.from(pairs.keys()).join("\n");
    }

    function writeClipboard(text) {
        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(text);
            return Promise.resolve();
        }
        return navigator.clipboard.writeText(text);
    }

    function showToast(message, duration = 1800) {
        const existing = document.getElementById('dex-pair-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'dex-pair-toast';
        toast.textContent = message;
        toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483648;background:rgba(20,20,20,.95);color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:system-ui,sans-serif;font-size:13px;pointer-events:none;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), duration);
    }

    function getPairIdFromHref(href) {
        if (!href) return null;
        const match = href.match(/\/solana\/([A-Za-z0-9]{32,44})(?:\/|[?#].*)?$/);
        return match ? match[1] : null;
    }

    function getAddressFromHref(href) {
        if (!href) return null;
        const match = href.match(/([A-Za-z0-9]{32,44})/);
        return match ? match[1] : null;
    }

    function getCopyWrapper(anchor) {
        const next = anchor.nextElementSibling;
        return next && next.dataset?.dexCopyWrapper === '1' ? next : null;
    }

    function getRowFromAnchor(anchor) {
        if (!anchor) return null;
        if (anchor.closest) {
            return anchor.closest('a.ds-dex-table-row') || anchor;
        }
        return anchor;
    }

    function cleanupCopyWrappers() {
        document.querySelectorAll('span[data-dex-copy-wrapper="1"]').forEach(wrapper => {
            const anchor = wrapper.previousElementSibling;
            if (!anchor || anchor.tagName !== 'A' || getPairIdFromHref(anchor.href) !== wrapper.dataset.pairId) {
                wrapper.remove();
            }
        });
    }

    function debounce(fn, delay = 200) {
        let timeout = null;
        return (...args) => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                timeout = null;
                fn(...args);
            }, delay);
        };
    }

    const pairInfoCacheKey = 'dex-enhance-pair-info-cache';
    const pairInfoCacheTTL = 5 * 60 * 1000;
    const pairInfoCache = new Map();
    let copyPairsInProgress = false;

    function loadPairInfoCache() {
        try {
            const raw = localStorage.getItem(pairInfoCacheKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            const now = Date.now();
            Object.entries(parsed).forEach(([pairId, entry]) => {
                if (!entry || typeof entry !== 'object') return;
                if (typeof entry.timestamp !== 'number' || !entry.data) return;
                if (now - entry.timestamp > pairInfoCacheTTL) return;
                pairInfoCache.set(pairId, entry);
            });
        } catch (e) {
            console.warn('Failed to load pair info cache', e);
        }
    }

    function savePairInfoCache() {
        try {
            const now = Date.now();
            const payload = {};
            pairInfoCache.forEach((entry, pairId) => {
                if (now - entry.timestamp <= pairInfoCacheTTL) {
                    payload[pairId] = entry;
                }
            });
            localStorage.setItem(pairInfoCacheKey, JSON.stringify(payload));
        } catch (e) {
            console.warn('Failed to save pair info cache', e);
        }
    }

    function getCachedPairInfo(pairId) {
        const entry = pairInfoCache.get(pairId);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > pairInfoCacheTTL) {
            pairInfoCache.delete(pairId);
            return null;
        }
        return entry.data;
    }

    function cachePairInfo(pairId, data) {
        if (!pairId || !data) return;
        pairInfoCache.set(pairId, { timestamp: Date.now(), data });
        savePairInfoCache();
    }

    function scheduleIdle(fn) {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(fn, { timeout: 1000 });
        } else {
            setTimeout(fn, 0);
        }
    }

    function normalizeStoredNumber(value) {
        if (typeof value === 'number' && !Number.isNaN(value)) {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = Number(value.replace(/[^0-9\.\-]/g, ''));
            if (!Number.isNaN(parsed)) return parsed;
        }
        return null;
    }

    function getDexScreenerMutationRoot() {
        const selectors = [
            '.ds-dex-table',
            '[data-testid="pairs-scrollable"]',
            '.scroller',
            '.pair-list',
            'main',
            '#app'
        ];
        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target) return target;
        }
        const anchor = document.querySelector('a.ds-dex-table-row');
        return (anchor && anchor.parentElement) || document.body;
    }

    async function fetchPairInfo(pairId) {
        const cached = getCachedPairInfo(pairId);
        const url = 'https://api.dexscreener.com/latest/dex/pairs/solana/' + pairId;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                if (cached) return cached;
                throw new Error('Dexscreener API failed: ' + response.status);
            }
            const json = await response.json();
            const pair = Array.isArray(json.pairs) ? json.pairs[0] : json.pair || null;
            if (!pair) {
                if (cached) return cached;
                throw new Error('Pair data missing for ' + pairId);
            }
            cachePairInfo(pairId, pair);
            return pair;
        } catch (e) {
            if (cached) return cached;
            throw e;
        }
    }

    async function copyPairs(mode = 'tokens') {
        if (copyPairsInProgress) {
            showToast('Copy already in progress');
            return;
        }
        copyPairsInProgress = true;
        try {
            const pairs = new Map();
            const pairIds = new Set();
            const anchors = Array.from(document.querySelectorAll('a[href*="/solana/"]'));
            const isDexscreener = location.hostname.includes('dexscreener');

            for (const anchor of anchors) {
                const pairId = getPairIdFromHref(anchor.href);
                if (!pairId) continue;
                pairIds.add(pairId);
            }

            if (pairIds.size === 0) {
                showToast('No Solana pair links found');
                return;
            }

            if (isDexscreener) {
                const fetchPromises = Array.from(pairIds).map(async pairId => {
                    try {
                        const pair = await fetchPairInfo(pairId);
                        const outputAddress = mode === 'contracts' ? pair.pairAddress : pair.baseToken?.address || pair.pairAddress;
                        const ticker = mode === 'contracts' ? '' : pair.baseToken?.symbol || '';
                        const name = mode === 'contracts' ? '' : pair.baseToken?.name || '';
                        const existing = pairs.get(outputAddress);
                        if (existing) {
                            pairs.set(outputAddress, {
                                ticker: existing.ticker || ticker,
                                name: existing.name || name,
                                pairAddress: existing.pairAddress || pair.pairAddress
                            });
                        } else {
                            pairs.set(outputAddress, { ticker, name, pairAddress: pair.pairAddress });
                        }
                    } catch (e) {
                        console.warn('Failed to fetch pair', pairId, e);
                    }
                });
                await Promise.all(fetchPromises);
            } else {
                anchors.forEach(a => {
                    const address = getPairIdFromHref(a.href) || getAddressFromHref(a.href);
                    if (!address) return;
                    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
                    const tokenMatch = text.match(/(.+?)\s*\/\s*SOL\s*(.+)/i);
                    const ticker = tokenMatch ? tokenMatch[1].trim() : '';
                    let name = tokenMatch ? tokenMatch[2].trim() : '';
                    if (name) {
                        name = name.replace(/\s*\$\S.*$/, '').trim();
                    }
                    const existing = pairs.get(address);
                    if (existing) {
                        pairs.set(address, {
                            ticker: existing.ticker || ticker,
                            name: existing.name || name
                        });
                    } else {
                        pairs.set(address, { ticker, name });
                    }
                });
            }

            const result = buildResult(pairs, mode);
            writeClipboard(result).then(() => {
                showToast('Copied ' + pairs.size + ' addresses to clipboard');
            }).catch(() => {
                alert('Failed to copy automatically; please use the overlay text box.');
                showResultOverlay(pairs, mode);
            });
        } finally {
            copyPairsInProgress = false;
        }
    }

    async function copySingleAddress(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.baseToken?.address || pair.pairAddress;
            await writeClipboard(address);
            showToast('Copied token contract address');
        } catch (e) {
            console.warn('copySingleAddress failed', e);
            alert('Unable to copy contract address automatically.');
        }
    }

    async function openGmgn(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.baseToken?.address || pair.pairAddress;
            window.open('https://gmgn.ai/sol/token/' + encodeURIComponent(address), '_blank');
        } catch (e) {
            console.warn('openGmgn failed', e);
            alert('Unable to open GMGN for this contract.');
        }
    }

    async function openTwitterCa(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.baseToken?.address || pair.pairAddress;
            window.open('https://twitter.com/search?q=' + encodeURIComponent(address), '_blank');
        } catch (e) {
            console.warn('openTwitterCa failed', e);
            alert('Unable to open Twitter search for this contract.');
        }
    }

    async function openTwitterTicker(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const symbol = pair.baseToken?.symbol || '';
            if (!symbol) throw new Error('Ticker missing');
            const query = '$' + symbol.replace(/^[^A-Za-z0-9]+/, '');
            window.open('https://twitter.com/search?q=' + encodeURIComponent(query), '_blank');
        } catch (e) {
            console.warn('openTwitterTicker failed', e);
            alert('Unable to open Twitter search for this ticker.');
        }
    }

    function showIframeOverlay(title, url) {
        const existing = document.getElementById('dex-iframe-overlay');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = 'dex-iframe-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483660;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;padding:14px;backdrop-filter:blur(5px);';
        const frameWrapper = document.createElement('div');
        frameWrapper.style.cssText = 'position:relative;width:95%;max-width:1200px;height:92%;background:#111;border:1px solid rgba(255,255,255,0.12);border-radius:14px;overflow:hidden;box-shadow:0 0 60px rgba(0,0,0,.6);';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:rgba(20,20,20,0.96);border-bottom:1px solid rgba(255,255,255,0.08);color:#fff;font-family:system-ui,sans-serif;font-size:13px;';
        const headerTitle = document.createElement('div');
        headerTitle.textContent = title;
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = 'âœ•';
        closeButton.style.cssText = 'padding:6px 10px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;cursor:pointer;font-size:13px;';
        closeButton.addEventListener('click', () => overlay.remove());
        header.append(headerTitle, closeButton);
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.style.cssText = 'width:100%;height:calc(100% - 46px);border:none;background:#000;';
        iframe.allow = 'fullscreen';
        frameWrapper.append(header, iframe);
        overlay.appendChild(frameWrapper);
        document.body.appendChild(overlay);
    }

    async function openBubble(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.baseToken?.address || pair.pairAddress;
            const url = 'https://v2.bubblemaps.io/map?address=' + encodeURIComponent(address) + '&chain=solana&limit=80';
            showIframeOverlay('BubbleMaps', url);
        } catch (e) {
            console.warn('openBubble failed', e);
            alert('Unable to open Bubble for this contract.');
        }
    }

    async function openPumpFun(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.baseToken?.address || pair.pairAddress;
            window.open('https://pump.fun/coin/' + encodeURIComponent(address), '_blank');
        } catch (e) {
            console.warn('openPumpFun failed', e);
            alert('Unable to open pump.fun for this contract.');
        }
    }

    async function openSolscan(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.baseToken?.address || pair.pairAddress;
            window.open('https://solscan.io/token/' + encodeURIComponent(address), '_blank');
        } catch (e) {
            console.warn('openSolscan failed', e);
            alert('Unable to open Solscan for this contract.');
        }
    }

    async function openDexTools(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.pairAddress || pair.baseToken?.address;
            window.open('https://www.dextools.io/app/solana/pair-explorer/' + encodeURIComponent(address), '_blank');
        } catch (e) {
            console.warn('openDexTools failed', e);
            alert('Unable to open DexTools for this contract.');
        }
    }

    async function openTelegram(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const symbol = pair.baseToken?.symbol || pair.pairAddress || pair.pairAddress;
            const query = symbol ? '$' + symbol.replace(/^[^A-Za-z0-9]+/, '') : pair.pairAddress;
            window.open('https://t.me/search?q=' + encodeURIComponent(query), '_blank');
        } catch (e) {
            console.warn('openTelegram failed', e);
            alert('Unable to open Telegram search for this contract.');
        }
    }

    function showResultOverlay(pairs, mode = 'tokens') {
        const result = buildResult(pairs, mode);
        const existing = document.getElementById('dex-pair-clipboard-overlay');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = 'dex-pair-clipboard-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.85);color:#eee;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(4px);';
        overlay.innerHTML = '<div style="max-width:100%;width:760px;background:#111;border:1px solid #444;border-radius:12px;overflow:hidden;box-shadow:0 0 60px rgba(0,0,0,.6);">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#131313;border-bottom:1px solid #333;font-family:system-ui,sans-serif;font-size:14px;">' +
            '<span>DEX Contract Addresses</span>' +
            '<button id="dex-pair-clipboard-close" style="border:none;background:#2a2a2a;color:#eee;padding:6px 12px;border-radius:8px;cursor:pointer;">Close</button>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;background:#111;">' +
            '<button id="dex-copy-contracts" style="border:none;background:#2a2a2a;color:#eee;padding:8px 12px;border-radius:8px;cursor:pointer;">Copy pair CAs</button>' +
            '<button id="dex-copy-tokens" style="border:none;background:#2a2a2a;color:#eee;padding:8px 12px;border-radius:8px;cursor:pointer;">Copy token CAs</button>' +
            '</div>' +
            '<textarea id="dex-pair-clipboard-textarea" readonly style="width:100%;height:56vh;padding:16px;border:none;background:#000;color:#0f0;font-family:monospace,ui-monospace,sans-serif;font-size:13px;line-height:1.4;resize:none;outline:none;box-sizing:border-box;">' + result + '</textarea>' +
            '</div>';
        document.body.appendChild(overlay);
        const textarea = document.getElementById('dex-pair-clipboard-textarea');
        const updateTextarea = newMode => {
            textarea.textContent = buildResult(pairs, newMode);
        };
        document.getElementById('dex-copy-contracts').addEventListener('click', () => {
            const value = buildResult(pairs);
            writeClipboard(value).then(() => {
                showToast('Copied ' + pairs.size + ' pair CAs to clipboard');
            });
            updateTextarea('contracts');
        });
        document.getElementById('dex-copy-tokens').addEventListener('click', () => {
            const value = buildResult(pairs);
            writeClipboard(value).then(() => {
                showToast('Copied ' + pairs.size + ' token CAs to clipboard');
            });
            updateTextarea('tokens');
        });
        document.getElementById('dex-pair-clipboard-close').addEventListener('click', () => overlay.remove());
    }

    function insertCopyButton(anchor) {
        const row = getRowFromAnchor(anchor);
        if (!row) return;
        const pairId = getPairIdFromHref(anchor.href);
        if (!pairId) return;
        const existing = getCopyWrapper(anchor);
        if (existing) {
            if (existing.dataset.pairId === pairId) {
                return existing;
            }
            existing.remove();
        }

        const wrapper = document.createElement('span');
        wrapper.dataset.dexCopyWrapper = '1';
        wrapper.dataset.pairId = pairId;
        wrapper.style.display = 'inline-flex';
        wrapper.style.gap = '4px';
        wrapper.style.alignItems = 'center';
        wrapper.style.marginLeft = '6px';

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.textContent = 'CA';
        copyButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(38,166,154,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        copyButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            copySingleAddress(pairId);
        });

        const gmgnButton = document.createElement('button');
        gmgnButton.type = 'button';
        gmgnButton.textContent = 'GMGN';
        gmgnButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(66,133,244,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        gmgnButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openGmgn(pairId);
        });

        const xcaButton = document.createElement('button');
        xcaButton.type = 'button';
        xcaButton.textContent = 'X CA';
        xcaButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(255,99,71,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        xcaButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openTwitterCa(pairId);
        });

        const xtickerButton = document.createElement('button');
        xtickerButton.type = 'button';
        xtickerButton.textContent = 'X $';
        xtickerButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(155,89,182,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        xtickerButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openTwitterTicker(pairId);
        });

        const bubbleButton = document.createElement('button');
        bubbleButton.type = 'button';
        bubbleButton.textContent = '\u{1FAE7}';
        bubbleButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(0,150,136,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        bubbleButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openBubble(pairId);
        });

        const pumpFunButton = document.createElement('button');
        pumpFunButton.type = 'button';
        pumpFunButton.textContent = '\u{1F680}';
        pumpFunButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(255,161,0,0.95);color:#111;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        pumpFunButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openPumpFun(pairId);
        });

        const solscanButton = document.createElement('button');
        solscanButton.type = 'button';
        solscanButton.textContent = 'SC';
        solscanButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(0,122,255,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        solscanButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openSolscan(pairId);
        });

        const dexToolsButton = document.createElement('button');
        dexToolsButton.type = 'button';
        dexToolsButton.textContent = 'DT';
        dexToolsButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(123,0,255,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        dexToolsButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openDexTools(pairId);
        });

        const telegramButton = document.createElement('button');
        telegramButton.type = 'button';
        telegramButton.textContent = 'TG';
        telegramButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(0,136,204,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        telegramButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openTelegram(pairId);
        });

        copyButton.dataset.dexActionKey = 'ca';
        gmgnButton.dataset.dexActionKey = 'gmgn';
        xcaButton.dataset.dexActionKey = 'xca';
        xtickerButton.dataset.dexActionKey = 'xticker';
        bubbleButton.dataset.dexActionKey = 'bubble';
        pumpFunButton.dataset.dexActionKey = 'pumpfun';
        solscanButton.dataset.dexActionKey = 'solscan';
        dexToolsButton.dataset.dexActionKey = 'dextools';
        telegramButton.dataset.dexActionKey = 'telegram';
        [copyButton, gmgnButton, xcaButton, xtickerButton, bubbleButton, pumpFunButton, solscanButton, dexToolsButton, telegramButton].forEach(btn => {
            btn.dataset.dexActionButton = '1';
        });
        wrapper.append(copyButton, gmgnButton, xcaButton, xtickerButton, bubbleButton, pumpFunButton, solscanButton, dexToolsButton, telegramButton);
        anchor.insertAdjacentElement('afterend', wrapper);
        return null;
    }

    const debouncedScanDexscreenerLinks = debounce(scanDexscreenerLinks, 100);

    function scanDexscreenerLinks() {
        cleanupCopyWrappers();
        const anchors = document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]');
        anchors.forEach(anchor => {
            const pairId = getPairIdFromHref(anchor.href);
            if (!pairId) return;
            const existing = getCopyWrapper(anchor);
            if (existing) return;
            insertCopyButton(anchor);
            anchor.dataset.dexEnhanced = '1';
        });
    }

    function observeDexscreener() {
        loadPairInfoCache();
        scanDexscreenerLinks();
        const observer = new MutationObserver(debouncedScanDexscreenerLinks);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        setInterval(scanDexscreenerLinks, 2500);
    }

    if (location.hostname.includes('dexscreener')) {
        observeDexscreener();
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand("Copy DEX pair addresses", copyPairs);
    }
})();


