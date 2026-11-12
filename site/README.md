# HHPI public website

This directory is a buildless, Chinese-language public landing page for HHPI, published with GitHub Pages at `https://dqtz5vpvj9-create.github.io/hapi-dsh/`.

The page introduces the three supported sources, includes a three-step product-interface tour, links to the complete preview bundle and its SHA256 checksums, and provides first-install commands and links to the full guides. It uses relative local resource URLs so it can be hosted under `/hapi-dsh/`.

## Local preview

From the repository root:

```sh
python3 -m http.server 8899 --bind 127.0.0.1 --directory site
```

Open `http://127.0.0.1:8899/`. No package installation or build is needed.

## Content and assets

- `index.html` contains the complete primary content and working installation, documentation and source links.
- `styles.css` uses system fonts, a warm neutral background and dark green accent. There are no external font requests.
- `app.js` enhances the interface tour, keyboard navigation and optional command copying. Main content and links remain usable without JavaScript. A `noscript` block provides direct links to every tour image.
- `assets/demo-find-session.webp`, `assets/demo-workspace.webp` and `assets/demo-source-tools.webp` depict the actual product interface with dedicated demonstration data. The tour is a sequence of images, not a recording of production activity.
- `favicon.svg` is the simple HHPI workspace mark.

The website has no tracking, dependencies, account state, connection to a private HHPI runtime or background network calls. Product image links open the original local asset in a new tab. FAQ expansion uses native `details` elements. The image tour only advances after an explicit play action and pauses when its tab is hidden. Styles respect `prefers-reduced-motion`.

## Release links

The current page targets `preview-20261111` and the asset `hapi-dsh-bundle-0.1.2-preview-20261111.tgz`. When changing a release, update both download links, the release links, SHA256 link, installation archive filename and visible preview metadata together. The bundle's own installation and release documents remain authoritative.

Use the repository's Pages workflow to publish this directory. Website-only verification covers static links, a bounded desktop interaction pass and screenshots inspected with the `webshot` skill. It does not run or establish HHPI product, mobile-device or production-runtime acceptance.
