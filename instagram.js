// ==UserScript==
// @name         Instagram Video Blocker & Double-Click Counter
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Failsafe video blocker (blurs and pauses without breaking scroll) and double-click (like) counter for Instagram.
// @author       You
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 1. FAILSAFE VIDEO BLOCKER (Blur & Pause)
    // ==========================================

    // Inject CSS to heavily blur and dim videos while keeping their layout size intact
    const style = document.createElement('style');
    style.innerHTML = `
        video {
            filter: blur(50px) brightness(0.2) grayscale(100%) !important;
            pointer-events: none !important; /* Prevents clicking on the video */
            transition: none !important;
        }
    `;
    document.head.appendChild(style);

    // Intercept the 'play' event globally.
    // The moment Instagram tries to autoplay a video as you scroll, this pauses and mutes it.
    window.addEventListener('play', function(e) {
        if (e.target && e.target.tagName === 'VIDEO') {
            e.target.pause();
            e.target.muted = true;
        }
    }, true); // 'true' uses the capture phase, which is required to catch media events


    // ==========================================
    // 2. DOUBLE-CLICK (LIKE) COUNTER
    // ==========================================

    let likeCount = 0;

    // Create the floating UI counter
    const counterDiv = document.createElement('div');
    counterDiv.style.position = 'fixed';
    counterDiv.style.bottom = '20px';
    counterDiv.style.right = '20px';
    counterDiv.style.backgroundColor = 'rgba(20, 20, 20, 0.85)';
    counterDiv.style.color = '#ffffff';
    counterDiv.style.padding = '10px 18px';
    counterDiv.style.borderRadius = '30px';
    counterDiv.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    counterDiv.style.fontSize = '14px';
    counterDiv.style.fontWeight = 'bold';
    counterDiv.style.zIndex = '9999999';
    counterDiv.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
    counterDiv.style.border = '1px solid rgba(255,255,255,0.1)';
    counterDiv.style.pointerEvents = 'none'; // Allows you to click "through" the counter if needed
    counterDiv.style.userSelect = 'none';
    counterDiv.style.transition = 'transform 0.15s ease-in-out';
    counterDiv.innerText = '❤️ Session Likes: 0';

    // Add counter to the page
    document.body.appendChild(counterDiv);

    // Listen for double-clicks anywhere on the page
    window.addEventListener('dblclick', function() {
        likeCount++;
        counterDiv.innerText = `❤️ Session Likes: ${likeCount}`;

        // Little "pop" animation when the number goes up
        counterDiv.style.transform = 'scale(1.15)';
        setTimeout(() => {
            counterDiv.style.transform = 'scale(1)';
        }, 150);
    });

})();
