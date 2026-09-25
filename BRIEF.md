# SpriteCam: project brief

## Goal

A mobile-friendly web app that turns photos into handheld-console pixel art
(tiny palettes, dithering, an old LCD screen look) using plain image
processing. No AI, no server: everything runs in the visitor's browser, and
photos never leave the device.

Distribution: a static site on GitHub Pages, linked from Instagram (via a
multi-link page) and LinkedIn. Free, with a voluntary support link. Native
Android/iOS store releases are explicitly out of scope for now.

## Current state

A working web app: take or choose a photo, pick a palette, see the result,
save or share it as a PNG.

- `index.html`: the page. `app.js`: the UI logic (controls, rendering, live camera, save/share).
  `camera.js`: opens the camera and grabs frames. `privacy.html`: the privacy note.
- `site.css`: fonts, colours and layout shared by both pages.
- `manifest.webmanifest`: lets the app be added to the home screen.
- `pipeline.js`: the image processing. Pure functions with no DOM access; it runs
  in a Web Worker (`worker.js`), on the main thread as a fallback (for example
  when the page is opened from disk), and under Node for tests.
- `tests/`: unit tests for the pipeline (`npm test`).
- `tools/`: scripts that regenerate the icons and the README images.
- `fonts/`: self-hosted fonts, so the page makes no third-party requests.
- `icons/`, `media/`: app icons and README images.

## What the user can change

The interface is deliberately minimal. Many palettes are fine (they are just
colour switches); extra configuration options are not.

| Control | Choices | Default |
|---|---|---|
| Palette | 19 palettes, see below | Game Boy |
| Resolution | 144, 160, 192, 224, 256, 320 px on the photo's **short** side, no cap on the long side | 160 |
| LCD effect | Off, Light, Dark | Light |
| Auto contrast | on/off | on |

Fixed by design, not shown in the UI: ordered (Bayer 4x4) dithering at 90%,
4 colours for the "From the photo" palette.

## Palettes

Four-colour: Game Boy, Mint handheld, Pocket grey, Teal pop, Ice cream, Rustic,
Deep sea, Purple haze, Lagoon, Sepia, Red LCD, Blueprint, Sunset.
Others: 1-bit, Ink on paper, CGA (+30% saturation), Amber monitor, Green
phosphor, and "From the photo" (4 colours picked from each photo, +20%
saturation).

The Game Boy palette's two lightest greens are nearly identical, so in practice
it shows three shades; Mint handheld is the evenly spaced alternative.

The "Game Boy" palette name is kept: the project is free, sells nothing and
won't ship to app stores.

## The pipeline

1. **Resize**: the photo is capped at 1600 px, then halved step by step with
   high-quality interpolation down to the output size (short side = chosen
   resolution).
2. **Auto contrast** (optional): brightness is stretched so the darkest 1% of
   pixels become black and the brightest 1% white. All three channels move by
   the same amount, so hues are kept. Matters most for fixed palettes and dim
   photos, where otherwise part of the palette is never used.
3. **Saturation boost**: only for palettes that ask for it (CGA, From the photo).
4. **Palette**: fixed palettes are used as they are. "From the photo" runs
   k-means (k-means++ seeding with a fixed seed so results don't flicker) in the
   Oklab colour space, which matches perceived colour differences.
5. **Dither and match**: ordered Bayer 4x4 offset, then each pixel maps to the
   nearest palette colour in Oklab. A 6-bit-per-channel lookup cache keeps this
   cheap.
6. **Display**: every art pixel covers a whole number of device pixels (the
   "cell"), so pixels stay square at any screen scaling. Only when even 1:1
   doesn't fit is the image shrunk, smoothly.
7. **LCD effect**: drawn at display time by the GPU (art scaled up with crisp
   pixels, then a grid of black lines at 1 - gap opacity; pixel-identical to
   `lcd()` in `pipeline.js`), so switching modes is instant and the live camera
   stays fast. Each
   pixel becomes a cell with a gap line on its right and bottom, a quarter of
   the cell wide (at least 1 px). The gap is the pixel's colour at 85% (Light)
   or 12% (Dark). On screen the grid needs a cell of at least 3 device pixels;
   the saved PNG always uses 4x cells (3x3 square + 1 px gap).

Saved PNG: with LCD it is 4x the art size (160 x 213 becomes 640 x 852),
without LCD it is upscaled to at least 1024 px wide. Files are named
`spritecam-<date>.png`. Share uses the Web Share API where available.

## Decisions made while testing (on real photos)

- Kuwahara smoothing was tried and dropped: on real photos it removed detail
  (whiskers, fur) more than it helped. Outlines, Floyd-Steinberg dithering and
  the adaptive 16/32-colour SNES look were dropped too. They remain in the git
  history if ever needed.
- Floyd-Steinberg with small fixed palettes produces flat patches, because the
  error it tries to spread is a hue the palette can't show (blue in a green
  palette). If diffusion ever comes back, diffuse luminance error only.
