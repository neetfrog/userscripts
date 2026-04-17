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
        if (!href) return null;
        const match = href.match(/\/solana\/([A-Za-z0-9]{32,44})(?:\/|[?#].*)?$/);
        return match ? match[1] : null;
    }

    function getCopyWrapper(anchor) {
        const next = anchor.nextElementSibling;
        return next && next.dataset?.dexCopyWrapper === '1' ? next : null;
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

    const mcapMonitors = new Map();
    const monitorStorageKey = 'dex-enhance-mcap-monitors';
    const monitorSettingsKey = 'dex-enhance-mcap-settings';
    const monitorPresetsKey = 'dex-enhance-mcap-presets';
    let monitorSortBy = 'percent';
    let monitorSortDescending = true;
    let mcapMonitorPollHandle = null;
    let monitorPollIndex = 0;
    const monitorPollBatchSize = 3;
    const monitorHistoryMax = 1000;
    let autoMonitorNewPairs = false;
    let actionButtonVisibility = {
        ca: true,
        gmgn: true,
        xca: true,
        xticker: true,
        bubble: true,
        pumpfun: true,
        solscan: true,
        dextools: true,
        telegram: true,
        monitor: true
    };
    let monitorPresets = {};
    let monitorSettings = {
        panelLeft: null,
        panelTop: null,
        panelCollapsed: false,
        sortBy: 'percent',
        sortDescending: true,
        autoMonitorNewPairs: false,
        actionButtonVisibility: { ...actionButtonVisibility },
        restoreMonitorsOnLoad: true
    };

    function loadMonitorPresets() {
        try {
            const raw = localStorage.getItem(monitorPresetsKey);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            console.warn('Failed to load monitor presets', e);
            return {};
        }
    }

    function saveMonitorPresets() {
        try {
            localStorage.setItem(monitorPresetsKey, JSON.stringify(monitorPresets));
        } catch (e) {
            console.warn('Failed to save monitor presets', e);
        }
    }

    function applyMonitorPreset(name) {
        const preset = monitorPresets[name];
        if (!preset || !Array.isArray(preset) || preset.length === 0) {
            showToast('Preset is empty or missing');
            return;
        }
        const existing = new Set(mcapMonitors.keys());
        const anchors = Array.from(document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]'));
        preset.forEach(pairId => {
            if (existing.has(pairId)) return;
            const anchor = anchors.find(a => getPairIdFromHref(a.href) === pairId);
            if (!anchor) return;
            const button = insertCopyButton(anchor);
            if (button) startMcapMonitor(pairId, anchor, button, true);
        });
        showToast('Loaded monitor preset "' + name + '"');
    }

    function saveCurrentMonitorPreset(name) {
        if (!name) return;
        monitorPresets[name] = Array.from(mcapMonitors.keys());
        saveMonitorPresets();
        showToast('Saved preset "' + name + '"');
    }

    function deleteMonitorPreset(name) {
        if (!name || !monitorPresets[name]) return;
        delete monitorPresets[name];
        saveMonitorPresets();
        showToast('Deleted preset "' + name + '"');
    }

    function showMonitorAlertSound() {
        try {
            const context = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = 760;
            gain.gain.value = 0.12;
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                context.close();
            }, 150);
        } catch (e) {
            console.warn('Alert sound failed', e);
        }
    }

    function triggerMonitorAlert(item, message) {
        showToast(message, 3600);
        showMonitorAlertSound();
        if (window.Notification && Notification.permission === 'granted') {
            new Notification('Dex Enhance alert', { body: message });
        } else if (window.Notification && Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification('Dex Enhance alert', { body: message });
                }
            });
        }
    }

    function renderSparkline(values) {
        if (!Array.isArray(values) || values.length === 0) return '';
        const bars = '▁▂▃▄▅▆▇█';
        const maxPoints = 16;
        const slice = values.slice(-maxPoints);
        const min = Math.min(...slice);
        const max = Math.max(...slice);
        const range = max - min || 1;
        return slice.map(v => bars[Math.floor(((v - min) / range) * (bars.length - 1))]).join('');
    }

    function createSparklineElement(values, resolution) {
        const container = document.createElement('span');
        container.style.cssText = 'display:flex;align-items:flex-end;justify-content:flex-start;gap:1px;height:18px;width:100%;max-width:160px;overflow:hidden;cursor:ns-resize;';
        if (!Array.isArray(values) || values.length === 0) {
            container.textContent = 'no data';
            container.style.cssText = 'font-size:10px;color:#999;display:block;';
            return container;
        }
        const points = values.slice(-resolution);
        const min = Math.min(...points);
        const max = Math.max(...points);
        const range = max - min || 1;
        points.forEach(value => {
            const bar = document.createElement('span');
            const normalized = Math.max(0.05, (value - min) / range);
            bar.style.cssText = 'flex:1 1 0;min-width:1px;background:#4fd1c5;border-radius:2px 2px 0 0;height:' + Math.round(normalized * 100) + '%;';
            container.appendChild(bar);
        });
        container.title = 'Mouse wheel to change chart resolution (' + resolution + ' points)';
        return container;
    }

    function checkMonitorAlerts(item, newValue) {
        if (!item.thresholds) return;
        const percentThreshold = typeof item.thresholds.percentChange === 'number' ? item.thresholds.percentChange : null;
        const mcapThreshold = typeof item.thresholds.mcapChange === 'number' ? item.thresholds.mcapChange : null;
        const percentValue = getPercentChangeValue(item.startValue, newValue);
        const mcapValue = newValue - item.startValue;
        if (percentThreshold !== null) {
            const triggered = Math.abs(percentValue) >= Math.abs(percentThreshold);
            if (triggered && !item.alertedPercent) {
                item.alertedPercent = true;
                triggerMonitorAlert(item, item.label + ' moved ' + formatPercentChange(item.startValue, newValue) + ' (threshold ' + percentThreshold + '%)');
            } else if (!triggered) {
                item.alertedPercent = false;
            }
        }
        if (mcapThreshold !== null) {
            const triggered = Math.abs(mcapValue) >= Math.abs(mcapThreshold);
            if (triggered && !item.alertedMcap) {
                item.alertedMcap = true;
                triggerMonitorAlert(item, item.label + ' market cap changed by ' + formatMcapDisplay(mcapValue) + ' (threshold ' + formatMcapDisplay(mcapThreshold) + ')');
            } else if (!triggered) {
                item.alertedMcap = false;
            }
        }
    }

    function configureMonitorThreshold(item) {
        const existing = item.thresholds || {};
        const percentInput = prompt('Percent change alert threshold (%)\nUse a positive number to alert on both directions, or a negative value for negative moves only.', existing.percentChange != null ? String(existing.percentChange) : '');
        if (percentInput === null) return;
        const percentValue = percentInput.trim() === '' ? null : Number(percentInput.trim());
        if (percentInput.trim() !== '' && Number.isNaN(percentValue)) {
            showToast('Invalid percent threshold');
            return;
        }
        const mcapInput = prompt('Absolute market cap alert threshold ($)\nUse a positive number for any move above that amount, or leave blank to clear.', existing.mcapChange != null ? String(existing.mcapChange) : '');
        if (mcapInput === null) return;
        const mcapValue = mcapInput.trim() === '' ? null : Number(mcapInput.trim());
        if (mcapInput.trim() !== '' && Number.isNaN(mcapValue)) {
            showToast('Invalid market cap threshold');
            return;
        }
        item.thresholds = { percentChange: percentValue, mcapChange: mcapValue };
        item.alertedPercent = false;
        item.alertedMcap = false;
        const stored = loadStoredMonitors();
        stored[item.pairId] = stored[item.pairId] || {};
        stored[item.pairId].thresholds = item.thresholds;
        saveStoredMonitors(stored);
        showToast('Alert thresholds updated');
        updateMonitorPanel();
    }

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
                return Object.entries(parsed).reduce((acc, [pairId, entry]) => {
                    if (typeof pairId !== 'string' || !entry || typeof entry !== 'object') return acc;
                    const normalized = {};
                    const startValue = normalizeStoredNumber(entry.startValue);
                    if (startValue !== null) normalized.startValue = startValue;
                    const addedMcap = normalizeStoredNumber(entry.addedMcap);
                    if (addedMcap !== null) normalized.addedMcap = addedMcap;
                    if (typeof entry.addedAt === 'string') {
                        const date = new Date(entry.addedAt);
                        if (!Number.isNaN(date.getTime())) normalized.addedAt = date;
                    }
                    if (entry.thresholds && typeof entry.thresholds === 'object') {
                        normalized.thresholds = {
                            percentChange: normalizeStoredNumber(entry.thresholds.percentChange),
                            mcapChange: normalizeStoredNumber(entry.thresholds.mcapChange)
                        };
                    }
                    acc[pairId] = normalized;
                    return acc;
                }, {});
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

    function loadMonitorSettings() {
        try {
            const raw = localStorage.getItem(monitorSettingsKey);
            if (!raw) return { ...monitorSettings };
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return { ...monitorSettings };
            return {
                panelLeft: typeof parsed.panelLeft === 'number' ? parsed.panelLeft : null,
                panelTop: typeof parsed.panelTop === 'number' ? parsed.panelTop : null,
                panelCollapsed: Boolean(parsed.panelCollapsed),
                sortBy: parsed.sortBy === 'activity' ? 'activity' : parsed.sortBy === 'date' ? 'date' : 'percent',
                sortDescending: Boolean(parsed.sortDescending),
                autoMonitorNewPairs: Boolean(parsed.autoMonitorNewPairs),
                actionButtonVisibility: parsed.actionButtonVisibility && typeof parsed.actionButtonVisibility === 'object'
                    ? { ...actionButtonVisibility, ...parsed.actionButtonVisibility }
                    : { ...actionButtonVisibility },
                restoreMonitorsOnLoad: parsed.restoreMonitorsOnLoad !== false
            };
        } catch (e) {
            console.warn('Failed to load monitor settings', e);
            return { ...monitorSettings };
        }
    }

    function saveMonitorSettings() {
        try {
            localStorage.setItem(monitorSettingsKey, JSON.stringify(monitorSettings));
        } catch (e) {
            console.warn('Failed to save monitor settings', e);
        }
    }

    function applyActionButtonVisibility(button) {
        if (!button) return;
        const key = button.dataset.dexActionKey;
        if (!key) return;
        const visible = monitorSettings.actionButtonVisibility?.[key] !== false;
        button.style.display = visible ? '' : 'none';
    }

    function updateAllActionButtonVisibility() {
        document.querySelectorAll('button[data-dex-action-button="1"]').forEach(applyActionButtonVisibility);
    }

    function configureActionButtons() {
        const existing = document.getElementById('dex-action-button-config');
        if (existing) return;
        const overlay = document.createElement('div');
        overlay.id = 'dex-action-button-config';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483655;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:1rem;';
        const dialog = document.createElement('div');
        dialog.style.cssText = 'width:360px;background:#111;border:1px solid #444;border-radius:12px;box-shadow:0 0 40px rgba(0,0,0,0.7);overflow:hidden;font-family:system-ui,sans-serif;color:#eee;';
        dialog.innerHTML = '<div style="padding:14px 16px;border-bottom:1px solid #333;font-size:14px;font-weight:700;">Action buttons</div>' +
            '<div id="dex-action-button-config-list" style="padding:12px 16px;display:grid;grid-template-columns:1fr 1fr;gap:10px;"></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #333;">' +
            '<button id="dex-action-button-config-save" style="padding:8px 12px;border:none;border-radius:8px;background:#26a69a;color:#111;cursor:pointer;">Save</button>' +
            '<button id="dex-action-button-config-cancel" style="padding:8px 12px;border:none;border-radius:8px;background:#444;color:#fff;cursor:pointer;">Cancel</button>' +
            '</div>';
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const types = [
            { key: 'ca', label: 'CA' },
            { key: 'gmgn', label: 'GMGN' },
            { key: 'xca', label: 'X CA' },
            { key: 'xticker', label: 'X $' },
            { key: 'bubble', label: 'Bubble' },
            { key: 'pumpfun', label: 'PumpFun' },
            { key: 'solscan', label: 'Solscan' },
            { key: 'dextools', label: 'DexTools' },
            { key: 'telegram', label: 'Telegram' },
            { key: 'monitor', label: 'Monitor' }
        ];

        const list = document.getElementById('dex-action-button-config-list');
        types.forEach(type => {
            const item = document.createElement('label');
            item.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = monitorSettings.actionButtonVisibility[type.key] !== false;
            input.dataset.key = type.key;
            input.style.cssText = 'transform:scale(1.1);';
            const text = document.createElement('span');
            text.textContent = type.label;
            item.appendChild(input);
            item.appendChild(text);
            list.appendChild(item);
        });

        document.getElementById('dex-action-button-config-save').addEventListener('click', () => {
            const checkboxes = overlay.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(input => {
                monitorSettings.actionButtonVisibility[input.dataset.key] = input.checked;
            });
            saveMonitorSettings();
            updateAllActionButtonVisibility();
            overlay.remove();
            showToast('Action button visibility saved');
        });
        document.getElementById('dex-action-button-config-cancel').addEventListener('click', () => overlay.remove());
    }

    function debounce(fn, delay = 200) {
        let timeout = null;
        return () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                timeout = null;
                fn();
            }, delay);
        };
    }

    function updateMonitorRowInfo(item) {
        if (!item.button) return;
        const wrapper = item.button.closest('span[data-dex-copy-wrapper="1"]');
        if (!wrapper) return;
        const info = wrapper.querySelector('.dex-mcap-monitor-row-info');
        if (info) {
            info.remove();
        }
    }

    function addMonitorToStorage(pairId, startValue, addedAt, addedMcap, thresholds = null) {
        const stored = loadStoredMonitors();
        stored[pairId] = {
            startValue: typeof startValue === 'number' ? startValue : stored[pairId]?.startValue || null,
            addedAt: addedAt ? addedAt.toISOString() : stored[pairId]?.addedAt || new Date().toISOString(),
            addedMcap: typeof addedMcap === 'number' ? addedMcap : stored[pairId]?.addedMcap || null,
            thresholds: thresholds || stored[pairId]?.thresholds || null
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
            const thresholds = storedData.thresholds && typeof storedData.thresholds === 'object' ? storedData.thresholds : null;
            startMcapMonitor(pairId, anchor, button, true, startValue, addedAt, addedMcap, thresholds);
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

    function getTokenImageUrl(row) {
        const tokenCell = row.querySelector('.ds-dex-table-row-col-token');
        if (!tokenCell) return null;
        const directImg = tokenCell.querySelector('img.ds-dex-table-row-token-icon-img');
        if (directImg) {
            return directImg.src || directImg.dataset?.src || directImg.currentSrc || null;
        }
        const stackImg = tokenCell.querySelector('.ds-dex-table-row-token-icon-stack img');
        if (stackImg) {
            return stackImg.src || stackImg.dataset?.src || stackImg.currentSrc || null;
        }
        const imgs = Array.from(tokenCell.querySelectorAll('img'));
        if (imgs.length === 0) return null;
        const cmsImg = imgs.find(img => {
            const src = (img.src || img.dataset?.src || img.currentSrc || '').toLowerCase();
            return src.includes('/cms/images/');
        });
        if (cmsImg) {
            return cmsImg.src || cmsImg.dataset?.src || cmsImg.currentSrc || null;
        }
        const isChainIcon = img => {
            const alt = (img.alt || '').toLowerCase();
            const src = (img.src || img.dataset?.src || img.currentSrc || '').toLowerCase();
            return /solana|chain|network|platform|logo|dexes\/pumpswap|dexes\/pumpfun|pump\.fun|pumpfun|pumpswap|dex|solana\.png|sol\.png/.test(alt + ' ' + src);
        };
        const tokenImg = imgs.find(img => !isChainIcon(img)) || imgs[0];
        return tokenImg.src || tokenImg.dataset?.src || tokenImg.currentSrc || null;
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
        const percentButton = document.getElementById('dex-mcap-sort-percent');
        const dateButton = document.getElementById('dex-mcap-sort-date');
        const activityButton = document.getElementById('dex-mcap-sort-activity');
        if (percentButton) {
            percentButton.textContent = 'Sort %' + (monitorSortBy === 'percent' ? (monitorSortDescending ? ' ↓' : ' ↑') : '');
        }
        if (dateButton) {
            dateButton.textContent = 'Sort date' + (monitorSortBy === 'date' ? (monitorSortDescending ? ' ↓' : ' ↑') : '');
        }
        if (activityButton) {
            activityButton.textContent = 'Sort activity' + (monitorSortBy === 'activity' ? (monitorSortDescending ? ' ↓' : ' ↑') : '');
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
            if (monitorSortBy === 'date') {
                const aTime = a.addedAt instanceof Date ? a.addedAt.getTime() : 0;
                const bTime = b.addedAt instanceof Date ? b.addedAt.getTime() : 0;
                return monitorSortDescending ? bTime - aTime : aTime - bTime;
            }
            if (monitorSortBy === 'activity') {
                const aActivity = Array.isArray(a.history) ? a.history.length : 0;
                const bActivity = Array.isArray(b.history) ? b.history.length : 0;
                return monitorSortDescending ? bActivity - aActivity : aActivity - bActivity;
            }
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
            const labelRow = document.createElement('div');
            labelRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
            if (item.imageUrl) {
                const avatar = document.createElement('img');
                avatar.src = item.imageUrl;
                avatar.alt = item.label;
                avatar.style.cssText = 'width:18px;height:18px;border-radius:50%;object-fit:cover;';
                labelRow.appendChild(avatar);
            }
            const label = document.createElement('span');
            label.textContent = item.label;
            label.style.cssText = 'cursor:pointer;text-decoration:underline;color:#9af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            label.title = 'Open Dexscreener token page';
            label.addEventListener('click', () => {
                window.open('https://dexscreener.com/solana/' + encodeURIComponent(item.pairId), '_blank');
            });
            labelRow.appendChild(label);
            labelContainer.appendChild(labelRow);
            const added = document.createElement('span');
            added.textContent = 'added ' + formatMonitorDate(item.addedAt) + ' (' + formatMonitorAge(item.addedAt) + ')';
            added.style.cssText = 'font-size:10px;color:#999;line-height:1.2;';
            const sparkline = createSparklineElement(item.history, item.graphResolution);
            sparkline.addEventListener('wheel', event => {
                event.preventDefault();
                const delta = event.deltaY > 0 ? -1 : 1;
                item.graphResolution = Math.max(4, Math.min(80, item.graphResolution + delta));
                sparkline.title = 'Mouse wheel to change chart resolution (' + item.graphResolution + ' points)';
                updateMonitorPanel();
            });
            labelContainer.append(label, sparkline, added);
            const status = document.createElement('span');
            const percentText = formatPercentChange(item.startValue, item.lastValue);
            status.innerHTML = formatMcapDisplay(item.addedMcap) + ' → ' + formatMcapDisplay(item.lastValue) + ' <span style="color:' + (percentText.startsWith('-') ? '#f56' : '#7cfa8e') + ';">(' + percentText + ')</span>';
            const alertButton = document.createElement('button');
            alertButton.type = 'button';
            alertButton.textContent = '⚠';
            alertButton.title = 'Configure alert thresholds';
            alertButton.style.cssText = 'padding:2px 8px;border:none;border-radius:6px;background:rgba(249,202,35,0.95);color:#111;font-size:12px;cursor:pointer;';
            alertButton.addEventListener('click', () => configureMonitorThreshold(item));
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
            row.append(labelContainer, status, alertButton, stop);
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
            const monitors = Array.from(mcapMonitors.values());
            if (monitors.length === 0) return;
            const batchSize = monitors.length <= monitorPollBatchSize ? monitors.length : monitorPollBatchSize;
            const startIndex = monitorPollIndex % monitors.length;
            let processed = 0;
            for (let i = 0; i < monitors.length && processed < batchSize; i += 1) {
                const idx = (startIndex + i) % monitors.length;
                const item = monitors[idx];
                if (!document.body.contains(item.row)) {
                    const fallback = findMcapRowForPair(item.pairId);
                    if (fallback) {
                        item.row = fallback.row;
                        item.cell = fallback.cell;
                    }
                }
                const currentCell = item.cell || getMcapCell(item.row);
                if (currentCell) {
                    const newValue = parseMcapValue(currentCell.textContent);
                    if (newValue !== null && newValue !== item.lastValue) {
                        item.history.push(newValue);
                        if (item.history.length > monitorHistoryMax) item.history.shift();
                        item.lastValue = newValue;
                        checkMonitorAlerts(item, newValue);
                        updateMonitorRowInfo(item);
                        updateMonitorPanel();
                    }
                    processed += 1;
                    continue;
                }
                void (async () => {
                    const apiValue = await fetchPairMcap(item.pairId);
                    if (apiValue === null || apiValue === item.lastValue) return;
                    item.history.push(apiValue);
                    if (item.history.length > monitorHistoryMax) item.history.shift();
                    item.lastValue = apiValue;
                    checkMonitorAlerts(item, apiValue);
                    updateMonitorRowInfo(item);
                    updateMonitorPanel();
                })();
                processed += 1;
            }
            monitorPollIndex = (monitorPollIndex + processed) % monitors.length;
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

    function startMcapMonitor(pairId, anchor, button, silent = false, persistedStartValue = null, persistedAddedAt = null, persistedAddedMcap = null, persistedThresholds = null) {
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
        const normalizedStartValue = normalizeStoredNumber(persistedStartValue);
        const normalizedAddedMcap = normalizeStoredNumber(persistedAddedMcap);
        const startValue = normalizedStartValue !== null && normalizedStartValue > 0 ? normalizedStartValue : currentValue;
        const addedAt = persistedAddedAt instanceof Date && !Number.isNaN(persistedAddedAt.getTime()) ? persistedAddedAt : new Date();
        const addedMcap = normalizedAddedMcap !== null && normalizedAddedMcap > 0 ? normalizedAddedMcap : currentValue;
        const thresholds = persistedThresholds && typeof persistedThresholds === 'object' ? {
            percentChange: normalizeStoredNumber(persistedThresholds.percentChange),
            mcapChange: normalizeStoredNumber(persistedThresholds.mcapChange)
        } : { percentChange: null, mcapChange: null };
        const label = getTokenLabel(row);
        const imageUrl = getTokenImageUrl(row);

        let lastValue = currentValue;
        let currentRow = row;
        let currentCell = cell;
        const item = { observer: null, button, pairId, row: currentRow, cell: currentCell, lastValue, startValue, label, addedAt, addedMcap, imageUrl, thresholds, history: [currentValue], graphResolution: 24, alertedPercent: false, alertedMcap: false };
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
            item.history.push(newValue);
            if (item.history.length > monitorHistoryMax) item.history.shift();
            item.lastValue = newValue;
            checkMonitorAlerts(item, newValue);
            updateMonitorRowInfo(item);
            updateMonitorPanel();
            lastValue = newValue;
        };
        const observer = new MutationObserver(handleValueChange);
        observer.observe(currentRow, { childList: true, characterData: true, subtree: true, attributes: true });
        item.observer = observer;
        mcapMonitors.set(pairId, item);
        addMonitorToStorage(pairId, startValue, addedAt, addedMcap, item.thresholds);
        startMcapPolling();
        updateMonitorRowInfo(item);
        button.dataset.dexMcapButton = '1';
        button.textContent = 'Monitoring';
        button.style.opacity = '0.9';
        updateMonitorPanel();
        if (!silent) showToast('Started MCap monitor');
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

    async function fetchPairMcap(pairId) {
        try {
            const pair = await fetchPairInfo(pairId);
            const candidates = [
                pair.baseToken?.marketCap,
                pair.baseToken?.marketcap,
                pair.baseToken?.marketCapUsd,
                pair.baseToken?.marketcapUsd,
                pair.marketCap,
                pair.marketcap,
                pair.baseToken?.liquidity?.usd,
                pair.pair?.liquidity?.usd,
                pair.liquidity?.usd
            ];
            for (const value of candidates) {
                if (value == null) continue;
                if (typeof value === 'number') return value;
                if (typeof value === 'string') {
                    const parsed = parseMcapValue(value);
                    if (parsed !== null) return parsed;
                    const plain = Number(value.replace(/[^0-9\.]/g, ''));
                    if (!Number.isNaN(plain)) return plain;
                }
            }
        } catch (e) {
            console.warn('fetchPairMcap failed', pairId, e);
        }
        return null;
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
        closeButton.textContent = '✕';
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

        copyButton.dataset.dexActionKey = 'ca';
        gmgnButton.dataset.dexActionKey = 'gmgn';
        xcaButton.dataset.dexActionKey = 'xca';
        xtickerButton.dataset.dexActionKey = 'xticker';
        bubbleButton.dataset.dexActionKey = 'bubble';
        pumpFunButton.dataset.dexActionKey = 'pumpfun';
        solscanButton.dataset.dexActionKey = 'solscan';
        dexToolsButton.dataset.dexActionKey = 'dextools';
        telegramButton.dataset.dexActionKey = 'telegram';
        mcapButton.dataset.dexActionKey = 'monitor';
        [copyButton, gmgnButton, xcaButton, xtickerButton, bubbleButton, pumpFunButton, solscanButton, dexToolsButton, telegramButton, mcapButton].forEach(btn => {
            btn.dataset.dexActionButton = '1';
        });
        wrapper.append(copyButton, gmgnButton, xcaButton, xtickerButton, bubbleButton, pumpFunButton, solscanButton, dexToolsButton, telegramButton, mcapButton);
        anchor.insertAdjacentElement('afterend', wrapper);
        updateAllActionButtonVisibility();
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
        toggleButton.textContent = '▾';
        toggleButton.style.cssText = 'padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:13px;cursor:pointer;min-width:32px;';
        const filterGroup = document.createElement('div');
        filterGroup.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px;';
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px;';
        const dipButton = document.createElement('button');
        dipButton.type = 'button';
        dipButton.textContent = 'Dip Only';
        const rangeButton = document.createElement('button');
        rangeButton.type = 'button';
        rangeButton.textContent = '20-100K';
        const autoMonitorButton = document.createElement('button');
        autoMonitorButton.type = 'button';
        autoMonitorButton.textContent = autoMonitorNewPairs ? 'Auto monitor ON' : 'Auto monitor OFF';
        const monitorAllButton = document.createElement('button');
        monitorAllButton.type = 'button';
        monitorAllButton.textContent = 'Monitor all';
        const actionConfigButton = document.createElement('button');
        actionConfigButton.type = 'button';
        actionConfigButton.textContent = '⚙';
        actionConfigButton.title = 'Button config';
        actionConfigButton.style.cssText = 'padding:6px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:14px;cursor:pointer;min-width:34px;display:flex;align-items:center;justify-content:center;';
        actionConfigButton.addEventListener('mouseenter', () => actionConfigButton.style.background = 'rgba(255,255,255,0.16)');
        actionConfigButton.addEventListener('mouseleave', () => actionConfigButton.style.background = 'rgba(255,255,255,0.08)');
        const headerRight = document.createElement('div');
        headerRight.style.cssText = 'display:flex;align-items:center;gap:4px;';
        [dipButton, rangeButton].forEach(btn => {
            btn.style.cssText = 'padding:6px 8px;border:none;border-radius:8px;background:#2f9cdb;color:#111;font-size:12px;line-height:1.2;cursor:pointer;white-space:normal;word-break:break-word;overflow:hidden;text-overflow:ellipsis;min-height:40px;';
            btn.addEventListener('mouseenter', () => btn.style.background = '#35b1eb');
            btn.addEventListener('mouseleave', () => btn.style.background = '#2f9cdb');
        });
        [autoMonitorButton, monitorAllButton, actionConfigButton].forEach(btn => {
            btn.style.cssText = 'padding:6px 8px;border:none;border-radius:8px;background:#26a69a;color:#111;font-size:12px;line-height:1.2;cursor:pointer;white-space:normal;word-break:break-word;overflow:hidden;text-overflow:ellipsis;min-height:40px;';
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
        monitorAllButton.textContent = 'Import all';
        autoMonitorButton.id = 'dex-auto-monitor-toggle';
        autoMonitorButton.addEventListener('click', () => {
            autoMonitorNewPairs = !autoMonitorNewPairs;
            monitorSettings.autoMonitorNewPairs = autoMonitorNewPairs;
            saveMonitorSettings();
            autoMonitorButton.textContent = autoMonitorNewPairs ? 'Auto monitor ON' : 'Auto monitor OFF';
            if (autoMonitorNewPairs) addNewMcapMonitors();
            showToast(autoMonitorNewPairs ? 'Enabled auto-monitor for new pairs' : 'Disabled auto-monitor');
        });
        actionConfigButton.addEventListener('click', () => {
            configureActionButtons();
        });
        const restoreToggleButton = document.createElement('button');
        restoreToggleButton.type = 'button';
        restoreToggleButton.textContent = monitorSettings.restoreMonitorsOnLoad ? 'Restore ON' : 'Restore OFF';
        restoreToggleButton.style.cssText = 'padding:6px 8px;border:none;border-radius:8px;background:#26a69a;color:#111;font-size:12px;line-height:1.2;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        restoreToggleButton.addEventListener('mouseenter', () => restoreToggleButton.style.background = '#2ac6b3');
        restoreToggleButton.addEventListener('mouseleave', () => restoreToggleButton.style.background = '#26a69a');
        restoreToggleButton.addEventListener('click', () => {
            monitorSettings.restoreMonitorsOnLoad = !monitorSettings.restoreMonitorsOnLoad;
            saveMonitorSettings();
            restoreToggleButton.textContent = monitorSettings.restoreMonitorsOnLoad ? 'Restore ON' : 'Restore OFF';
            showToast(monitorSettings.restoreMonitorsOnLoad ? 'Monitor restore enabled' : 'Monitor restore disabled');
        });
        toggleButton.addEventListener('click', () => {
            const collapsed = container.dataset.collapsed === '1';
            const nextCollapsed = !collapsed;
            container.dataset.collapsed = nextCollapsed ? '1' : '0';
            filterGroup.style.display = nextCollapsed ? 'none' : 'grid';
            buttonGroup.style.display = nextCollapsed ? 'none' : 'grid';
            presetRow.style.display = nextCollapsed ? 'none' : 'flex';
            monitorPanel.style.display = nextCollapsed ? 'none' : 'flex';
            toggleButton.textContent = nextCollapsed ? '▸' : '▾';
            monitorSettings.panelCollapsed = nextCollapsed;
            saveMonitorSettings();
        });
        const monitorPanel = document.createElement('div');
        monitorPanel.id = 'dex-mcap-monitor-panel';
        monitorPanel.style.cssText = 'border-top:1px solid rgba(255,255,255,.1);padding-top:8px;margin-top:8px;display:flex;flex-direction:column;overflow:auto;max-height:calc(100vh - 220px);';
        monitorPanel.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:12px;color:#fff;">' +
            '<span><span class="dex-mcap-monitor-count">0 active</span></span>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
            '<button id="dex-mcap-sort-percent" style="padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:11px;cursor:pointer;">Sort %</button>' +
            '<button id="dex-mcap-sort-date" style="padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:11px;cursor:pointer;">Sort date</button>' +
            '<button id="dex-mcap-sort-activity" style="padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:11px;cursor:pointer;">Sort activity</button>' +
            '<button id="dex-mcap-stop-all" title="Remove all monitors" style="padding:4px 8px;border:none;border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;font-size:14px;cursor:pointer;">✕</button>' +
            '</div>' +
            '</div>' +
            '<div class="dex-mcap-monitor-list" style="overflow:auto;color:#ddd;font-size:12px;min-height:40px;"></div>';
        header.append(title, headerRight);
        headerRight.append(actionConfigButton, toggleButton);
        filterGroup.append(dipButton, rangeButton);
        buttonGroup.append(autoMonitorButton, monitorAllButton, restoreToggleButton);
        const presetRow = document.createElement('div');
        presetRow.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
        const presetSelect = document.createElement('select');
        presetSelect.style.cssText = 'flex:1;min-width:120px;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#111;color:#fff;font-size:12px;';
        const presetLoadButton = document.createElement('button');
        presetLoadButton.type = 'button';
        presetLoadButton.textContent = 'Load';
        const presetSaveButton = document.createElement('button');
        presetSaveButton.type = 'button';
        presetSaveButton.textContent = 'Save';
        const presetDeleteButton = document.createElement('button');
        presetDeleteButton.type = 'button';
        presetDeleteButton.textContent = 'Del';
        [presetLoadButton, presetSaveButton, presetDeleteButton].forEach(btn => {
            btn.style.cssText = 'padding:6px 8px;border:none;border-radius:8px;background:#444;color:#fff;font-size:12px;cursor:pointer;';
            btn.addEventListener('mouseenter', () => btn.style.background = '#555');
            btn.addEventListener('mouseleave', () => btn.style.background = '#444');
        });
        presetLoadButton.addEventListener('click', () => {
            if (!presetSelect.value) return;
            applyMonitorPreset(presetSelect.value);
        });
        presetSaveButton.addEventListener('click', () => {
            const name = prompt('Preset name:', 'My preset');
            if (!name) return;
            saveCurrentMonitorPreset(name.trim());
            refreshPresetOptions();
        });
        presetDeleteButton.addEventListener('click', () => {
            if (!presetSelect.value) return;
            deleteMonitorPreset(presetSelect.value);
            refreshPresetOptions();
        });
        presetRow.append(presetSelect, presetLoadButton, presetSaveButton, presetDeleteButton);
        const refreshPresetOptions = () => {
            presetSelect.innerHTML = '<option value="">Preset</option>';
            Object.keys(monitorPresets).forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                presetSelect.appendChild(option);
            });
        };
        refreshPresetOptions();
        container.append(header, filterGroup, buttonGroup, presetRow, monitorPanel);
        if (monitorSettings.panelLeft !== null && monitorSettings.panelTop !== null) {
            container.style.left = monitorSettings.panelLeft + 'px';
            container.style.top = monitorSettings.panelTop + 'px';
            container.style.right = 'auto';
        }
        container.dataset.collapsed = monitorSettings.panelCollapsed ? '1' : '0';
        filterGroup.style.display = monitorSettings.panelCollapsed ? 'none' : 'grid';
        buttonGroup.style.display = monitorSettings.panelCollapsed ? 'none' : 'grid';
        presetRow.style.display = monitorSettings.panelCollapsed ? 'none' : 'flex';
        monitorPanel.style.display = monitorSettings.panelCollapsed ? 'none' : 'flex';
        toggleButton.textContent = monitorSettings.panelCollapsed ? '▸' : '▾';
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
        header.addEventListener('pointerup', event => {
            if (!dragState) return;
            monitorSettings.panelLeft = parseInt(container.style.left, 10) || 0;
            monitorSettings.panelTop = parseInt(container.style.top, 10) || 0;
            saveMonitorSettings();
        });
        header.addEventListener('pointermove', onPointerMove);
        header.addEventListener('pointerup', onPointerUp);
        header.addEventListener('pointercancel', onPointerUp);

        document.getElementById('dex-mcap-stop-all').addEventListener('click', stopAllMcapMonitors);
        const percentSortButton = document.getElementById('dex-mcap-sort-percent');
        const dateSortButton = document.getElementById('dex-mcap-sort-date');
        if (percentSortButton) {
            percentSortButton.addEventListener('click', () => {
                if (monitorSortBy === 'percent') {
                    monitorSortDescending = !monitorSortDescending;
                } else {
                    monitorSortBy = 'percent';
                    monitorSortDescending = true;
                }
                monitorSettings.sortBy = monitorSortBy;
                monitorSettings.sortDescending = monitorSortDescending;
                saveMonitorSettings();
                updateMonitorSortButton();
                updateMonitorPanel();
            });
        }
        if (dateSortButton) {
            dateSortButton.addEventListener('click', () => {
                if (monitorSortBy === 'date') {
                    monitorSortDescending = !monitorSortDescending;
                } else {
                    monitorSortBy = 'date';
                    monitorSortDescending = true;
                }
                monitorSettings.sortBy = monitorSortBy;
                monitorSettings.sortDescending = monitorSortDescending;
                saveMonitorSettings();
                updateMonitorSortButton();
                updateMonitorPanel();
            });
        }
        const activitySortButton = document.getElementById('dex-mcap-sort-activity');
        if (activitySortButton) {
            activitySortButton.addEventListener('click', () => {
                if (monitorSortBy === 'activity') {
                    monitorSortDescending = !monitorSortDescending;
                } else {
                    monitorSortBy = 'activity';
                    monitorSortDescending = true;
                }
                monitorSettings.sortBy = monitorSortBy;
                monitorSettings.sortDescending = monitorSortDescending;
                saveMonitorSettings();
                updateMonitorSortButton();
                updateMonitorPanel();
            });
        }
        updateMonitorSortButton();
        updateMonitorPanel();
    }

    const debouncedScanDexscreenerLinks = debounce(() => {
        scheduleIdle(scanDexscreenerLinks);
    }, 200);

    function scanDexscreenerLinks() {
        cleanupCopyWrappers();
        const anchors = document.querySelectorAll('a.ds-dex-table-row[href*="/solana/"]');
        anchors.forEach(anchor => {
            const pairId = getPairIdFromHref(anchor.href);
            if (!pairId) return;
            const existing = getCopyWrapper(anchor);
            if (existing) return;
            const mcapButton = insertCopyButton(anchor);
            if (mcapButton) {
                anchor.dataset.dexEnhanced = '1';
                if (autoMonitorNewPairs && !mcapMonitors.has(pairId)) {
                    startMcapMonitor(pairId, anchor, mcapButton, true);
                }
            }
        });
    }

    function findFavoriteIndicatorButton() {
        const exactSelector = 'button[data-tooltip="indicator_preset" i], button[aria-label="indicator_preset" i], button[data-tooltip="a" i], button[aria-label="a" i]';
        const buttons = Array.from(document.querySelectorAll(exactSelector));
        if (buttons.length) return buttons.find(btn => btn.textContent.trim() === 'I' || btn.textContent.trim() === 'A') || buttons[0];

        const node = Array.from(document.querySelectorAll('.round-j7oVl2yI, [data-tooltip], [aria-label], button, [role="button"]')).find(el => {
            const tooltip = (el.getAttribute && (el.getAttribute('data-tooltip') || '') || '').trim().toLowerCase();
            const aria = (el.getAttribute && (el.getAttribute('aria-label') || '') || '').trim().toLowerCase();
            const text = (el.textContent || '').trim();
            if (tooltip === 'indicator_preset' || aria === 'indicator_preset') return true;
            if (tooltip === 'a' || aria === 'a') return true;
            if (text === 'I' || text === 'A') return true;
            return false;
        });

        if (!node) return null;
        if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || node.tagName === 'A') {
            return node;
        }
        return node.closest('button, [role="button"], a') || node;
    }

    function waitForFavoriteIndicatorButton(timeoutMs = 8000) {
        const interval = 250;
        const deadline = Date.now() + timeoutMs;
        return new Promise(resolve => {
            const check = () => {
                const button = findFavoriteIndicatorButton();
                if (button) return resolve(button);
                if (Date.now() >= deadline) return resolve(null);
                setTimeout(check, interval);
            };
            check();
        });
    }

    function dispatchClick(element) {
        element.focus?.();
        const pointerEnter = new PointerEvent('pointerenter', { bubbles: true, cancelable: true, pointerType: 'mouse', view: window });
        const mouseEnter = new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window });
        const pointerOver = new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerType: 'mouse', view: window });
        const mouseOver = new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window });
        const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', view: window });
        const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
        const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        element.dispatchEvent(pointerEnter);
        element.dispatchEvent(mouseEnter);
        element.dispatchEvent(pointerOver);
        element.dispatchEvent(mouseOver);
        element.dispatchEvent(pointerDown);
        element.dispatchEvent(mouseDown);
        element.dispatchEvent(mouseUp);
        if (!element.dispatchEvent(clickEvent)) {
            element.click();
        }
    }

    function isDexscreenerTokenPage() {
        return /^\/solana\/[A-Za-z0-9]{32,44}(?:\/.*)?$/.test(location.pathname);
    }

    async function applyFavoriteIndicatorsPreset() {
        const button = await waitForFavoriteIndicatorButton();
        if (!button || button.dataset.dexFavoriteIndicatorsClicked === '1') return false;
        button.dataset.dexFavoriteIndicatorsClicked = '1';
        dispatchClick(button);
        return true;
    }

    function observeTokenPage() {
        if (!isDexscreenerTokenPage()) return;
        let observer;
        const cleanup = () => {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
        };

        const tryApply = async () => {
            if (await applyFavoriteIndicatorsPreset()) {
                cleanup();
            }
        };

        void tryApply();
        observer = new MutationObserver(() => {
            void tryApply();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(cleanup, 12000);
    }

    function observeDexscreener() {
        if (isDexscreenerTokenPage()) return;
        monitorSettings = loadMonitorSettings();
        monitorPresets = loadMonitorPresets();
        monitorSortBy = monitorSettings.sortBy;
        monitorSortDescending = monitorSettings.sortDescending;
        autoMonitorNewPairs = monitorSettings.autoMonitorNewPairs;
        loadPairInfoCache();
        scheduleIdle(() => {
            scanDexscreenerLinks();
            createFloatingControls();
            if (monitorSettings.restoreMonitorsOnLoad) {
                restoreMonitors();
            }
            if (autoMonitorNewPairs) addNewMcapMonitors();
        });
        const observer = new MutationObserver(debouncedScanDexscreenerLinks);
        observer.observe(getDexScreenerMutationRoot(), { childList: true, subtree: true });
    }

    if (location.hostname.includes('dexscreener')) {
        if (isDexscreenerTokenPage()) {
            observeTokenPage();
        } else {
            observeDexscreener();
        }
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand("Copy DEX pair addresses", copyPairs);
    }
})();
