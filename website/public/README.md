# kyrowallet.com

Static site for Kyro Wallet: plain HTML, one stylesheet and three small scripts. Nothing is loaded from other sites (Geist fonts are bundled in `fonts/`, OFL license). No cookies, no trackers.

## Pages

- `/` home, `/features/`, `/security/`, `/fees/`, `/download/`, `/faq/`
- `/chains/` and one page per live blockchain, `/chains/<slug>/`
- `404.html`, `sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`

All of these, plus `chains.css`, are **generated**. Do not edit them by hand: edit the sources in `site-src/` (next to this folder) and rebuild.

## Build

Node 24, no dependencies:

```bash
node site-src/build.mjs
```

- `site-src/chains.json`: the blockchain list. `status: "live"` builds and links the page; `"hidden"` builds nothing and removes a page that was live before.
- `site-src/pages.mjs`: the content of every page.
- `site-src/layout.mjs`: head, header, footer, version number, download file names.
- `site-src/screenshots/` + `site-src/crops.ps1`: full app screenshots, cut into the framings in `img/shot-*.jpg` (Windows, run only when a screenshot changes).

The build checks every internal link and anchor, one `<h1>` per page, valid JSON-LD, and no inline script or style (the CSP forbids them). It exits with an error if something is wrong.

Hand-written files: `style.css`, `motion.js` (reveals, header, screenshot tilt, card spotlight, menu), `download.js` (download button for the visitor's system), `copy.js` (donation address buttons), `img/`, `fonts/`, `favicon.svg`, `_headers`.

## Preview locally

Any static server works, for example from the folder that contains `site/`:

```bash
python -m http.server 4321 --directory site
```

The `_headers` file (CSP and so on) is only applied by Cloudflare Pages.

## Deploy on Cloudflare Pages

1. Cloudflare › Workers & Pages › Create › Pages › connect the repository.
2. Framework: none. Build command: none (pages are committed already built). Output directory: `site`.
3. Add the custom domain `kyrowallet.com`.
4. Leave Web Analytics, Rocket Loader and email obfuscation off: they inject scripts that the CSP blocks.

## Keep in sync

- Download file names (`Kyro-windows-x64-setup.exe`, `Kyro-windows-x64.msi`, `Kyro-macos.dmg`, `Kyro-linux-x86_64.AppImage`, `Kyro-linux-amd64.deb`, `SHA256SUMS`) must match the release workflow. They live in `site-src/layout.mjs` (`FILES`) and `download.js` (`OS`).
- Donation addresses in `site-src/pages.mjs` must match the repository `README.md`, character for character.
- The version number (1.0.0) is `VERSION` in `site-src/layout.mjs`.
- If the installers become code-signed, remove the "First launch" section of the download page and the two FAQ answers about warnings.
