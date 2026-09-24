// bitShot image pipeline. Pure functions with no DOM access, so the same
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
// Kuwahara filter using summed-area tables: O(1) per quadrant.
function kuwahara(d, w, h, r){
  const W1 = w + 1, N = W1 * (h + 1);
  const sR = new Float64Array(N), sG = new Float64Array(N), sB = new Float64Array(N), sL = new Float64Array(N), sQ = new Float64Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4, i = (y + 1) * W1 + x + 1, a = i - 1, b = i - W1, c = b - 1;
    const R = d[p], G = d[p+1], B = d[p+2], L = 0.299 * R + 0.587 * G + 0.114 * B;
    sR[i] = R + sR[a] + sR[b] - sR[c]; sG[i] = G + sG[a] + sG[b] - sG[c]; sB[i] = B + sB[a] + sB[b] - sB[c];
    sL[i] = L + sL[a] + sL[b] - sL[c]; sQ[i] = L * L + sQ[a] + sQ[b] - sQ[c];
  }
  const box = (t, x0, y0, x1, y1) => t[(y1+1)*W1 + x1+1] - t[y0*W1 + x1+1] - t[(y1+1)*W1 + x0] + t[y0*W1 + x0];
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = Infinity, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
    for (let q = 0; q < 4; q++) {
      const x0 = Math.max(0, q & 1 ? x : x - r), x1 = Math.min(w - 1, q & 1 ? x + r : x);
      const y0 = Math.max(0, q & 2 ? y : y - r), y1 = Math.min(h - 1, q & 2 ? y + r : y);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1), m = box(sL, x0, y0, x1, y1) / n;
      const v = box(sQ, x0, y0, x1, y1) / n - m * m;
      if (v < best) { best = v; bx0 = x0; by0 = y0; bx1 = x1; by1 = y1; }
    }
    const n = (bx1 - bx0 + 1) * (by1 - by0 + 1), p = (y * w + x) * 4;
    out[p] = box(sR, bx0, by0, bx1, by1) / n; out[p+1] = box(sG, bx0, by0, bx1, by1) / n; out[p+2] = box(sB, bx0, by0, bx1, by1) / n; out[p+3] = 255;
  }
  return out;
}
function halve(d, w, h){
  const W = w >> 1, H = h >> 1, o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = ((2*y) * w + 2*x) * 4, b = a + 4, c = a + w * 4, e = c + 4, p = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) o[p+k] = (d[a+k] + d[b+k] + d[c+k] + d[e+k]) / 4;
    o[p+3] = 255;
  }
  return o;
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

// k-means (k-means++ seeding, fixed seed so sliders don't flicker) in Oklab
function kmeansPalette(d, n, k){
  const rand = mulberry32(12345);
  const step = Math.max(1, Math.floor(n / 6000)), S = [];
  for (let i = 0; i < n; i += step) { const p = i * 4; S.push(toLab(d[p], d[p+1], d[p+2])); }
  const m = S.length, C = [S[Math.floor(rand() * m)].slice()], D = new Float64Array(m).fill(Infinity);
  const dist = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
  while (C.length < k) {
    const last = C[C.length - 1]; let tot = 0;
    for (let i = 0; i < m; i++) { const dd = dist(S[i], last); if (dd < D[i]) D[i] = dd; tot += D[i]; }
    if (tot <= 1e-12) break; // fewer distinct colors than k
    let r = rand() * tot, j = 0;
    for (; j < m - 1; j++) { r -= D[j]; if (r <= 0) break; }
    C.push(S[j].slice());
  }
  const K = C.length, asg = new Int32Array(m);
  for (let it = 0; it < 12; it++) {
    const sum = new Float64Array(K * 3), cnt = new Int32Array(K);
    for (let i = 0; i < m; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < K; c++) { const dd = dist(S[i], C[c]); if (dd < bd) { bd = dd; bi = c; } }
      asg[i] = bi; cnt[bi]++; sum[bi*3] += S[i][0]; sum[bi*3+1] += S[i][1]; sum[bi*3+2] += S[i][2];
    }
    for (let c = 0; c < K; c++) if (cnt[c]) C[c] = [sum[c*3]/cnt[c], sum[c*3+1]/cnt[c], sum[c*3+2]/cnt[c]];
  }
  return C.map(c => fromLab(c[0], c[1], c[2]));
}
const snap15 = v => Math.round(Math.round(v * 31 / 255) * 255 / 31);
const hexToRgb = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];

