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
        const match = href.match(/\/solana\/([A-Za-z0-9]{32,44})$/);
        return match ? match[1] : null;
    }

    function getCopyWrapper(anchor) {
        const next = anchor.nextElementSibling;
        return next && next.dataset?.dexCopyWrapper === '1' ? next : null;
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
        copyButton.textContent = 'Copy CA';
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

        wrapper.append(copyButton, gmgnButton, xcaButton, xtickerButton, bubbleButton);
        anchor.insertAdjacentElement('afterend', wrapper);
    }

    function createFloatingControls() {
        if (document.getElementById('dex-pair-floating-controls')) return;
        const container = document.createElement('div');
        container.id = 'dex-pair-floating-controls';
        container.style.cssText = 'position:fixed;top:88px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;padding:8px;background:rgba(18,18,18,.92);border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:system-ui,sans-serif;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
        const title = document.createElement('div');
        title.textContent = 'DEXEnhance';
        title.style.cssText = 'color:#fff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;';
        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.textContent = 'Collapse';
        toggleButton.style.cssText = 'padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:11px;cursor:pointer;';
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
        const contractsButton = document.createElement('button');
        contractsButton.type = 'button';
        contractsButton.textContent = 'Copy all pair CAs';
        const tokensButton = document.createElement('button');
        tokensButton.type = 'button';
        tokensButton.textContent = 'Copy all token CAs';
        const openAllButton = document.createElement('button');
        openAllButton.type = 'button';
        openAllButton.textContent = 'Open all Dexscreener tabs';
        [contractsButton, tokensButton, openAllButton].forEach(btn => {
            btn.style.cssText = 'padding:8px 10px;border:none;border-radius:8px;background:#26a69a;color:#111;font-size:13px;cursor:pointer;';
            btn.addEventListener('mouseenter', () => btn.style.background = '#2ac6b3');
            btn.addEventListener('mouseleave', () => btn.style.background = '#26a69a');
        });
        contractsButton.addEventListener('click', () => copyPairs('contracts'));
        tokensButton.addEventListener('click', () => copyPairs('tokens'));
        openAllButton.addEventListener('click', () => openAllDexscreenerTabs());
        toggleButton.addEventListener('click', () => {
            const collapsed = container.dataset.collapsed === '1';
            container.dataset.collapsed = collapsed ? '0' : '1';
            buttonGroup.style.display = collapsed ? 'flex' : 'none';
            toggleButton.textContent = collapsed ? 'Collapse' : 'Expand';
            container.style.width = collapsed ? '' : 'auto';
        });
        header.append(title, toggleButton);
        buttonGroup.append(contractsButton, tokensButton, openAllButton);
        container.append(header, buttonGroup);
        document.body.appendChild(container);
    }

    function scanDexscreenerLinks() {
        cleanupCopyWrappers();
        const anchors = document.querySelectorAll('a[href*="/solana/"]');
        anchors.forEach(insertCopyButton);
    }

    function observeDexscreener() {
        scanDexscreenerLinks();
        createFloatingControls();
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
