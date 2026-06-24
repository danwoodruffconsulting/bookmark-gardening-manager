# Go-Live Checklist — Bookmark Gardening Manager

## Before You Can Update the Files

- [ ] **Chrome Web Store Extension ID** — obtained after uploading .zip to
      https://chrome.google.com/webstore/devconsole (one-time $5 developer fee required).
      Paste the ID to Claude to update all `YOUR_EXTENSION_ID` placeholders.

- [ ] **Square donation link** — paste your Square payment/donation URL to Claude
      to update all `YOUR_SQUARE_LINK` placeholders in docs/index.html and landing-page.html.

## Domain — danwoodruffconsulting.com

You have a site at danwoodruffconsulting.com. Once you decide on a path for the
landing page (e.g. danwoodruffconsulting.com/bookmark-gardening-manager/), Claude can:
- Update the `<link rel="canonical">` in docs/index.html
- Update og:url, og:image, and JSON-LD "url" fields
- Add a CNAME file to the docs/ folder so GitHub Pages serves from your custom domain
  (requires a DNS CNAME record pointing to danwoodruffconsulting.github.io)

## Chrome Web Store Listing

- [ ] Upload extension .zip to Chrome Developer Console
- [ ] Copy/paste content from store-listing.md into each field
- [ ] Upload at least 1 screenshot (1280x800 or 640x400)
- [ ] Upload the promo tile from icons/bgm-square-banner.png (or create 440x280 version)
- [ ] Set category: Productivity
- [ ] Set homepage URL to your landing page URL
- [ ] Submit for review (usually 1–3 business days)
- [ ] After approval: paste Extension ID here so Claude can update landing page links

## Post-Launch Marketing

- [ ] Post in r/chrome and r/productivity with your backstory (from store-listing.md)
- [ ] Submit to https://alternativeto.net as a free alternative to paid bookmark managers
- [ ] Launch on https://producthunt.com (schedule for Tuesday–Thursday for best visibility)
- [ ] Add the Chrome Web Store URL to your danwoodruffconsulting.com site

## Files With Placeholders Still Pending

| File | Placeholder | Needs |
|------|-------------|-------|
| docs/index.html | YOUR_EXTENSION_ID | Chrome Web Store ID |
| docs/index.html | YOUR_SQUARE_LINK | Square donation URL |
| landing-page.html | YOUR_EXTENSION_ID | Chrome Web Store ID |
| landing-page.html | YOUR_SQUARE_LINK | Square donation URL |
| store-listing.md | Support URL | GitHub repo URL (already set) |
| store-listing.md | Homepage URL | danwoodruffconsulting.com path |
