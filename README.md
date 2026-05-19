# userscripts

A small repository of browser user scripts for Tampermonkey / Greasemonkey.

## Included Scripts

### `dex_greasemonkey.js`

- **Name:** Dex Pair Clipboard & Tool Links
- **Version:** 1.2
- **Description:** Adds quick copy and tool link actions for Solana DEX pair/token addresses.
- **Features:**
  - Copies Solana DEX pair/token contract addresses to clipboard
  - Opens BubbleMaps, pump.fun, Solscan, DexTools, Telegram, and Twitter search links
  - Displays header quick-links on Dexscreener rows
  - Injects action buttons for Dexscreener detail pages
  - Supports overlay and result dialogs when automatic clipboard write is unavailable

### `instagram.js`

- **Name:** Instagram Cleaner Pro (Smart Engine v4.9 Hardened)
- **Version:** 4.9.1
- **Description:** Filters Instagram feed content by hiding ads, suggested posts, videos, and already liked posts.
- **Features:**
  - Hardened ad detection
  - Suggested post filtering
  - Optional soft-hide mode
  - Persistent settings via GM storage
  - Works on `instagram.com`

## Installation

1. Install a userscript manager such as Tampermonkey or Greasemonkey.
2. Open the desired script file in your browser or paste its contents into a new userscript.
3. Save and enable the script in the userscript manager.

## Usage

- `dex_greasemonkey.js` runs on all sites and activates when Solana DEX pair links are detected.
- `instagram.js` runs on Instagram and automatically cleans visible posts based on configured rules.

## Notes

- These scripts are designed for personal browser automation and may require updates if target websites change.
- Use responsibly and in accordance with site terms of service.
