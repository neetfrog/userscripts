// ==UserScript==
// @name         Dex Pair Clipboard
// @namespace    http://example.com/
// @version      1.0
// @description  Copy Solana DEX pair addresses from links on any page
// @match        *://*/*
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    function formatTicker(ticker) {
        const normalized = ticker.replace(/^(#\d+)([A-Za-z].*)$/, '$1 $2');
        return normalized.trim();
    }

    function buildResult(pairs, mode) {
        return Array.from(pairs.entries()).map(([address, info]) => {
            if (mode === 'contracts') {
                return address;
            }
            const pieces = [];
            if (info.ticker) pieces.push(formatTicker(info.ticker));
            if (info.name) pieces.push(info.name);
            pieces.push(address);
            return pieces.join(' | ');
        }).join("\n");
    }

    function copyPairs(mode = 'tokens') {
        const pairs = new Map();
        document.querySelectorAll('a[href*="/solana/"]').forEach(a => {
            const match = a.href.match(/\/solana\/([A-Za-z0-9]{32,44})/);
            if (!match) return;
            const address = match[1];
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
        const result = buildResult(pairs, mode);
        navigator.clipboard.writeText(result).then(() => {
            alert("Copied " + pairs.size + " pair addresses to clipboard!");
        }).catch(() => {
            const existing = document.getElementById('dex-pair-clipboard-overlay');
            if (existing) existing.remove();
            const overlay = document.createElement('div');
            overlay.id = 'dex-pair-clipboard-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.85);color:#eee;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(4px);';
            overlay.innerHTML = '<div style="max-width:100%;width:760px;background:#111;border:1px solid #444;border-radius:12px;overflow:hidden;box-shadow:0 0 60px rgba(0,0,0,.6);">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#131313;border-bottom:1px solid #333;font-family:system-ui,sans-serif;font-size:14px;">' +
                '<span>DEX Pair Addresses</span>' +
                '<button id="dex-pair-clipboard-close" style="border:none;background:#2a2a2a;color:#eee;padding:6px 12px;border-radius:8px;cursor:pointer;">Close</button>' +
                '</div>' +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;background:#111;">' +
                '<button id="dex-copy-contracts" style="border:none;background:#2a2a2a;color:#eee;padding:8px 12px;border-radius:8px;cursor:pointer;">Copy contracts only</button>' +
                '<button id="dex-copy-tokens" style="border:none;background:#2a2a2a;color:#eee;padding:8px 12px;border-radius:8px;cursor:pointer;">Copy names/tickers</button>' +
                '</div>' +
                '<textarea id="dex-pair-clipboard-textarea" readonly style="width:100%;height:56vh;padding:16px;border:none;background:#000;color:#0f0;font-family:monospace,ui-monospace,sans-serif;font-size:13px;line-height:1.4;resize:none;outline:none;box-sizing:border-box;">' + result + '</textarea>' +
                '</div>';
            document.body.appendChild(overlay);
            const textarea = document.getElementById('dex-pair-clipboard-textarea');
            const copyMode = mode;
            const updateTextarea = newMode => {
                textarea.textContent = buildResult(pairs, newMode);
            };
            document.getElementById('dex-copy-contracts').addEventListener('click', () => {
                const value = buildResult(pairs, 'contracts');
                navigator.clipboard.writeText(value).then(() => {
                    alert('Copied ' + pairs.size + ' contracts to clipboard!');
                });
                updateTextarea('contracts');
            });
            document.getElementById('dex-copy-tokens').addEventListener('click', () => {
                const value = buildResult(pairs, 'tokens');
                navigator.clipboard.writeText(value).then(() => {
                    alert('Copied ' + pairs.size + ' token names/tickers to clipboard!');
                });
                updateTextarea('tokens');
            });
            document.getElementById('dex-pair-clipboard-close').addEventListener('click', () => overlay.remove());
        });
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand("Copy DEX pair addresses", copyPairs);
    }
})();