- 160 px short side keeps the retro feel; faces at a distance need 192-256,
  hence the resolution choice.

## Measured performance

At 160 px on a desktop CPU a full render takes about 10-35 ms; at 320 px about
15 ms with fixed palettes. Phones are several times slower but still well
within photo-mode needs. With fixed palettes and no smoothing, a live camera
preview in plain JavaScript looks feasible at 160 px.

## Phased plan

### Phase 1: publishable v1 (done)

Done: the app, save/share, self-hosted fonts, icons, README images, unit tests,
git repository, landing section (how to use it, privacy promise), web app
manifest, privacy note (`privacy.html`), README for GitHub visitors, GPL-3.0
licence (`LICENSE`, "or later"), Ko-fi support link
(https://ko-fi.com/liandri_00, a plain link: the Ko-fi embed was not used, so
the page still makes no third-party requests), catchphrase under the title
("wake up. the palette has four colors."). Styles shared by both pages live in
`site.css`. Visible text uses US spelling ("colors").

Deployed 2026-09-25: public repo https://github.com/liandri-00/SpriteCam,
served by GitHub Pages at https://liandri-00.github.io/SpriteCam/.

### Phase 2: live camera (built, awaiting real-phone testing)

Done:

- "Take photo" opens a live viewfinder: camera frames go through the worker one
  at a time, no WebGL needed. Measured in headless Chrome with a fake camera on
  an emulated phone (390 px, 3x density, CPU 4x slower): about 17-24 fps.
- The LCD grid is drawn by the GPU; drawing it pixel by pixel on the main thread
  had cut the emulated phone from 26 to 15 fps.
- "From the photo" warm-starts k-means from the previous frame's colours
  (`seed` param: one round over ~2000 pixels), which also stops palette flicker.
- Front/back camera switch (shown only with 2+ cameras). The front camera is
  mirrored, and shots keep what was on screen.
- Burst: 5-second countdown over a dimmed preview, then 5 shots one second
  apart, each with a white flash (softer with reduced motion). Results go to a
  filmstrip; tap one to use it. Close/Cancel or leaving the page stops it.
- A shot grabs the full camera frame (capped at 1600 px) and then works like a
  chosen photo.
- In-app browsers (Instagram, Facebook, LinkedIn, TikTok…) fall back to the
  phone's camera app through the file input, with an "open in your browser" hint.
  Same fallback when the camera API is missing.
- The camera stops when a shot is taken, on Close, and when the page is hidden.

Still to do:

- Test on real phones, especially iPhones, including the home-screen installed
  mode, where camera streaming has historically been unreliable.

### Phase 3: polish

- Service worker for offline use.
- Nicer empty state.

## Constraints

- No AI, no server calls, no uploads. This is a selling point; keep it true.
- Static hosting only (GitHub Pages). HTTPS is required for camera access.
- GitHub Pages may not be used for primarily commercial sites; a voluntary
  support link on a free project page is fine.
- Photo-then-convert must always work, with or without the live camera.
- `.gitignore` covers OS junk files only. Local tool folders are excluded
  through `.git/info/exclude`, which is never committed.
