// Renders the README images in headless Chrome with the app's own pipeline and default settings
// (160 px short side, auto contrast, LCD Light): before.jpg (original, captioned) and
// after-palettes.png (2x2 grid, one tile per palette in PALETTE_IDS).
// Usage: node tools/readme-images.js <site root> <photo.jpg> <out dir>   (set CHROME to override the browser path)
const http = require("http"), fs = require("fs"), path = require("path"), {spawn} = require("child_process");
const [ROOT, PHOTO, OUT] = process.argv.slice(2);
const types = {".html": "text/html", ".css": "text/css", ".webmanifest": "application/manifest+json", ".js": "text/javascript", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg"};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const p = url === "/__photo.jpg" ? PHOTO : path.join(ROOT, url);
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"content-type": types[path.extname(p)] || "application/octet-stream"}); res.end(b);
  });
}).listen(8766);
const profile = fs.mkdtempSync(path.join(require("os").tmpdir(), "readme-images-"));
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME,
  ["--headless=new", "--remote-debugging-port=9334", "--user-data-dir=" + profile, "--no-first-run", "about:blank"]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PALETTE_IDS = ["gameboy", "pocket", "haze", "amber"];
const PAGE_SCRIPT = `(async () => {
  const PALETTE_IDS = ${JSON.stringify(PALETTE_IDS)};
  const SHORT = 160, LCD_GAP = 0.85, DITHER_AMOUNT = 90;
  const TILE_W = 1280, CAPTION = 96, GAP = 32, BG = "#1d1a26", CAPTION_BG = "#282435", INK = "#ebe8f3";
  const PP = window.PixelPipeline;
  await document.fonts.ready;
  const stat = () => document.getElementById("stat").textContent;
  const blob = await (await fetch("/__photo.jpg")).blob();
  const dt = new DataTransfer(); dt.items.add(new File([blob], "photo.jpg", {type: "image/jpeg"}));
  const inp = document.getElementById("fileIn"); inp.files = dt.files; inp.dispatchEvent(new Event("change"));
  for (let i = 0; i < 300 && !/colors/.test(stat()); i++) await new Promise(r => setTimeout(r, 100));

  // Same steps as the app: capped source photo (#orig) -> stepwise resize -> pipeline -> LCD
  const photo = document.getElementById("orig");
  function resizeTo(source, w, h){
    let cur = source, cw = source.width, ch = source.height;
    while (cw / 2 >= w && ch / 2 >= h) {
      const c = document.createElement("canvas"); c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
      const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, c.width, c.height);
      cur = c; cw = c.width; ch = c.height;
    }
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, w, h);
    return x.getImageData(0, 0, w, h).data;
  }
  const [W, H] = PP.outputSize(photo.width, photo.height, SHORT), pixels = resizeTo(photo, W, H), cell = TILE_W / W;
  const tiles = PALETTE_IDS.map(id => {
    const p = PP.PALETTES.find(x => x.id === id);
    const art = PP.process(pixels, W, H, {palette: id, colors: 4, boost: p.boost || 0, ditherAmt: DITHER_AMOUNT, autoContrast: true});
    const img = PP.lcd(art.rgba, W, H, cell, LCD_GAP), canvas = document.createElement("canvas");
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
    return {label: p.name, canvas, stat: W + " x " + H + ", LCD cell " + cell};
  });
  const scale = t => TILE_W / t.canvas.width;
  const tileH = Math.max(...tiles.map(t => Math.round(t.canvas.height * scale(t))));
  const grid = document.createElement("canvas");
  grid.width = 2 * TILE_W + 3 * GAP; grid.height = 2 * (tileH + CAPTION) + 3 * GAP;
  const g = grid.getContext("2d"); g.fillStyle = BG; g.fillRect(0, 0, grid.width, grid.height);
  g.imageSmoothingEnabled = false;
  const caption = (ctx, x, y, w, text) => {
    ctx.fillStyle = CAPTION_BG; ctx.fillRect(x, y, w, CAPTION);
    ctx.fillStyle = INK; ctx.font = "700 44px Silkscreen"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 36, y + CAPTION / 2 + 2);
  };
  tiles.forEach((t, i) => {
    const x = GAP + (i % 2) * (TILE_W + GAP), y = GAP + Math.floor(i / 2) * (tileH + CAPTION + GAP);
    const s = scale(t), h = Math.round(t.canvas.height * s);
    g.drawImage(t.canvas, x, y + Math.floor((tileH - h) / 2), TILE_W, h);
    caption(g, x, y + tileH, TILE_W, t.label);
  });

  // Before image: same aspect ratio as the grid so they line up side by side
  const before = document.createElement("canvas");
  before.width = Math.round(grid.width / 2); before.height = Math.round(grid.height / 2);
  const b = before.getContext("2d"), src = document.getElementById("orig");
  const cap = CAPTION / 2 * 1.0, areaH = before.height - cap - GAP, areaW = before.width - GAP;
  b.fillStyle = BG; b.fillRect(0, 0, before.width, before.height);
  const k = Math.max(areaW / src.width, areaH / src.height), sw = areaW / k, sh = areaH / k;
  b.imageSmoothingQuality = "high";
  b.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, GAP / 2, GAP / 2, areaW, areaH);
  b.fillStyle = CAPTION_BG; b.fillRect(GAP / 2, GAP / 2 + areaH, areaW, cap);
  b.fillStyle = INK; b.font = "700 22px Silkscreen"; b.textBaseline = "middle"; b.fillText("Original photo", GAP / 2 + 18, GAP / 2 + areaH + cap / 2 + 1);

  const toData = (c, type, q) => new Promise(r => c.toBlob(bl => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(bl); }, type, q));
  return {grid: await toData(grid, "image/png"), before: await toData(before, "image/jpeg", 0.86), stats: tiles.map(t => t.label + ": " + t.stat), size: [grid.width, grid.height, before.width, before.height]};
})()`;

async function main(){
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await sleep(200);
    try { wsUrl = (await (await fetch("http://127.0.0.1:9334/json/list")).json()).find(t => t.type === "page").webSocketDebuggerUrl; } catch (e) { /* Chrome still starting */ }
  }
  const ws = new WebSocket(wsUrl); await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
  await send("Emulation.setDeviceMetricsOverride", {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
  await send("Page.navigate", {url: "http://127.0.0.1:8766/index.html"}); await sleep(1500);
  const r = await send("Runtime.evaluate", {expression: PAGE_SCRIPT, awaitPromise: true, returnByValue: true});
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  const v = r.result.result.value;
  const write = (f, dataUrl) => fs.writeFileSync(path.join(OUT, f), Buffer.from(dataUrl.split(",")[1], "base64"));
  write("after-palettes.png", v.grid); write("before.jpg", v.before);
  console.log(v.stats.join("\n")); console.log("sizes", v.size);
  ws.close();
}
main()
  .catch(e => { console.error("FAILED", e); process.exitCode = 1; })
  .finally(() => {
    chrome.kill(); server.close();
    chrome.once("exit", () => fs.rmSync(profile, {recursive: true, force: true}));
  });