// ---------- Pipeline stages ----------
function buildPalette(d, n, params){
  if (params.palette in FIXED_PALETTES) return FIXED_PALETTES[params.palette].map(hexToRgb);
  let pal = kmeansPalette(d, n, params.colors);
  if (params.palette === "adaptive15") pal = pal.map(c => c.map(snap15));
  const seen = new Set();
  return pal.filter(c => { const k = c.join(); if (seen.has(k)) return false; seen.add(k); return true; });
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
// Outline mask: pixels on the dark side of strong Sobel edges.
function outlineMask(d, W, H, sensitivity){
  const n = W * H, Lm = new Float32Array(n);
  for (let i = 0; i < n; i++) Lm[i] = 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2];
  const at = (x, y) => Lm[Math.min(H-1, Math.max(0, y)) * W + Math.min(W-1, Math.max(0, x))];
  const thr = 200 - sensitivity * 1.7; // higher sensitivity = lower threshold
  const edge = new Uint8Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = -at(x-1,y-1) - 2*at(x-1,y) - at(x-1,y+1) + at(x+1,y-1) + 2*at(x+1,y) + at(x+1,y+1);
    const gy = -at(x-1,y-1) - 2*at(x,y-1) - at(x+1,y-1) + at(x-1,y+1) + 2*at(x,y+1) + at(x+1,y+1);
    if (Math.hypot(gx, gy) / 4 > thr) {
      let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += at(x+i, y+j);
      if (at(x, y) < s / 9) edge[y * W + x] = 1;
    }
  }
  return edge;
}
// For each palette entry, the nearest clearly darker entry (itself if none).
function darkerMap(palLab){
  const K = palLab.length;
  return palLab.map((q, idx) => {
    const t = [q[0] * 0.55, q[1] * 0.9, q[2] * 0.9]; let bi = idx, bd = Infinity;
    for (let c = 0; c < K; c++) { const p = palLab[c]; if (p[0] >= q[0] - 0.02 && c !== idx) continue; const dd = (t[0]-p[0])**2 + (t[1]-p[1])**2 + (t[2]-p[2])**2; if (dd < bd) { bd = dd; bi = c; } }
    return bi;
  });
}
function ditherFloydSteinberg(d, W, H, pal, nearest, amt){
  const n = W * H, idx = new Int16Array(n), f = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { f[i*3] = d[i*4]; f[i*3+1] = d[i*4+1]; f[i*3+2] = d[i*4+2]; }
  const push = (x, y, er, eg, eb, wt) => { if (x < 0 || x >= W || y >= H) return; const j = (y * W + x) * 3; f[j] += er * wt; f[j+1] += eg * wt; f[j+2] += eb * wt; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = i * 3;
    // Clamp first: error the palette can never absorb (e.g. blue in an all-green palette) must not pile up
    const r = Math.min(255, Math.max(0, f[j])), g = Math.min(255, Math.max(0, f[j+1])), b = Math.min(255, Math.max(0, f[j+2]));
    const c = nearest(r, g, b); idx[i] = c;
    const er = (r - pal[c][0]) * amt, eg = (g - pal[c][1]) * amt, eb = (b - pal[c][2]) * amt;
    push(x+1, y, er, eg, eb, 7/16); push(x-1, y+1, er, eg, eb, 3/16); push(x, y+1, er, eg, eb, 5/16); push(x+1, y+1, er, eg, eb, 1/16);
  }
  return idx;
}
function ditherBayer(d, W, H, K, nearest, amt){
  const idx = new Int16Array(W * H);
  const spread = amt * 255 / Math.max(2, Math.cbrt(K) * 1.6);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, p = i * 4, o = amt ? ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * spread : 0;
    idx[i] = nearest(d[p] + o, d[p+1] + o, d[p+2] + o);
  }
  return idx;
}
function compose(idx, pal, edge, darker){
  const n = idx.length, od = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = edge && edge[i] ? darker[idx[i]] : idx[i], p = i * 4;
    od[p] = pal[c][0]; od[p+1] = pal[c][1]; od[p+2] = pal[c][2]; od[p+3] = 255;
  }
  return od;
}

// ---------- Main entry ----------
// Size factor of the input relative to the output: smoothing runs at 2x.
function workScale(params){ return params.smooth > 0 ? 2 : 1; }

// `data` is RGBA at (W * workScale) x (H * workScale). It is not modified.
// Returns the W x H result as RGBA plus the palette sorted dark to light.
function process(data, W, H, params){
  const s = workScale(params);
  if (data.length !== W * s * H * s * 4) throw new Error("Input size does not match output size");
  let d = new Uint8ClampedArray(data);
  if (params.autoContrast) autoContrast(d);
  saturate(d, params.boost);
  if (s === 2) d = halve(kuwahara(d, W * 2, H * 2, params.smooth), W * 2, H * 2);
  const n = W * H;

  const pal = buildPalette(d, n, params);
  const K = pal.length, palLab = pal.map(c => toLab(c[0], c[1], c[2]));
  const nearest = makeNearest(palLab);
  const edge = params.outline ? outlineMask(d, W, H, params.outlineThr) : null;
  const darker = darkerMap(palLab);

  const amt = params.dither === "none" ? 0 : params.ditherAmt / 100;
  const idx = params.dither === "fs" && amt > 0
    ? ditherFloydSteinberg(d, W, H, pal, nearest, amt)
    : ditherBayer(d, W, H, K, nearest, amt);

  const swatches = pal.map((c, i) => [c, palLab[i][0]]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
  return {rgba: compose(idx, pal, edge, darker), width: W, height: H, swatches};
}

const api = {PALETTES, FIXED_PALETTES, outputSize, autoContrast, lcd, workScale, process, toLab, fromLab, kuwahara, halve, saturate, kmeansPalette, snap15};
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.PixelPipeline = api;
})(typeof self !== "undefined" ? self : this);
