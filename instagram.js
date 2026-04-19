// ==UserScript==
// @name         Instagram Cleaner Pro (Smart Engine v4.9 Hardened)
// @namespace    http://tampermonkey.net/
// @version      4.9.1
// @description  Modular Instagram feed filter + hardened ad detection
// @match        *://www.instagram.com/*
// @include      *instagram.com/*
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    console.log("Instagram Cleaner Pro v4.9.1 Loaded");

    // ----------------------------
    // SETTINGS
    // ----------------------------
    const defaults = {
        hideAds: true,
        hideSuggested: true,
        hideVideos: true,
        hideLiked: true,
        softMode: false,
        debugMode: false
    };

    let settings = { ...defaults };
    const processed = new Set();

    // ----------------------------
    // LOAD / SAVE
    // ----------------------------
    async function loadSettings() {
        for (const k in defaults) {
            const storedValue = await GM.getValue(k, defaults[k]);
            if (typeof defaults[k] === 'boolean') {
                settings[k] = storedValue === true || storedValue === 'true';
            } else if (typeof defaults[k] === 'number') {
                const num = Number(storedValue);
                settings[k] = Number.isFinite(num) ? num : defaults[k];
            } else {
                settings[k] = storedValue;
            }
        }
    }

    async function saveSettings() {
        for (const k in settings) {
            await GM.setValue(k, settings[k]);
        }
    }

    // ----------------------------
    // HIDE LOGIC
    // ----------------------------
    function hide(post, reason) {
        if (settings.debugMode) console.log("[HIDE]", reason);

        if (settings.softMode) {
            post.style.filter = "blur(10px)";
            post.style.opacity = "0.2";
            post.style.pointerEvents = "none";
        } else {
            post.style.height = "0px";
            post.style.opacity = "0";
            post.style.visibility = "hidden";
            post.style.pointerEvents = "none";
            post.style.margin = "0";
            post.style.padding = "0";
        }

        post.dataset.igCleanerHidden = 'true';
    }

    function isHiddenPost(post) {
        if (!post || post.nodeType !== 1) return true;
        if (post.dataset.igCleanerHidden === 'true') return true;

        const style = window.getComputedStyle(post);
        if (!style) return false;

        const opacity = parseFloat(style.opacity);
        const isBlurred = (style.filter || '').includes('blur');

        return (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.pointerEvents === 'none' ||
            post.hasAttribute('hidden') ||
            post.dataset.igCleanerHidden === 'true' ||
            opacity === 0 ||
            opacity < 0.3 ||
            isBlurred
        );
    }

    // ----------------------------
    // 🔥 HARDENED AD DETECTION (FIX)
    // ----------------------------
    function detectAd(post) {
        if (!settings.hideAds) return false;

        const nodes = post.querySelectorAll("span, div, a");

        for (const el of nodes) {
            const txt = (el.textContent || "")
                .replace(/\u200b/g, "")
                .trim()
                .toLowerCase();

            if (txt === "ad") return true;
        }

        const text = (post.innerText || "")
            .replace(/\u200b/g, "")
            .toLowerCase();

        if (text.includes("sponsored")) return true;
        if (text.match(/\bad\b/)) return true;

        return false;
    }

    // ----------------------------
    // SUGGESTED DETECTION (FIXED)
    // ----------------------------
    function detectSuggested(post) {
        if (!settings.hideSuggested) return false;

        const direct = [...post.querySelectorAll("span")]
            .some(el =>
                (el.textContent || "")
                    .trim()
                    .toLowerCase() === "suggested for you"
            );

        if (direct) return true;

        const text = (post.innerText || "").toLowerCase();

        return (
            text.includes("suggested for you") ||
            text.includes("suggested posts") ||
            text.includes("recommended for you") ||
            text.includes("followed by")
        );
    }

    function detectVideo(post) {
        return settings.hideVideos && !!post.querySelector("video");
    }

    function detectLiked(post) {
        if (!settings.hideLiked) return false;

        const btn = post.querySelector('[aria-label*="like"], [aria-label*="Unlike"]');
        const label = btn?.getAttribute("aria-label")?.toLowerCase();

        return label?.includes("unlike");
    }

    function handlePost(post) {
        if (!post || processed.has(post) || isHiddenPost(post)) return;
        processed.add(post);

        if (detectAd(post)) return hide(post, "Ad");
        if (detectSuggested(post)) return hide(post, "Suggested");
        if (detectVideo(post)) return hide(post, "Video");
        if (detectLiked(post)) return hide(post, "Liked");
    }

    function handleFeed() {
        document.querySelectorAll("article").forEach(handlePost);
    }

    function getClosestArticle(node) {
        return node?.nodeType === 1 ? node.closest('article') : null;
    }

    function clearProcessedForMutation(mutations) {
        const articles = new Set();
        for (const mutation of mutations) {
            const targetArticle = getClosestArticle(mutation.target);
            if (targetArticle && !isHiddenPost(targetArticle)) articles.add(targetArticle);

            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    const addedArticle = getClosestArticle(node);
                    if (addedArticle && !isHiddenPost(addedArticle)) articles.add(addedArticle);
                }
            }
        }

        for (const article of articles) {
            processed.delete(article);
        }
    }

    // ----------------------------
    // AUTO LIKER
    // ----------------------------
    // ----------------------------
    // SETTINGS UI
    // ----------------------------
    function createSettingsUI() {
        const btn = document.createElement("div");
        btn.innerText = "⚙";
        btn.style.cssText = `
            position: fixed;
            bottom: 80px;
            right: 20px;
            z-index: 9999999;
            background: black;
            color: white;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            cursor: pointer;
            font-size: 18px;
        `;

        const panel = document.createElement("div");
        panel.style.cssText = `
            position: fixed;
            bottom: 130px;
            right: 20px;
            z-index: 9999999;
            background: rgba(0,0,0,0.92);
            color: white;
            padding: 12px;
            border-radius: 10px;
            font-size: 13px;
            display: none;
            min-width: 240px;
            font-family: Arial;
        `;

        panel.innerHTML = `
            <label><input type="checkbox" id="hideAds"> Hide Ads</label><br>
            <label><input type="checkbox" id="hideSuggested"> Hide Suggested</label><br>
            <label><input type="checkbox" id="hideVideos"> Hide Videos</label><br>
            <label><input type="checkbox" id="hideLiked"> Hide Liked</label><br>
            <label><input type="checkbox" id="softMode"> Soft Mode</label><br>
            <label><input type="checkbox" id="debugMode"> Debug Mode</label><br>
        `;

        btn.onclick = () => {
            panel.style.display = panel.style.display === "block" ? "none" : "block";
        };

        document.body.appendChild(btn);
        document.body.appendChild(panel);

        const bind = () => {
            panel.querySelector("#hideAds").checked = settings.hideAds;
            panel.querySelector("#hideSuggested").checked = settings.hideSuggested;
            panel.querySelector("#hideVideos").checked = settings.hideVideos;
            panel.querySelector("#hideLiked").checked = settings.hideLiked;
            panel.querySelector("#softMode").checked = settings.softMode;
            panel.querySelector("#debugMode").checked = settings.debugMode;
        };

        bind();

        panel.addEventListener("change", async () => {
            settings.hideAds = panel.querySelector("#hideAds").checked;
            settings.hideSuggested = panel.querySelector("#hideSuggested").checked;
            settings.hideVideos = panel.querySelector("#hideVideos").checked;
            settings.hideLiked = panel.querySelector("#hideLiked").checked;
            settings.softMode = panel.querySelector("#softMode").checked;
            settings.debugMode = panel.querySelector("#debugMode").checked;

            await saveSettings();
            processed.clear();
            handleFeed();
        });
    }

    function initObserver() {
        const target = document.querySelector("main") || document.body;

        const observer = new MutationObserver((mutations) => {
            clearProcessedForMutation(mutations);
            handleFeed();
        });

        observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true
        });
    }

    function initPreCleaner() {
        const root = document.querySelector("main") || document.body;

        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1) {
                        if (node.matches?.("article")) {
                            handlePost(node);
                        } else {
                            node.querySelectorAll?.("article").forEach(handlePost);
                        }
                    }
                }
            }
        });

        observer.observe(root, {
            childList: true,
            subtree: true
        });
    }

    async function init() {
        await loadSettings();

        handleFeed();
        createSettingsUI();
        initObserver();
        initPreCleaner();
    }

    init();
})();
