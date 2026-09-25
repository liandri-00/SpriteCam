// SpriteCam image pipeline. Pure functions with no DOM access, so the same
// file runs inside the Web Worker (worker.js), on the main thread as a
// fallback, and under Node for tests.
(function (root) {
"use strict";

// Fixed palettes are listed dark to light. "photo" has no colours: they are picked from each photo.
// `boost` is the saturation boost used with that palette.
const hexList = s => s.split(" ").map(h => "#" + h);
const PALETTES = [
  {id: "gameboy",   name: "Game Boy",            colors: hexList("0F380F 306230 8BAC0F 9BBC0F")},
  {id: "mint",      name: "Mint handheld",       colors: hexList("081820 346856 88C070 E0F8D0")},
  {id: "pocket",    name: "Pocket grey",         colors: hexList("22231E 575851 9A9B92 D8D9CF")},
  {id: "teal",      name: "Teal pop",            colors: hexList("332C50 46878F 94E344 E2F3E4")},
  {id: "icecream",  name: "Ice cream",           colors: hexList("7C3F58 EB6B6F F9A875 FFF6D3")},
  {id: "rustic",    name: "Rustic",              colors: hexList("2C2137 764462 A96868 EDB4A1")},
  {id: "deepsea",   name: "Deep sea",            colors: hexList("002B59 005F8C 00B9BE 9FF4E5")},
  {id: "haze",      name: "Purple haze",         colors: hexList("0B0630 6B1FB1 CC3495 F8E3C4")},
  {id: "lagoon",    name: "Lagoon",              colors: hexList("2D1B00 1E606E 5AB9A8 C4F0C2")},
  {id: "sepia",     name: "Sepia",               colors: hexList("2B1D14 6B4A33 B08A5E EFDCB6")},
  {id: "redlcd",    name: "Red LCD",             colors: hexList("1A0000 5C0000 A30000 FF2A1A")},
  {id: "blueprint", name: "Blueprint",           colors: hexList("0A1A3A 1E4B8C 5C9BD6 D6ECFF")},
  {id: "sunset",    name: "Sunset",              colors: hexList("2B0F54 AB1F65 FF4F69 FFF7F8")},
  {id: "onebit",    name: "1-bit",               colors: hexList("000000 FFFFFF")},
  {id: "paper",     name: "Ink on paper",        colors: hexList("2B2B2B F2EEDF")},
  {id: "cga",       name: "CGA",                 colors: hexList("000000 55FFFF FF55FF FFFFFF"), boost: 30},
  {id: "amber",     name: "Amber monitor",       colors: hexList("1A0F00 7A4A00 D98E04 FFD27A")},
  {id: "phosphor",  name: "Green phosphor",      colors: hexList("001A00 006B1F 1FCC4A A8FFB0")},
  {id: "photo",     name: "From the photo",      colors: null, boost: 20}
];
const FIXED_PALETTES = Object.fromEntries(PALETTES.filter(p => p.colors).map(p => [p.id, p.colors]));
const BAYER4 = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];

// Output size with `short` pixels on the photo's short side (no cap on the long side)
function outputSize(w, h, short){
  return w >= h ? [Math.round(short * w / h), short] : [short, Math.round(short * h / w)];
}

// Auto contrast: stretch brightness so the darkest 1% maps to black and the brightest 1% to white,
// shifting all three channels equally so colours keep their hue. Modifies `d` in place.
function autoContrast(d){
  const hist = new Uint32Array(256), n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2])]++;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
  if (hi - lo < 1) return;
  const k = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2], dl = (l - lo) * k - l;
    d[i] += dl; d[i+1] += dl; d[i+2] += dl;
  }
}

// LCD screen effect: every pixel becomes a cell x cell block whose last quarter (at least 1 px) on the
// right and bottom is a gap line in the pixel's colour times `gapStrength` (0.85 light, 0.12 dark).
function lcd(rgba, W, H, cell, gapStrength){
  const gap = Math.max(1, Math.floor(cell / 4)), solid = cell - gap, OW = W * cell, OH = H * cell;
  const out = new Uint8ClampedArray(OW * OH * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = (y * W + x) * 4, r = rgba[s], g = rgba[s+1], b = rgba[s+2];
    for (let j = 0; j < cell; j++) for (let i = 0; i < cell; i++) {
      const f = i >= solid || j >= solid ? gapStrength : 1, d = ((y * cell + j) * OW + x * cell + i) * 4;
      out[d] = r * f; out[d+1] = g * f; out[d+2] = b * f; out[d+3] = 255;
    }
  }
  return {rgba: out, width: OW, height: OH};
}

