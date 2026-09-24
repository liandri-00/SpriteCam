// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../pipeline.js");

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
// Horizontal RGB gradient with a vertical tint, deterministic
function gradient(W, H, dark = 0, bright = 255){
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4, t = dark + (bright - dark) * x / (W - 1);
    d[p] = t; d[p+1] = t * 0.9 + 20 * y / H; d[p+2] = t * 0.7 + 60 * y / H; d[p+3] = 255;
  }
  return d;
}
const params = over => ({palette: "gameboy", colors: 4, boost: 0, dither: "bayer", ditherAmt: 90, smooth: 0, outline: false, outlineThr: 50, autoContrast: false, ...over});
const meanLum = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += lum(d[i], d[i+1], d[i+2]); return s / (d.length / 4); };
const colorsUsed = (d) => { const s = new Set(); for (let i = 0; i < d.length; i += 4) s.add(`${d[i]},${d[i+1]},${d[i+2]}`); return s; };

test("palette list: 19 entries with unique ids, fixed ones dark to light", () => {
  assert.equal(P.PALETTES.length, 19);
  assert.equal(new Set(P.PALETTES.map(p => p.id)).size, 19);
  const adaptive = P.PALETTES.filter(p => !p.colors);
  assert.deepEqual(adaptive.map(p => p.id), ["photo"]);
  for (const p of P.PALETTES.filter(p => p.colors)) {
    assert.ok(p.colors.length >= 2, p.id);
    assert.equal(P.FIXED_PALETTES[p.id], p.colors, p.id);
  }
});

test("outputSize puts the chosen size on the short side, no cap", () => {
  assert.deepEqual(P.outputSize(3024, 4032, 160), [160, 213]);
  assert.deepEqual(P.outputSize(1600, 1200, 160), [213, 160]);
  assert.deepEqual(P.outputSize(1000, 1000, 192), [192, 192]);
  assert.deepEqual(P.outputSize(3840, 960, 320), [1280, 320]);
});

test("process returns an opaque W x H image using only palette colours and leaves the input untouched", () => {
  const W = 40, H = 30, src = gradient(W, H), copy = new Uint8ClampedArray(src);
  const r = P.process(src, W, H, params());
  assert.equal(r.width, W); assert.equal(r.height, H); assert.equal(r.rgba.length, W * H * 4);
  const allowed = new Set(P.FIXED_PALETTES.gameboy.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(",")));
  for (const c of colorsUsed(r.rgba)) assert.ok(allowed.has(c), c);
  for (let i = 3; i < r.rgba.length; i += 4) assert.equal(r.rgba[i], 255);
  assert.deepEqual(src, copy);
});

test("auto contrast spreads a dim photo over the whole palette", () => {
  const W = 64, H = 32, dim = gradient(W, H, 20, 110);
  const off = colorsUsed(P.process(dim, W, H, params({dither: "none"})).rgba).size;
  const on = colorsUsed(P.process(dim, W, H, params({dither: "none", autoContrast: true})).rgba).size;
  assert.ok(on > off, `auto contrast should use more palette colours (${off} -> ${on})`);
  assert.equal(on, 4);
});

test("ordered dithering follows the photo's brightness", () => {
  const W = 96, H = 64, bright = gradient(W, H, 140, 255), dark = gradient(W, H, 0, 115);
  const b = meanLum(P.process(bright, W, H, params()).rgba), d = meanLum(P.process(dark, W, H, params()).rgba);
  assert.ok(b > d + 40, `bright ${b.toFixed(1)} should be well above dark ${d.toFixed(1)}`);
});

test("photo palette picks its colours from the photo", () => {
  const W = 40, H = 30, r = P.process(gradient(W, H), W, H, params({palette: "photo", colors: 4, boost: 20}));
  assert.ok(r.swatches.length >= 2 && r.swatches.length <= 4, `${r.swatches.length} colours`);
});

test("lcd draws each pixel as a (cell - gap) square plus a darker gap line", () => {
  const rgba = new Uint8ClampedArray([200, 100, 40, 255, 10, 20, 30, 255]); // 2 x 1
  const light = P.lcd(rgba, 2, 1, 4, 0.85);
  assert.equal(light.width, 8); assert.equal(light.height, 4);
  const px = (img, x, y) => Array.from(img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
  assert.deepEqual(px(light, 0, 0), [200, 100, 40, 255]);
  assert.deepEqual(px(light, 2, 2), [200, 100, 40, 255]);
  assert.deepEqual(px(light, 3, 0), [170, 85, 34, 255]);   // right gap column
  assert.deepEqual(px(light, 1, 3), [170, 85, 34, 255]);   // bottom gap row
  assert.deepEqual(px(light, 4, 0), [10, 20, 30, 255]);    // second pixel starts at x = 4
  const dark = P.lcd(rgba, 2, 1, 4, 0.12);
  assert.deepEqual(px(dark, 3, 3), [24, 12, 5, 255]);
  // Bigger cells keep the gap at about a quarter of the cell
  const big = P.lcd(rgba, 2, 1, 8, 0.85);
  assert.deepEqual(px(big, 5, 0), [200, 100, 40, 255]);
  assert.deepEqual(px(big, 6, 0), [170, 85, 34, 255]);
  assert.deepEqual(px(big, 7, 0), [170, 85, 34, 255]);
});
