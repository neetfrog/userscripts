// ==UserScript==
// @name         Instagram: Blur Videos + Double-Click Counter
// @namespace    https://tampermonkey.net/
// @version      1.0
// @description  Blurs/blocks videos on Instagram and counts double-clicks since page load
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ---------- CONFIG ---------- */
  const BLUR_PX = 40;              // blur strength
  const BLOCK_PLAYBACK = true;     // stop videos from playing at all
  const COUNT_ON_VIDEOS = false;   // count double-clicks that land on (blurred) videos?

  /* ---------- 1. BLUR VIDEOS (pure CSS = survives Instagram's re-renders) ---------- */
  const style = document.createElement('style');
  style.textContent = `
    video {
      filter: blur(${BLUR_PX}px) grayscale(1) !important;
      opacity: 0.6 !important;
    }
    /* reel/video poster thumbnails sitting next to videos */
    div:has(> video) img {
      filter: blur(${BLUR_PX}px) grayscale(1) !important;
    }
    #ig-dbl-counter {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      background: rgba(0,0,0,.8);
      color: #fff;
      font: 600 14px/1 system-ui, sans-serif;
      padding: 10px 14px;
      border-radius: 999px;
      cursor: pointer;
      user-select: none;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  /* ---------- 2. BLOCK PLAYBACK ---------- */
  if (BLOCK_PLAYBACK) {
    // Neutralize play()
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.tagName === 'VIDEO') {
        this.pause();
        return Promise.resolve();
      }
      return origPlay.apply(this, arguments);
    };

    // Fallback: pause anything that manages to start
    document.addEventListener('play', (e) => {
      if (e.target && e.target.tagName === 'VIDEO') {
        e.target.pause();
        e.target.muted = true;
      }
    }, true);

    // Strip autoplay from newly added videos
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const vids = n.tagName === 'VIDEO' ? [n] : n.querySelectorAll?.('video') || [];
          vids.forEach((v) => {
            v.autoplay = false;
            v.muted = true;
            v.pause();
          });
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------- 3. DOUBLE-CLICK COUNTER (resets on page reload) ---------- */
  let count = 0;
  let badge;

  function makeBadge() {
    badge = document.createElement('div');
    badge.id = 'ig-dbl-counter';
    badge.title = 'Double-clicks since page load (Alt+click to reset)';
    badge.addEventListener('click', (e) => {
      if (e.altKey) { count = 0; render(); }
    });
    document.body.appendChild(badge);
    render();
  }

  function render() {
    if (badge) badge.textContent = `❤️ Double-clicks: ${count}`;
  }

  window.addEventListener('dblclick', (e) => {
    if (e.target.closest && e.target.closest('#ig-dbl-counter')) return;
    if (!COUNT_ON_VIDEOS && e.target.tagName === 'VIDEO') return;
    count++;
    render();
  }, true); // capture phase so Instagram can't stop it

  // Create badge once body exists
  const waitBody = setInterval(() => {
    if (document.body) {
      clearInterval(waitBody);
      makeBadge();
    }
  }, 50);

  // Re-attach badge if Instagram's SPA wipes it
  setInterval(() => {
    if (document.body && badge && !document.body.contains(badge)) {
      document.body.appendChild(badge);
    }
  }, 2000);
})();
