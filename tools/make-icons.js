// Draws a 32x32 pixel-art vintage camera and writes the site's icon set.
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const OUT = process.argv[2];
const N = 32;
const C = {
  K: "#1e1a2c", s: "#eeecf4", S: "#b9b3cc", d: "#6f6888", L: "#3a3548", l: "#524a6b",
  g: "#16112a", b: "#4b3d80", c: "#8f82c4", w: "#ffffff", r: "#e0503a", o: "#ff9a7a", v: "#7fa6d8",
  bg: "#4b3d80", bgHi: "#5d4f99"
};
const grid = Array.from({length: N}, () => Array(N).fill(null));
const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y][x] = c; };
const set = (x, y, c) => { grid[y][x] = c; };

// Viewfinder hump and shutter button
rect(17, 8, 24, 10, "S"); rect(17, 8, 24, 8, "s");
rect(7, 9, 9, 10, "r"); set(7, 9, "o");
// Top plate
rect(4, 11, 27, 13, "S"); rect(4, 11, 27, 11, "s"); rect(4, 13, 27, 13, "d");
rect(20, 11, 23, 12, "v"); set(20, 11, "w");
// Leather body and bottom plate
rect(4, 14, 27, 24, "L"); rect(4, 14, 27, 14, "l");
for (const [x, y] of [[6,17],[8,20],[6,23],[25,18],[23,22],[25,23]]) set(x, y, "l");
rect(4, 25, 27, 26, "S"); rect(4, 26, 27, 26, "d");
for (const [x, y] of [[4,11],[27,11],[4,26],[27,26]]) set(x, y, null);
set(3, 12, "d"); set(28, 12, "d"); // strap lugs
// Lens
const cx = 15.5, cy = 19;
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const dx = x + 0.5 - (cx + 0.5), dy = y + 0.5 - (cy + 0.5), r = Math.hypot(dx, dy);
  if (r > 6.5) continue;
  let c = r > 5.6 ? "d" : r > 4.7 ? "S" : r > 3.9 ? "K" : r > 2.5 ? "g" : "b";
  if (r <= 3.9 && dx + dy < -3.2) c = "c";
  if (r > 4.7 && r <= 5.6 && dx + dy < -4) c = "s";
  grid[y][x] = c;
}
set(14, 17, "w"); set(15, 17, "c"); set(14, 18, "c"); set(17, 20, "c");
// 1px outline around every shape
const shape = grid.map(r => r.slice());
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  if (shape[y][x]) continue;
  if ([[1,0],[-1,0],[0,1],[0,-1]].some(([a, b]) => shape[y+b] && shape[y+b][x+a])) grid[y][x] = "K";
}

// Center vertically
grid.shift(); grid.push(Array(N).fill(null));

// Background tile with stepped rounded corners (for "any" icons and the favicon)
function tileAt(x, y){
  const m = Math.min(x, N - 1 - x), n = Math.min(y, N - 1 - y);
  return m + n < 2 ? null : "bg";
}
const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16), 255];
// Render: size x size canvas, art scaled by `scale` at offset `off`, background mode
function render(size, scale, off, mode){
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, rgba) => { const p = (y * size + x) * 4; px.set(rgba, p); };
  if (mode === "full") for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, hex(C.bg));
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    let c = grid[gy][gx] ? C[grid[gy][gx]] : null;
    if (!c && mode === "tile") { const t = tileAt(gx, gy); c = t && C[t]; }
    if (!c) continue;
    const rgba = hex(c);
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) put(off + gx * scale + x, off + gy * scale + y, rgba);
  }
  return png(size, size, px);
}
function png(w, h, rgba){
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, {level: 9})), chunk("IEND", Buffer.alloc(0))]);
}
function svg(){
  const colorAt = (x, y) => grid[y][x] ? C[grid[y][x]] : (tileAt(x, y) && C[tileAt(x, y)]);
  let rects = "";
  for (let y = 0; y < N; y++) for (let x = 0; x < N;) {
    const c = colorAt(x, y);
    let run = 1;
    while (x + run < N && colorAt(x + run, y) === c) run++;
    if (c) rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${c}"/>`;
    x += run;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">${rects}</svg>\n`;
}
fs.mkdirSync(OUT, {recursive: true});
const files = {
  "favicon-32.png": render(32, 1, 0, "tile"),
  "icon-192.png": render(192, 6, 0, "tile"),
  "icon-512.png": render(512, 16, 0, "tile"),
  "icon-maskable-512.png": render(512, 12, 64, "full"),   // art inside the 80% safe zone
  "apple-touch-icon.png": render(180, 5, 10, "full"),     // iOS rounds the corners itself
  "icon.svg": svg()
};
for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(OUT, f), b);
console.log(grid.map(r => r.map(c => c || ".").join("")).join("\n"));
