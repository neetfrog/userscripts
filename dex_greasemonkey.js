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

    function loadStoredMonitors() {
        try {
            const raw = localStorage.getItem(monitorStorageKey);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            console.warn('Failed to load stored monitors', e);
            return [];
        }
    }

    function saveStoredMonitors(ids) {
        try {
            localStorage.setItem(monitorStorageKey, JSON.stringify(Array.from(new Set(ids))));
        } catch (e) {
            console.warn('Failed to save stored monitors', e);
        }
    }

    function addMonitorToStorage(pairId) {
        const stored = new Set(loadStoredMonitors());
        stored.add(pairId);
        saveStoredMonitors(Array.from(stored));
    }

    function removeMonitorFromStorage(pairId) {
        const stored = new Set(loadStoredMonitors());
        stored.delete(pairId);
        saveStoredMonitors(Array.from(stored));
    }

    function restoreMonitors() {
        const stored = loadStoredMonitors();
        if (!stored.length) return;
        const anchors = Array.from(document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]'));
        stored.forEach(pairId => {
            if (mcapMonitors.has(pairId)) return;
            const anchor = anchors.find(a => getPairIdFromHref(a.href) === pairId);
            if (!anchor) return;
            const button = anchor.nextElementSibling?.querySelector('button[data-dex-mcap-button="1"]');
            if (!button) return;
            startMcapMonitor(pairId, anchor, button, true);
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
            added.textContent = 'added ' + formatMonitorDate(item.addedAt) + ' (' + formatMonitorAge(item.addedAt) + ')';
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
                item.button.textContent = 'Monitor';
                item.button.style.opacity = '1';
                updateMonitorPanel();
                showToast('Removed monitor for ' + item.pairId);
            });
            row.append(labelContainer, status, stop);
            list.appendChild(row);
        });
    }

    function stopAllMcapMonitors() {
        mcapMonitors.forEach(item => item.observer.disconnect());
        mcapMonitors.clear();
        saveStoredMonitors([]);
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

    function startMcapMonitor(pairId, anchor, button, silent = false) {
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
        let lastValue = parseMcapValue(cell.textContent);
        if (lastValue === null) {
            showInfoPanel('Unable to parse current MCap.', 'error');
            return;
        }
        const label = getTokenLabel(row);

        const observer = new MutationObserver(() => {
            const newValue = parseMcapValue(cell.textContent);
            if (newValue === null || newValue === lastValue) return;
            const item = mcapMonitors.get(pairId);
            if (item) {
                item.lastValue = newValue;
                updateMonitorPanel();
            }
            lastValue = newValue;
        });
        observer.observe(cell, { childList: true, characterData: true, subtree: true });
        mcapMonitors.set(pairId, { observer, button, pairId, row, cell, lastValue, startValue: lastValue, label, addedAt: new Date() });
        addMonitorToStorage(pairId);
        button.dataset.dexMcapButton = '1';
        button.textContent = 'Monitoring';
        button.style.opacity = '0.9';
        updateMonitorPanel();
        showToast('Started MCap monitor');
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

    const solanaRpcUrls = [
        'https://api.mainnet-beta.solana.com',
        'https://solana-api.projectserum.com',
        'https://ssc-dao.genesysgo.net'
    ];

    async function fetchSolanaRpc(method, params) {
        let lastError;
        for (const endpoint of solanaRpcUrls) {
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
                });
                if (!response.ok) {
                    lastError = new Error('Solana RPC failed: ' + response.status + ' @ ' + endpoint);
                    continue;
                }
                const json = await response.json();
                if (json.error) {
                    lastError = new Error(json.error.message || 'Solana RPC error @ ' + endpoint);
                    continue;
                }
                return json.result;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('Failed to reach any Solana RPC endpoint');
    }

    async function fetchTokenSupply(tokenAddress) {
        return await fetchSolanaRpc('getTokenSupply', [tokenAddress, { commitment: 'finalized' }]);
    }

    async function fetchTokenLargestAccounts(tokenAddress) {
        return await fetchSolanaRpc('getTokenLargestAccounts', [tokenAddress, { commitment: 'finalized' }]);
    }

    async function fetchTokenHolderCount(tokenAddress) {
        const result = await fetchSolanaRpc('getTokenAccountsByMint', [
            tokenAddress,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed', commitment: 'finalized' }
        ]);
        return Array.isArray(result.value) ? result.value.length : null;
    }

    function formatSolAmount(amount, decimals) {
        const value = Number(amount) / Math.pow(10, decimals || 0);
        if (Number.isNaN(value)) return 'n/a';
        return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
    }

    async function showHolderStats(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const tokenAddress = pair.baseToken?.address || pair.quoteToken?.address || pair.pairAddress;
            const supplyResult = await fetchTokenSupply(tokenAddress);
            const largestResult = await fetchTokenLargestAccounts(tokenAddress);
            let holderCount = null;
            try {
                holderCount = await fetchTokenHolderCount(tokenAddress);
            } catch (err) {
                console.warn('Holder count fetch failed', err);
            }

            const supplyRaw = Number(supplyResult.value?.amount || 0);
            const decimals = Number(supplyResult.value?.decimals || 0);
            const totalSupply = formatSolAmount(supplyResult.value?.amount, decimals);
            const accounts = Array.isArray(largestResult.value) ? largestResult.value : [];
            const calculateShare = count => {
                const amount = accounts.slice(0, count).reduce((sum, item) => sum + Number(item.amount), 0);
                const pct = supplyRaw > 0 ? (amount / supplyRaw) * 100 : 0;
                return pct.toFixed(2) + '%';
            };
            const top10Share = calculateShare(10);
            const top25Share = calculateShare(25);
            const topAccounts = accounts.slice(0, 5).map((item, index) => `${index + 1}. ${formatSolAmount(item.amount, decimals)} (${item.address})`).join('\n');

            showInfoPanel(
                `Holder stats for ${pair.baseToken?.symbol || pair.quoteToken?.symbol || tokenAddress}\n` +
                `Total supply: ${totalSupply}\n` +
                `${holderCount !== null ? 'Holder count: ' + holderCount + '\n' : ''}` +
                `Top 10 accounts share: ${top10Share}\n` +
                `Top 25 accounts share: ${top25Share}\n\n` +
                `Top 5 accounts:\n${topAccounts}`,
                'info'
            );
        } catch (e) {
            console.warn('showHolderStats failed', e);
            showInfoPanel('Unable to fetch holder stats. ' + (e?.message || 'Try again later.'), 'error');
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
            if (existing.dataset.pairId === pairId) return;
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

        const holderButton = document.createElement('button');
        holderButton.type = 'button';
        holderButton.textContent = 'H';
        holderButton.title = 'Fetch holder stats';
        holderButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(142,68,173,0.95);color:#fff;font-size:11px;cursor:pointer;line-height:1;white-space:nowrap;';
        holderButton.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            showHolderStats(pairId);
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

        wrapper.append(copyButton, gmgnButton, xcaButton, xtickerButton, bubbleButton, pumpFunButton, holderButton, mcapButton);
        anchor.insertAdjacentElement('afterend', wrapper);
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
        buttonGroup.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;';
        const dipButton = document.createElement('button');
        dipButton.type = 'button';
        dipButton.textContent = 'Dip Only';
        const rangeButton = document.createElement('button');
        rangeButton.type = 'button';
        rangeButton.textContent = '20-100K';
        const monitorAllButton = document.createElement('button');
        monitorAllButton.type = 'button';
        monitorAllButton.textContent = 'Monitor all';
        [dipButton, rangeButton, monitorAllButton].forEach(btn => {
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
        buttonGroup.append(dipButton, rangeButton, monitorAllButton);
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
        anchors.forEach(insertCopyButton);
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