// ---------- Image helpers ----------
function saturate(d, amt){
  if (!amt) return;
  const f = 1 + amt / 100;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    d[i] = l + (d[i] - l) * f; d[i+1] = l + (d[i+1] - l) * f; d[i+2] = l + (d[i+2] - l) * f;
  }
}
// ---------- Oklab color space (perceptual distances) ----------
function toLin(v){ v = Math.min(255, Math.max(0, v)) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function toSrgb(v){ v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055; return Math.min(255, Math.max(0, Math.round(v * 255))); }
function toLab(R, G, B){
  const r = toLin(R), g = toLin(G), b = toLin(B);
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
  const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
  const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  return [0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
          1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
          0.0259040371*l + 0.7827717662*m - 0.8086757660*s];
}
function fromLab(L, A, B){
  const l = (L + 0.3963377774*A + 0.2158037573*B) ** 3;
  const m = (L - 0.1055613458*A - 0.0638541728*B) ** 3;
  const s = (L - 0.0894841775*A - 1.2914855480*B) ** 3;
  return [toSrgb( 4.0767416621*l - 3.3077115913*m + 0.2309699292*s),
          toSrgb(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s),
          toSrgb(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s)];
}
function mulberry32(a){ return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// k-means in Oklab. Cold start: k-means++ seeding with a fixed seed so results don't flicker, 12 rounds
// over ~6000 sampled pixels. Warm start (live camera): `seed` holds the previous frame's k colours, which
// get one round over ~2000 pixels. That is much cheaper, and the palette moves smoothly between frames.
function sampleLab(d, n, target){
  const step = Math.max(1, Math.floor(n / target)), S = [];
  for (let i = 0; i < n; i += step) { const p = i * 4; S.push(toLab(d[p], d[p+1], d[p+2])); }
  return S;
}
function kmeansPalette(d, n, k, seed){
  const dist = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
  if (seed && seed.length === k) return lloyd(sampleLab(d, n, 2000), seed.map(c => toLab(c[0], c[1], c[2])), 1, dist);
  const rand = mulberry32(12345), S = sampleLab(d, n, 6000);
  const m = S.length, C = [S[Math.floor(rand() * m)].slice()], D = new Float64Array(m).fill(Infinity);
  while (C.length < k) {
    const last = C[C.length - 1]; let tot = 0;
    for (let i = 0; i < m; i++) { const dd = dist(S[i], last); if (dd < D[i]) D[i] = dd; tot += D[i]; }
    if (tot <= 1e-12) break; // fewer distinct colors than k
    let r = rand() * tot, j = 0;
    for (; j < m - 1; j++) { r -= D[j]; if (r <= 0) break; }
    C.push(S[j].slice());
  }
  return lloyd(S, C, 12, dist);
}
// Lloyd rounds: assign every sample to its nearest centre, move each centre to its samples' mean.
function lloyd(S, C, rounds, dist){
  const K = C.length, m = S.length;
  for (let it = 0; it < rounds; it++) {
    const sum = new Float64Array(K * 3), cnt = new Int32Array(K);
    for (let i = 0; i < m; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < K; c++) { const dd = dist(S[i], C[c]); if (dd < bd) { bd = dd; bi = c; } }
      cnt[bi]++; sum[bi*3] += S[i][0]; sum[bi*3+1] += S[i][1]; sum[bi*3+2] += S[i][2];
    }
    for (let c = 0; c < K; c++) if (cnt[c]) C[c] = [sum[c*3]/cnt[c], sum[c*3+1]/cnt[c], sum[c*3+2]/cnt[c]];
  }
  return C.map(c => fromLab(c[0], c[1], c[2]));
}
const hexToRgb = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];

// ---------- Pipeline stages ----------
function buildPalette(d, n, params){
  if (params.palette in FIXED_PALETTES) return FIXED_PALETTES[params.palette].map(hexToRgb);
  const seen = new Set();
  return kmeansPalette(d, n, params.colors, params.seed).filter(c => { const k = c.join(); if (seen.has(k)) return false; seen.add(k); return true; });
}
// Nearest palette entry in Oklab, memoized on a 6-bit-per-channel key.
function makeNearest(palLab){
  const K = palLab.length, cache = new Int16Array(262144).fill(-1);
  return function nearest(r, g, b){
    r = r < 0 ? 0 : r > 255 ? 255 : r | 0; g = g < 0 ? 0 : g > 255 ? 255 : g | 0; b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    if (cache[key] >= 0) return cache[key];
    const L = toLab(r, g, b); let bi = 0, bd = Infinity;
    for (let c = 0; c < K; c++) { const q = palLab[c], dd = (L[0]-q[0])**2 + (L[1]-q[1])**2 + (L[2]-q[2])**2; if (dd < bd) { bd = dd; bi = c; } }
    return cache[key] = bi;
  };
}
// Ordered (Bayer 4x4) dithering: the same offset is added to all three channels, then the nearest colour is picked.
function ditherBayer(d, W, H, K, nearest, amt){
  const idx = new Int16Array(W * H);
  const spread = amt * 255 / Math.max(2, Math.cbrt(K) * 1.6);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, p = i * 4, o = amt ? ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * spread : 0;
    idx[i] = nearest(d[p] + o, d[p+1] + o, d[p+2] + o);
  }
  return idx;
}
function compose(idx, pal){
  const n = idx.length, od = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = pal[idx[i]], p = i * 4;
    od[p] = c[0]; od[p+1] = c[1]; od[p+2] = c[2]; od[p+3] = 255;
  }
  return od;
}

// ---------- Main entry ----------
// `data` is RGBA at W x H. It is not modified.
// params: {palette: id from PALETTES, colors: count for "photo", boost: saturation %, ditherAmt: 0-100, autoContrast: bool,
//          seed: optional previous-frame colours for "photo" (warm start, see kmeansPalette)}
// Returns the W x H result as RGBA plus the palette sorted dark to light.
function process(data, W, H, params){
  if (data.length !== W * H * 4) throw new Error("Input size does not match output size");
  const d = new Uint8ClampedArray(data);
  if (params.autoContrast) autoContrast(d);
  saturate(d, params.boost);

  const pal = buildPalette(d, W * H, params);
  const palLab = pal.map(c => toLab(c[0], c[1], c[2]));
  const idx = ditherBayer(d, W, H, pal.length, makeNearest(palLab), params.ditherAmt / 100);

  const swatches = pal.map((c, i) => [c, palLab[i][0]]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
  return {rgba: compose(idx, pal), width: W, height: H, swatches};
}

const api = {PALETTES, FIXED_PALETTES, outputSize, autoContrast, lcd, process, toLab, fromLab, saturate, kmeansPalette};
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.PixelPipeline = api;
})(typeof self !== "undefined" ? self : this);
