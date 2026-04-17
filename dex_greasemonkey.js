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

    function showInfoPanel(message, type = 'info') {
        const existing = document.getElementById('dex-pair-info-panel');
        if (existing) existing.remove();
        const panel = document.createElement('div');
        panel.id = 'dex-pair-info-panel';
        const color = type === 'error' ? '#e74c3c' : type === 'warn' ? '#f39c12' : '#1abc9c';
        panel.style.cssText = 'position:fixed;top:88px;right:16px;z-index:2147483650;max-width:320px;background:rgba(17,22,28,0.96);border-left:4px solid ' + color + ';padding:12px 14px;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.45);color:#fff;font-family:system-ui,sans-serif;font-size:13px;line-height:1.5;';
        panel.innerHTML = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">' +
            '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:700;margin-bottom:6px;">' + (type === 'error' ? 'Error' : type === 'warn' ? 'Warning' : 'Info') + '</div>' +
            '<div style="white-space:pre-wrap;word-break:break-word;">' + String(message).replace(/\n/g, '<br>') + '</div>' +
            '</div>' +
            '<button id="dex-pair-info-close" style="border:none;background:transparent;color:#fff;font-size:16px;cursor:pointer;line-height:1;">✕</button>' +
            '</div>';
        document.body.appendChild(panel);
        document.getElementById('dex-pair-info-close').addEventListener('click', () => panel.remove());
        setTimeout(() => panel.remove(), 12000);
    }

    function getPairIdFromHref(href) {
        const match = href.match(/\/solana\/([A-Za-z0-9]{32,44})$/);
        return match ? match[1] : null;
    }

    function getCopyWrapper(anchor) {
        const next = anchor.nextElementSibling;
        return next && next.dataset?.dexCopyWrapper === '1' ? next : null;
    }

    const mcapMonitors = new Map();
    const monitorStorageKey = 'dex-enhance-mcap-monitors';
    let monitorSortDescending = true;
    let mcapMonitorPollHandle = null;
    let autoMonitorNewPairs = false;

    function loadStoredMonitors() {
        try {
            const raw = localStorage.getItem(monitorStorageKey);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.reduce((acc, pairId) => {
                    if (typeof pairId === 'string') acc[pairId] = {};
                    return acc;
                }, {});
            }
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
            return {};
        } catch (e) {
            console.warn('Failed to load stored monitors', e);
            return {};
        }
    }

    function saveStoredMonitors(monitors) {
        try {
            localStorage.setItem(monitorStorageKey, JSON.stringify(monitors));
        } catch (e) {
            console.warn('Failed to save stored monitors', e);
        }
    }

    function addMonitorToStorage(pairId, startValue, addedAt, addedMcap) {
        const stored = loadStoredMonitors();
        stored[pairId] = {
            startValue: typeof startValue === 'number' ? startValue : stored[pairId]?.startValue || null,
            addedAt: addedAt ? addedAt.toISOString() : stored[pairId]?.addedAt || new Date().toISOString(),
            addedMcap: typeof addedMcap === 'number' ? addedMcap : stored[pairId]?.addedMcap || null
        };
        saveStoredMonitors(stored);
    }

    function removeMonitorFromStorage(pairId) {
        const stored = loadStoredMonitors();
        delete stored[pairId];
        saveStoredMonitors(stored);
    }

    function restoreMonitors() {
        const stored = loadStoredMonitors();
        const keys = Object.keys(stored);
        if (!keys.length) return;
        const anchors = Array.from(document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]'));
        keys.forEach(pairId => {
            if (mcapMonitors.has(pairId)) return;
            const anchor = anchors.find(a => getPairIdFromHref(a.href) === pairId);
            if (!anchor) return;
            const button = anchor.nextElementSibling?.querySelector('button[data-dex-mcap-button="1"]');
            if (!button) return;
            const storedData = stored[pairId] || {};
            const startValue = typeof storedData.startValue === 'number' ? storedData.startValue : null;
            const addedAt = storedData.addedAt ? new Date(storedData.addedAt) : null;
            const addedMcap = typeof storedData.addedMcap === 'number' ? storedData.addedMcap : null;
            startMcapMonitor(pairId, anchor, button, true, startValue, addedAt, addedMcap);
        });
    }

    function getPercentChangeValue(startValue, currentValue) {
        if (startValue === null || currentValue === null || startValue === 0) return 0;
        return ((currentValue - startValue) / startValue) * 100;
    }

    function cleanupCopyWrappers() {
        document.querySelectorAll('span[data-dex-copy-wrapper="1"]').forEach(wrapper => {
            const anchor = wrapper.previousElementSibling;
            if (!anchor || anchor.tagName !== 'A') {
                wrapper.remove();
                return;
            }
            const pairId = getPairIdFromHref(anchor.href);
            if (!pairId || wrapper.dataset.pairId !== pairId) {
                wrapper.remove();
            }
        });
    }

    function parseMcapValue(text) {
        if (!text) return null;
        const cleaned = text.replace(/[^0-9\.KMGBkmgb]/g, '').trim();
        if (!cleaned) return null;
        const number = parseFloat(cleaned);
        if (Number.isNaN(number)) return null;
        if (/k$/i.test(cleaned)) return number * 1e3;
        if (/m$/i.test(cleaned)) return number * 1e6;
        if (/b$/i.test(cleaned)) return number * 1e9;
        return number;
    }

    function getMcapCell(row) {
        return row.querySelector('.ds-dex-table-row-col-market-cap');
    }

    function getRowFromAnchor(anchor) {
        return anchor.closest('a.ds-dex-table-row');
    }

    function findMcapRowForPair(pairId) {
        const anchors = Array.from(document.querySelectorAll('a[href*="/solana/"]'));
        const anchor = anchors.find(a => getPairIdFromHref(a.href) === pairId);
        if (!anchor) return null;
        const row = getRowFromAnchor(anchor);
        if (!row) return null;
        const cell = getMcapCell(row);
        return cell ? { row, cell } : null;
    }

    function getTokenLabel(row) {
        const tokenCell = row.querySelector('.ds-dex-table-row-col-token');
        if (!tokenCell) return 'Unknown';
        let text = tokenCell.textContent.replace(/\n/g, ' ').trim();
        text = text.replace(/^#\d+\s*/, '');
        const match = text.match(/^(.*?)\s*\/\s*SOL/i);
        if (match && match[1]) text = match[1].trim();
        return text.slice(0, 28);
    }

    function formatMcapDisplay(value) {
        if (value === null || value === undefined) return 'n/a';
        const formatSuffix = (num, suffix) => {
            const scaled = num;
            const rounded = Math.round(scaled);
            if (rounded === scaled) return '$' + rounded + suffix;
            return '$' + scaled.toFixed(1).replace(/\.0$/, '') + suffix;
        };
        if (value >= 1e9) return formatSuffix(value / 1e9, 'B');
        if (value >= 1e6) return formatSuffix(value / 1e6, 'M');
        if (value >= 1e3) return formatSuffix(value / 1e3, 'K');
        return '$' + Math.round(value);
    }

    function formatPercentChange(startValue, currentValue) {
        if (startValue === null || currentValue === null || startValue === 0) return 'n/a';
        const percent = ((currentValue - startValue) / startValue) * 100;
        return (percent >= 0 ? '+' : '') + percent.toFixed(1) + '%';
    }

    function formatMonitorDate(date) {
        if (!(date instanceof Date)) return 'unknown';
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatMonitorAge(date) {
        if (!(date instanceof Date)) return 'unknown';
        const ms = Date.now() - date.getTime();
        const mins = Math.floor(ms / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        const hours = Math.floor(mins / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.floor(hours / 24);
        return days + 'd ago';
    }

    function getMonitorPanel() {
        return document.getElementById('dex-mcap-monitor-panel');
    }

    function updateMonitorSortButton() {
        const button = document.getElementById('dex-mcap-sort');
        if (button) {
            button.textContent = monitorSortDescending ? 'Sort % ↓' : 'Sort % ↑';
        }
    }

    function updateMonitorPanel() {
        const panel = getMonitorPanel();
        if (!panel) return;
        const list = panel.querySelector('.dex-mcap-monitor-list');
        const count = panel.querySelector('.dex-mcap-monitor-count');
        if (!list || !count) return;
        const monitors = Array.from(mcapMonitors.values());
        monitors.sort((a, b) => {
            const aChange = getPercentChangeValue(a.startValue, a.lastValue);
            const bChange = getPercentChangeValue(b.startValue, b.lastValue);
            return monitorSortDescending ? bChange - aChange : aChange - bChange;
        });
        count.textContent = monitors.length + ' active';
        list.innerHTML = '';
        if (monitors.length === 0) {
            list.innerHTML = '';
            const monitorAllFallback = document.createElement('button');
            monitorAllFallback.type = 'button';
            monitorAllFallback.textContent = 'Monitor all';
            monitorAllFallback.style.cssText = 'padding:8px 12px;border:none;border-radius:10px;background:#26a69a;color:#111;font-size:12px;cursor:pointer;';
            monitorAllFallback.addEventListener('click', () => {
                addAllMcapMonitors();
            });
            list.appendChild(monitorAllFallback);
            return;
        }
        monitors.forEach(item => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:12px;color:#ddd;';
            const labelContainer = document.createElement('div');
            labelContainer.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-width:130px;';
            const label = document.createElement('span');
            label.textContent = item.label;
            label.style.cssText = 'cursor:pointer;text-decoration:underline;color:#9af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            label.title = 'Open Dexscreener token page';
            label.addEventListener('click', () => {
                window.open('https://dexscreener.com/solana/' + encodeURIComponent(item.pairId), '_blank');
            });
            const added = document.createElement('span');
            added.textContent = 'added ' + formatMonitorDate(item.addedAt) + ' (' + formatMonitorAge(item.addedAt) + ') @ ' + formatMcapDisplay(item.addedMcap);
            added.style.cssText = 'font-size:10px;color:#999;line-height:1.2;';
            labelContainer.append(label, added);
            const status = document.createElement('span');
            const percentText = formatPercentChange(item.startValue, item.lastValue);
            status.innerHTML = formatMcapDisplay(item.lastValue) + ' (<span style="color:' + (percentText.startsWith('-') ? '#f56' : '#7cfa8e') + ';">' + percentText + '</span>)';
            const stop = document.createElement('button');
            stop.type = 'button';
            stop.textContent = '✕';
            stop.title = 'Remove monitor';
            stop.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(255,255,255,0.08);color:#fff;font-size:12px;cursor:pointer;';
            stop.addEventListener('click', () => {
                item.observer.disconnect();
                mcapMonitors.delete(item.pairId);
                removeMonitorFromStorage(item.pairId);
                if (mcapMonitors.size === 0) stopMcapPolling();
                item.button.textContent = 'Monitor';
                item.button.style.opacity = '1';
                updateMonitorPanel();
                showToast('Removed monitor for ' + item.pairId);
            });
            row.append(labelContainer, status, stop);
            list.appendChild(row);
        });
    }

    function stopMcapPolling() {
        if (mcapMonitorPollHandle !== null) {
            clearInterval(mcapMonitorPollHandle);
            mcapMonitorPollHandle = null;
        }
    }

    function startMcapPolling() {
        if (mcapMonitorPollHandle !== null) return;
        mcapMonitorPollHandle = setInterval(() => {
            mcapMonitors.forEach(item => {
                if (!document.body.contains(item.row)) {
                    const fallback = findMcapRowForPair(item.pairId);
                    if (!fallback) return;
                    item.row = fallback.row;
                    item.cell = fallback.cell;
                }
                const currentCell = item.cell || getMcapCell(item.row);
                if (!currentCell) return;
                const newValue = parseMcapValue(currentCell.textContent);
                if (newValue === null || newValue === item.lastValue) return;
                item.lastValue = newValue;
                updateMonitorPanel();
            });
        }, 2000);
    }

    function stopAllMcapMonitors() {
        mcapMonitors.forEach(item => item.observer.disconnect());
        mcapMonitors.clear();
        autoMonitorNewPairs = false;
        const autoMonitorButton = document.getElementById('dex-auto-monitor-toggle');
        if (autoMonitorButton) {
            autoMonitorButton.textContent = 'Auto monitor OFF';
        }
        stopMcapPolling();
        saveStoredMonitors({});
        document.querySelectorAll('button').forEach(btn => {
            if (btn.textContent === 'Monitoring') {
                btn.textContent = 'Monitor';
                btn.style.opacity = '1';
            }
        });
        updateMonitorPanel();
        showToast('Removed all monitors');
    }

    function addAllMcapMonitors() {
        const anchors = Array.from(document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]'));
        let count = 0;
        anchors.forEach(anchor => {
            const pairId = getPairIdFromHref(anchor.href);
            if (!pairId || mcapMonitors.has(pairId)) return;
            const button = anchor.nextElementSibling?.querySelector('button[data-dex-mcap-button="1"]');
            if (!button) return;
            startMcapMonitor(pairId, anchor, button, true);
            count += 1;
        });
        showToast(count > 0 ? 'Started ' + count + ' MCap monitors' : 'No new MCap monitors found');
    }

    function startMcapMonitor(pairId, anchor, button, silent = false, persistedStartValue = null, persistedAddedAt = null, persistedAddedMcap = null) {
        const existing = mcapMonitors.get(pairId);
        if (existing) {
            existing.observer.disconnect();
            mcapMonitors.delete(pairId);
            removeMonitorFromStorage(pairId);
            button.textContent = 'Monitor';
            button.style.opacity = '1';
            updateMonitorPanel();
            if (!silent) showToast('Removed monitor');
            return;
        }

        const row = getRowFromAnchor(anchor);
        if (!row) {
            showInfoPanel('Unable to find row for MCap monitor.', 'error');
            return;
        }
        const cell = getMcapCell(row);
        if (!cell) {
            showInfoPanel('Unable to find MCap cell for this row.', 'error');
            return;
        }
        const currentValue = parseMcapValue(cell.textContent);
        if (currentValue === null) {
            showInfoPanel('Unable to parse current MCap.', 'error');
            return;
        }
        const startValue = typeof persistedStartValue === 'number' && persistedStartValue > 0 ? persistedStartValue : currentValue;
        const addedAt = persistedAddedAt instanceof Date && !Number.isNaN(persistedAddedAt.getTime()) ? persistedAddedAt : new Date();
        const addedMcap = typeof persistedAddedMcap === 'number' && persistedAddedMcap > 0 ? persistedAddedMcap : currentValue;
        const label = getTokenLabel(row);

        let lastValue = currentValue;
        let currentRow = row;
        let currentCell = cell;
        const item = { observer: null, button, pairId, row: currentRow, cell: currentCell, lastValue, startValue, label, addedAt, addedMcap };
        const ensureRowAndCell = () => {
            if (currentCell && currentRow && document.body.contains(currentRow)) {
                return true;
            }
            const fallback = findMcapRowForPair(pairId);
            if (!fallback) return false;
            currentRow = fallback.row;
            currentCell = fallback.cell;
            item.row = currentRow;
            item.cell = currentCell;
            return true;
        };
        const handleValueChange = () => {
            if (!ensureRowAndCell()) return;
            const newValue = parseMcapValue(currentCell.textContent);
            if (newValue === null || newValue === lastValue) return;
            item.lastValue = newValue;
            updateMonitorPanel();
            lastValue = newValue;
        };
        const observer = new MutationObserver(handleValueChange);
        observer.observe(currentRow, { childList: true, characterData: true, subtree: true, attributes: true });
        item.observer = observer;
        mcapMonitors.set(pairId, item);
        addMonitorToStorage(pairId, startValue, addedAt, addedMcap);
        startMcapPolling();
        button.dataset.dexMcapButton = '1';
        button.textContent = 'Monitoring';
        button.style.opacity = '0.9';
        updateMonitorPanel();
        if (!silent) showToast('Started MCap monitor');
    }

    async function fetchPairInfo(pairId) {
        const url = 'https://api.dexscreener.com/latest/dex/pairs/solana/' + pairId;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Dexscreener API failed: ' + response.status);
        }
        const json = await response.json();
        const pair = Array.isArray(json.pairs) ? json.pairs[0] : json.pair || null;
        if (!pair) {
            throw new Error('Pair data missing for ' + pairId);
        }
        return pair;
    }

    async function copyPairs(mode = 'tokens') {
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

    async function openBubble(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const address = pair.baseToken?.address || pair.pairAddress;
            window.open('https://v2.bubblemaps.io/map?address=' + encodeURIComponent(address) + '&chain=solana&limit=80', '_blank');
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

    function openLauncherWithUrls(urls) {
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Opening Dexscreener tabs</title></head><body style="font-family:system-ui,sans-serif;background:#111;color:#eee;padding:1rem;"><h1 style="font-size:1.1rem;">Opening Dexscreener tabs</h1><p>Click the button below to open ${urls.length} Dexscreener tabs.</p><button id="openAll" style="padding:10px 16px;border:none;border-radius:10px;background:#26a69a;color:#111;font-size:14px;cursor:pointer;">Open all tabs</button><div id="links" style="margin-top:1rem;"></div><script>
            const urls = ${JSON.stringify(urls)};
            const button = document.getElementById('openAll');
            const links = document.getElementById('links');
            button.addEventListener('click', () => {
                button.disabled = true;
                urls.forEach(url => {
                    const result = window.open(url, '_blank');
                    const row = document.createElement('div');
                    row.style.margin = '0.4rem 0';
                    row.innerHTML = '<a href="' + url + '" target="_blank" rel="noopener noreferrer" style="color:#6cf;">' + url + '</a>' + (result ? ' <span style="color:#8f8;">opened</span>' : ' <span style="color:#f88;">blocked</span>');
                    links.appendChild(row);
                });
            });
        <\/script></body></html>`;
        const blob = new Blob([html], { type: 'text/html' });
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank');
    }

    function openAllDexscreenerTabs() {
        const urls = Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/solana/"]')).map(a => a.href)));
        if (urls.length === 0) {
            showToast('No Solana pair links found');
            return;
        }
        openLauncherWithUrls(urls);
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
                return existing.querySelector('button[data-dex-mcap-button="1"]');
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
        bubbleButton.textContent = '🫧';
        bubbleButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(0,150,136,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        bubbleButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openBubble(pairId);
        });

        const pumpFunButton = document.createElement('button');
        pumpFunButton.type = 'button';
        pumpFunButton.textContent = '💊';
        pumpFunButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(255,161,0,0.95);color:#111;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        pumpFunButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            openPumpFun(pairId);
        });

        const mcapButton = document.createElement('button');
        mcapButton.type = 'button';
        mcapButton.dataset.dexMcapButton = '1';
        mcapButton.textContent = 'Monitor';
        mcapButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(238,181,12,0.95);color:#111;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        mcapButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            startMcapMonitor(pairId, anchor, mcapButton);
        });

        wrapper.append(copyButton, gmgnButton, xcaButton, xtickerButton, bubbleButton, pumpFunButton, mcapButton);
        anchor.insertAdjacentElement('afterend', wrapper);
        return mcapButton;
    }

    function addNewMcapMonitors() {
        const anchors = Array.from(document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]'));
        let count = 0;
        anchors.forEach(anchor => {
            const pairId = getPairIdFromHref(anchor.href);
            if (!pairId || mcapMonitors.has(pairId)) return;
            const mcapButton = insertCopyButton(anchor);
            if (!mcapButton) return;
            startMcapMonitor(pairId, anchor, mcapButton, true);
            count += 1;
        });
        if (count > 0) showToast('Auto-monitor added ' + count + ' new pairs');
    }

    function createFloatingControls() {
        if (document.getElementById('dex-pair-floating-controls')) return;
        const container = document.createElement('div');
        container.id = 'dex-pair-floating-controls';
        container.style.cssText = 'position:fixed;top:88px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;padding:8px;background:rgba(18,18,18,.92);border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:system-ui,sans-serif;width:320px;min-width:260px;min-height:140px;resize:both;overflow:auto;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;user-select:none;';
        const title = document.createElement('div');
        title.textContent = 'DEXEnhance';
        title.style.cssText = 'color:#fff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;';
        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.textContent = 'Collapse';
        toggleButton.style.cssText = 'padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:11px;cursor:pointer;';
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;';
        const dipButton = document.createElement('button');
        dipButton.type = 'button';
        dipButton.textContent = 'Dip Only';
        const rangeButton = document.createElement('button');
        rangeButton.type = 'button';
        rangeButton.textContent = '20-100K';
        const autoMonitorButton = document.createElement('button');
        autoMonitorButton.type = 'button';
        autoMonitorButton.textContent = 'Auto monitor OFF';
        const monitorAllButton = document.createElement('button');
        monitorAllButton.type = 'button';
        monitorAllButton.textContent = 'Monitor all';
        [dipButton, rangeButton, autoMonitorButton, monitorAllButton].forEach(btn => {
            btn.style.cssText = 'padding:6px 8px;border:none;border-radius:8px;background:#26a69a;color:#111;font-size:12px;line-height:1.2;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            btn.addEventListener('mouseenter', () => btn.style.background = '#2ac6b3');
            btn.addEventListener('mouseleave', () => btn.style.background = '#26a69a');
        });
        dipButton.addEventListener('click', () => {
            window.location.href = 'https://dexscreener.com/new-pairs/solana?rankBy=pairAge&order=asc&dexIds=pumpswap&minLiq=7000&minMarketCap=17000&maxMarketCap=120000&minAge=1&maxAge=168&min6HVol=2000&min1HVol=500&max24HChg=-1&max6HChg=-1&max1HChg=-1&profile=1';
        });
        rangeButton.addEventListener('click', () => {
            window.location.href = 'https://dexscreener.com/new-pairs/solana?rankBy=pairAge&order=asc&dexIds=pumpswap,pumpfun&minLiq=5000&minMarketCap=20000&maxMarketCap=100000&minAge=1&maxAge=168&min6HVol=3333&min1HVol=333&profile=1&launchpads=1';
        });
        monitorAllButton.addEventListener('click', addAllMcapMonitors);
        autoMonitorButton.id = 'dex-auto-monitor-toggle';
        autoMonitorButton.addEventListener('click', () => {
            autoMonitorNewPairs = !autoMonitorNewPairs;
            autoMonitorButton.textContent = autoMonitorNewPairs ? 'Auto monitor ON' : 'Auto monitor OFF';
            if (autoMonitorNewPairs) addNewMcapMonitors();
            showToast(autoMonitorNewPairs ? 'Enabled auto-monitor for new pairs' : 'Disabled auto-monitor');
        });
        toggleButton.addEventListener('click', () => {
            const collapsed = container.dataset.collapsed === '1';
            container.dataset.collapsed = collapsed ? '0' : '1';
            buttonGroup.style.display = collapsed ? 'flex' : 'none';
            monitorPanel.style.display = collapsed ? 'block' : 'none';
            toggleButton.textContent = collapsed ? 'Collapse' : 'Expand';
        });
        const monitorPanel = document.createElement('div');
        monitorPanel.id = 'dex-mcap-monitor-panel';
        monitorPanel.style.cssText = 'border-top:1px solid rgba(255,255,255,.1);padding-top:8px;margin-top:8px;display:flex;flex-direction:column;overflow:auto;max-height:calc(100vh - 220px);';
        monitorPanel.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:12px;color:#fff;">' +
            '<span><strong>Monitors</strong> <span class="dex-mcap-monitor-count">0</span></span>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
            '<button id="dex-mcap-sort" style="padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:11px;cursor:pointer;">Sort %</button>' +
            '<button id="dex-mcap-stop-all" title="Remove all monitors" style="padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:14px;cursor:pointer;">✕</button>' +
            '</div>' +
            '</div>' +
            '<div class="dex-mcap-monitor-list" style="overflow:auto;color:#ddd;font-size:12px;min-height:40px;"></div>';
        header.append(title, toggleButton);
        buttonGroup.append(dipButton, rangeButton, autoMonitorButton, monitorAllButton);
        container.append(header, buttonGroup, monitorPanel);
        document.body.appendChild(container);

        let dragState = null;
        const stopDrag = event => {
            if (!dragState) return;
            dragState = null;
            if (event?.pointerId != null && header.hasPointerCapture(event.pointerId)) {
                header.releasePointerCapture(event.pointerId);
            }
        };
        const onPointerMove = event => {
            if (!dragState) return;
            const dx = event.clientX - dragState.startX;
            const dy = event.clientY - dragState.startY;
            container.style.left = dragState.origLeft + dx + 'px';
            container.style.top = dragState.origTop + dy + 'px';
        };
        const onPointerUp = event => {
            stopDrag(event);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);
        };
        header.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            if (event.target.closest('button')) return;
            const rect = container.getBoundingClientRect();
            dragState = {
                startX: event.clientX,
                startY: event.clientY,
                origLeft: rect.left,
                origTop: rect.top
            };
            container.style.left = rect.left + 'px';
            container.style.top = rect.top + 'px';
            container.style.right = 'auto';
            container.style.bottom = 'auto';
            header.setPointerCapture(event.pointerId);
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
            event.preventDefault();
        });
        header.addEventListener('pointermove', onPointerMove);
        header.addEventListener('pointerup', onPointerUp);
        header.addEventListener('pointercancel', onPointerUp);

        document.getElementById('dex-mcap-stop-all').addEventListener('click', stopAllMcapMonitors);
        const sortButton = document.getElementById('dex-mcap-sort');
        if (sortButton) {
            sortButton.addEventListener('click', () => {
                monitorSortDescending = !monitorSortDescending;
                updateMonitorSortButton();
                updateMonitorPanel();
            });
        }
        updateMonitorSortButton();
        updateMonitorPanel();
    }

    function scanDexscreenerLinks() {
        cleanupCopyWrappers();
        const anchors = document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]');
        anchors.forEach(anchor => {
            const pairId = getPairIdFromHref(anchor.href);
            if (!pairId) return;
            const mcapButton = insertCopyButton(anchor);
            if (autoMonitorNewPairs && mcapButton && !mcapMonitors.has(pairId)) {
                startMcapMonitor(pairId, anchor, mcapButton, true);
            }
        });
    }

    function observeDexscreener() {
        scanDexscreenerLinks();
        createFloatingControls();
        restoreMonitors();
        const observer = new MutationObserver(() => scanDexscreenerLinks());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (location.hostname.includes('dexscreener')) {
        observeDexscreener();
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand("Copy DEX pair addresses", copyPairs);
    }
})();
