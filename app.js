// SpriteCam page logic: controls, loading, rendering through the worker, display, save and share,
// and the live camera (camera.js). The image processing itself is in pipeline.js.
(() => {
"use strict";
const $ = id => document.getElementById(id);
const screen = $("screen");
const PP = PixelPipeline;

// Settings the user can change, and the ones fixed by design
const SIZES = [144, 160, 192, 224, 256, 320];
const LCD_MODES = [{id: "off", name: "Off"}, {id: "light", name: "Light", gap: 0.85}, {id: "dark", name: "Dark", gap: 0.12}];
const DITHER_AMOUNT = 90;           // ordered dithering strength, fixed by design
const EXPORT_LCD_CELL = 4;          // saved PNG: every pixel is a 4x4 LCD cell
const EXPORT_MIN_WIDTH = 1024;      // saved PNG without LCD: upscaled to at least this width
const MAX_SOURCE = 1600;            // photos and camera shots are capped to this on their long side
const state = {palette: "gameboy", size: 160, lcd: "light", autoContrast: true};

let src = null;                        // canvas holding the (capped) source photo
let photoId = 0;                       // bumped per photo so late results for an old photo are dropped
let srcCache = {key: "", data: null};  // resized source pixels, reused while only colours change
let art = null;                        // last result: {rgba, width, height, swatches}
let artSerial = 0;                     // bumped per result so the display knows when to redraw
let pending = false, busy = false, dirty = false, errorShown = false;
let live = null;                       // open camera, see "Live camera": {cam, facing, seed, busy, frames, fpsFrom, bursting}

// ---------- Controls ----------
function segButton(label, pressed, onClick){
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; b.setAttribute("aria-pressed", String(pressed));
  b.addEventListener("click", onClick);
  return b;
}
function pressOnly(container, button){
  container.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
}
function buildPalettes(){
  const box = $("palettes");
  PP.PALETTES.forEach(p => {
    const chips = document.createElement("span");
    chips.className = "chips" + (p.colors ? "" : " photo");
    (p.colors || []).forEach(c => { const s = document.createElement("span"); s.style.background = c; chips.append(s); });
    const name = document.createElement("span"); name.textContent = p.name;
    const b = segButton("", p.id === state.palette, () => { state.palette = p.id; pressOnly(box, b); schedule(); });
    b.dataset.palette = p.id; b.replaceChildren(chips, name);
    box.append(b);
  });
}
function buildSizes(){
  const box = $("sizes");
  SIZES.forEach(s => {
    const b = segButton(String(s), s === state.size, () => { state.size = s; pressOnly(box, b); schedule(); });
    b.dataset.size = s; box.append(b);
  });
}
function buildLcd(){
  const box = $("lcd");
  LCD_MODES.forEach(m => {
    const b = segButton(m.name, m.id === state.lcd, () => { state.lcd = m.id; pressOnly(box, b); showArt(); prepareExport(); });
    b.dataset.lcd = m.id; box.append(b);
  });
}
buildPalettes(); buildSizes(); buildLcd();
$("autoContrast").addEventListener("change", e => { state.autoContrast = e.target.checked; schedule(); });

// ---------- Loading ----------
function setMsg(t){ $("msg").textContent = t || ""; errorShown = false; }
function setError(t){ setMsg(t); errorShown = true; }
async function decodeImage(file){
  try {
    return await createImageBitmap(file, {imageOrientation:"from-image"});
  } catch (e) {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
async function loadFile(file){
  if (!file) return;
  setMsg("Reading photo…");
  let img;
  try {
    img = await decodeImage(file);
  } catch (e) {
    setError("That file couldn't be read as an image. Try a JPEG or PNG.");
    return;
  }
  useSource(img);
  setMsg("");
}
// Makes `img` (an image, bitmap or canvas) the current photo, capped to MAX_SOURCE on its long side.
// Burst shots pass keepStrip so picking one doesn't clear the filmstrip.
function useSource(img, {keepStrip = false} = {}){
  if (live) stopLive();
  if (!keepStrip) clearFilmstrip();
  const sw = img.width, sh = img.height, s = Math.min(1, MAX_SOURCE / Math.max(sw, sh));
  src = document.createElement("canvas");
  src.width = Math.max(1, Math.round(sw * s)); src.height = Math.max(1, Math.round(sh * s));
  const x = src.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, src.width, src.height);
  photoId++; srcCache = {key: "", data: null};
  const o = $("orig"); o.width = src.width; o.height = src.height; o.getContext("2d").drawImage(src, 0, 0);
  $("empty").hidden = true; screen.classList.add("loaded"); $("out").hidden = false; $("compare").disabled = false;
  schedule();
}
$("camIn").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });
$("fileIn").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });
screen.addEventListener("dragover", e => { e.preventDefault(); screen.classList.add("drag"); });
screen.addEventListener("dragleave", () => screen.classList.remove("drag"));
screen.addEventListener("drop", e => { e.preventDefault(); screen.classList.remove("drag"); loadFile(e.dataTransfer.files[0]); });

$("compare").addEventListener("click", () => {
  const on = !screen.classList.contains("comparing");
  screen.classList.toggle("comparing", on);
  $("compare").setAttribute("aria-pressed", String(on));
  $("compare").textContent = on ? "Show pixel art" : "Show original";
});

// ---------- Background processing (Web Worker, main-thread fallback) ----------
let worker = null, jobSeq = 0;
const waiting = new Map();
function runLocal(job){
  return new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(PP.process(job.data, job.width, job.height, job.params)); } catch (e) { reject(e); }
  }, 0));
}
function dropWorker(){
  if (worker) worker.terminate();
  worker = null;
  const stuck = [...waiting.values()]; waiting.clear();
  stuck.forEach(({job, resolve, reject}) => runLocal(job).then(resolve, reject));
}
try {
  worker = new Worker("worker.js");
  worker.onmessage = e => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.result);
  };
  worker.onerror = e => { e.preventDefault(); dropWorker(); };
} catch (e) {
  worker = null; // Workers are blocked for file:// pages in some browsers; render on the main thread instead.
}
function runJob(job){
  if (!worker) return runLocal(job);
  return new Promise((resolve, reject) => { waiting.set(job.id, {job, resolve, reject}); worker.postMessage(job); });
}

// ---------- Rendering ----------
// One render in flight at a time; changes made meanwhile trigger one follow-up render with the latest settings.
function schedule(){
  if (!src || live) return;
  if (busy) { dirty = true; return; }
  if (pending) return;
  pending = true;
  setTimeout(() => requestAnimationFrame(() => { pending = false; render(); }), 30);
}
function resizeTo(source, w, h){
  let cur = source, cw = source.width, ch = source.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const c = document.createElement("canvas");
    c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d", {willReadFrequently:true}); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, w, h);
  return x.getImageData(0, 0, w, h).data;
}
function sourcePixels(w, h){
  const key = w + "x" + h;
  if (srcCache.key !== key) srcCache = {key, data: resizeTo(src, w, h)};
  return srcCache.data;
}
function pipelineParams(){
  const p = PP.PALETTES.find(x => x.id === state.palette);
  return {palette: p.id, colors: 4, boost: p.boost || 0, ditherAmt: DITHER_AMOUNT, autoContrast: state.autoContrast};
}
function render(){
  const t0 = performance.now(), forPhoto = photoId, params = pipelineParams();
  const [W, H] = PP.outputSize(src.width, src.height, state.size);
  const job = {id: ++jobSeq, data: sourcePixels(W, H), width: W, height: H, params};
  busy = true; dirty = false;
  runJob(job)
    .then(result => { if (forPhoto === photoId) show(result, performance.now() - t0); })
    .catch(() => setError("Something went wrong while processing this photo. Try other settings or another photo."))
    .finally(() => { busy = false; if (dirty) schedule(); });
}
function show(result, ms){
  art = result; artSerial++;
  showArt();
  drawSwatches(art.swatches);
  $("stat").textContent = `${art.width} × ${art.height} px, ${art.swatches.length} colors, ${Math.round(ms)} ms`;
  $("save").disabled = false; $("share").disabled = false;
  if (errorShown) setMsg("");
  prepareExport();
  refreshThumbs();
}
let swatchKey = "";
function drawSwatches(swatches){
  const key = swatches.join("|");
  if (key === swatchKey) return;
  swatchKey = key;
  $("swatches").replaceChildren(...swatches.map(c => { const s = document.createElement("span"); s.style.background = `rgb(${c[0]},${c[1]},${c[2]})`; return s; }));
}
// Back to the "Take or choose a photo" screen (camera closed before any photo was taken).
function resetScreen(){
  art = null; artSerial++; drawSwatches([]);
  $("out").hidden = true; $("empty").hidden = false; screen.classList.remove("loaded");
  $("stat").textContent = "No photo yet";
  $("compare").disabled = true; $("save").disabled = true; $("share").disabled = true;
}

// ---------- Display ----------
// Each art pixel covers a whole number of *device* pixels (the "cell"), so pixels stay square on any
// screen. The LCD grid is drawn at that cell size (it needs at least 3 device pixels per art pixel).
// Only when even 1:1 doesn't fit is the image shrunk, smoothly.
// The LCD grid is drawn by the GPU, which keeps the live camera fast: the art is scaled up with crisp
// pixels, then a grid of black lines at (1 - gap) opacity darkens the gaps to "pixel colour x gap",
// the same result as PP.lcd (still used for the saved PNG).
let shown = "";
const artCanvas = document.createElement("canvas");
let gridCache = {key: "", pattern: null};
function lcdGrid(ctx, cell, gapStrength){
  const key = cell + ":" + gapStrength;
  if (gridCache.key !== key) {
    const gap = Math.max(1, Math.floor(cell / 4)), solid = cell - gap, t = document.createElement("canvas");
    t.width = t.height = cell;
    const x = t.getContext("2d");
    x.fillStyle = `rgba(0,0,0,${1 - gapStrength})`;
    x.fillRect(solid, 0, gap, cell); x.fillRect(0, solid, solid, gap); // right column and bottom row, no overlap
    gridCache = {key, pattern: ctx.createPattern(t, "repeat")};
  }
  return gridCache.pattern;
}
function showArt(){
  if (!art) return;
  const dpr = window.devicePixelRatio || 1;
  const availW = (screen.clientWidth - 16) * dpr, availH = Math.max(240, window.innerHeight * 0.8) * dpr;
  const room = Math.min(availW / art.width, availH / art.height), cell = Math.max(1, Math.floor(room));
  const mode = LCD_MODES.find(m => m.id === state.lcd), useLcd = mode.gap !== undefined && cell >= 3;
  const key = [artSerial, useLcd ? cell : 0, state.lcd].join(";");
  const out = $("out");
  if (key !== shown) {
    const pixels = new ImageData(new Uint8ClampedArray(art.rgba), art.width, art.height);
    if (useLcd) {
      artCanvas.width = art.width; artCanvas.height = art.height;
      artCanvas.getContext("2d").putImageData(pixels, 0, 0);
      out.width = art.width * cell; out.height = art.height * cell;
      const ctx = out.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(artCanvas, 0, 0, out.width, out.height);
      ctx.fillStyle = lcdGrid(ctx, cell, mode.gap);
      ctx.fillRect(0, 0, out.width, out.height);
    } else {
      out.width = art.width; out.height = art.height;
      out.getContext("2d").putImageData(pixels, 0, 0);
    }
    shown = key;
  }
  const scale = room >= 1 ? cell : room, cw = art.width * scale / dpr + "px", ch = art.height * scale / dpr + "px";
  out.classList.toggle("shrunk", room < 1);
  out.style.width = cw; out.style.height = ch;
  $("orig").style.width = cw; $("orig").style.height = ch;
}
new ResizeObserver(showArt).observe(screen);
window.addEventListener("resize", showArt);

// ---------- Live camera ----------
// Camera frames go through the same worker as photos. One frame is in flight at a time, so a slow phone
// just gets fewer frames per second. With "From the photo", each frame starts k-means from the previous
// frame's colours: cheaper, and the palette doesn't flicker. A shot grabs the full camera frame and
// then behaves exactly like a chosen photo (palette changes, save, share).
const Cam = SpriteCamCamera;
const BURST_SHOTS = 5, BURST_COUNTDOWN = 5, BURST_GAP_MS = 1000;
const THUMB_SHORT = 32;             // filmstrip thumbnails: pixels on the short side, shown at 2x
let strip = [];                     // burst shots: [{canvas, small, button, thumb}]
let thumbsKey = "";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cameraError(e){
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access is blocked. Allow it in your browser's site settings, or use Choose photo.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found. Use Choose photo instead.";
  if (name === "NotReadableError") return "The camera is busy in another app. Close that app and try again.";
  return "The camera couldn't start. Try again, or use Choose photo.";
}
function setLiveUi(on){
  const wasFocused = document.activeElement && document.activeElement.closest(".actions");
  $("stillActions").hidden = on; $("liveActions").hidden = !on; $("badge").hidden = !on;
  $("badge").textContent = "Live"; $("countdown").hidden = true;
  ["shoot", "burst", "flip"].forEach(id => { $(id).disabled = false; });
  $("closeCam").textContent = "Close camera";
  if (wasFocused) (on ? $("shoot") : $("takePhoto")).focus({preventScroll: true}); // the focused button was just hidden
}
let starting = false;
async function startLive(facing){
  if (starting || live) return false;
  starting = true; $("takePhoto").disabled = true;
  setMsg("Starting the camera…");
  let cam;
  try {
    cam = await Cam.open($("feed"), facing);
  } catch (e) {
    setError(cameraError(e));
    return false;
  } finally {
    starting = false; $("takePhoto").disabled = false;
  }
  if (document.hidden) { cam.close(); setMsg(""); return false; } // the page was left while the camera started
  photoId++; // drop any photo render still in flight
  live = {cam, facing, seed: null, busy: false, frames: 0, fpsFrom: performance.now(), bursting: false};
  screen.classList.remove("comparing"); $("compare").setAttribute("aria-pressed", "false"); $("compare").textContent = "Show original";
  $("empty").hidden = true; screen.classList.add("loaded");
  setLiveUi(true); setMsg("");
  const L = live;
  requestAnimationFrame(() => liveTick(L));
  const count = await Cam.cameraCount();
  if (live && live.cam === cam) $("flip").hidden = count < 2;
  return true;
}
// Each camera session runs its own loop, which ends as soon as that session is closed.
function liveTick(L){
  if (live !== L) return;
  if (!L.busy && L.cam.width) {
    const [W, H] = PP.outputSize(L.cam.width, L.cam.height, state.size), params = pipelineParams();
    if (params.palette === "photo" && L.seed) params.seed = L.seed;
    L.busy = true;
    runJob({id: ++jobSeq, data: L.cam.grab(W, H), width: W, height: H, params})
      .then(r => { if (live === L) { L.seed = params.palette === "photo" ? r.swatches : null; showLiveFrame(L, r); } })
      .catch(() => { if (live === L) setError("Something went wrong with the live preview."); })
      .finally(() => { L.busy = false; });
  }
  requestAnimationFrame(() => liveTick(L));
}
function showLiveFrame(L, r){
  art = r; artSerial++;
  $("out").hidden = false;
  showArt(); drawSwatches(r.swatches);
  L.frames++;
  const now = performance.now();
  if (now - L.fpsFrom >= 500) {
    $("stat").textContent = `${r.width} × ${r.height} px, ${Math.round(L.frames * 1000 / (now - L.fpsFrom))} fps`;
    L.frames = 0; L.fpsFrom = now;
  }
}
function stopLive(){
  if (!live) return;
  live.cam.close(); live = null;
  setLiveUi(false);
}
function closeCamera(){
  stopLive();
  if (src) schedule(); else resetScreen();
}
function flash(){
  const f = $("flash");
  f.classList.remove("on"); void f.offsetWidth; f.classList.add("on");
}
function shoot(){
  if (!live || live.bursting) return;
  const still = live.cam.still(MAX_SOURCE);
  flash();
  useSource(still);
}
async function flip(){
  if (!live || live.bursting) return;
  const next = live.facing === "user" ? "environment" : "user";
  live.cam.close(); live = null;
  if (!(await startLive(next))) { setLiveUi(false); if (src) schedule(); else resetScreen(); }
}
// Burst: a 5-second countdown, then 5 shots one second apart, each with a flash. Closing the camera
// (or leaving the page) at any point cancels it.
async function burst(){
  const L = live;
  if (!L || L.bursting) return;
  L.bursting = true;
  ["shoot", "burst", "flip"].forEach(id => { $(id).disabled = true; });
  $("closeCam").textContent = "Cancel";
  const cd = $("countdown");
  for (let n = BURST_COUNTDOWN; n > 0; n--) {
    cd.textContent = n; cd.hidden = false;
    await sleep(1000);
    if (live !== L) return;
  }
  cd.hidden = true;
  const shots = [];
  for (let i = 0; i < BURST_SHOTS; i++) {
    shots.push(L.cam.still(MAX_SOURCE)); flash();
    $("badge").textContent = `${i + 1}/${BURST_SHOTS}`;
    if (i < BURST_SHOTS - 1) { await sleep(BURST_GAP_MS); if (live !== L) return; }
  }
  stopLive();
  showFilmstrip(shots);
}

// Filmstrip of burst shots: tap one to make it the current photo.
function showFilmstrip(shots){
  const box = $("filmstrip");
  strip = shots.map((canvas, i) => {
    const button = document.createElement("button"), thumb = document.createElement("canvas");
    button.type = "button"; button.setAttribute("aria-label", `Shot ${i + 1}`); button.setAttribute("aria-pressed", "false");
    button.append(thumb);
    button.addEventListener("click", () => selectShot(i));
    return {canvas, small: null, button, thumb};
  });
  box.replaceChildren(...strip.map(s => s.button));
  box.hidden = false; thumbsKey = "";
  selectShot(0);
}
function selectShot(i){
  pressOnly($("filmstrip"), strip[i].button);
  useSource(strip[i].canvas, {keepStrip: true});
}
function clearFilmstrip(){
  strip = []; thumbsKey = "";
  $("filmstrip").replaceChildren(); $("filmstrip").hidden = true;
}
// Thumbnails show the current palette; they are redrawn (on this thread, they are tiny) when it changes.
function refreshThumbs(){
  if (!strip.length) return;
  const params = pipelineParams(), key = JSON.stringify(params);
  if (key === thumbsKey) return;
  thumbsKey = key;
  strip.forEach(s => {
    const [w, h] = PP.outputSize(s.canvas.width, s.canvas.height, THUMB_SHORT);
    s.small = s.small || resizeTo(s.canvas, w, h);
    const r = PP.process(s.small, w, h, params);
    s.thumb.width = w; s.thumb.height = h;
    s.thumb.style.width = w * 2 + "px"; s.thumb.style.height = h * 2 + "px";
    s.thumb.getContext("2d").putImageData(new ImageData(r.rgba, w, h), 0, 0);
  });
}

// Take photo opens the live viewfinder. Where streaming isn't possible (no camera API, or an in-app
// browser that breaks it) it falls back to the phone's own camera through the file input.
$("takePhoto").addEventListener("click", () => {
  if (!Cam.supported() || Cam.inAppBrowser()) {
    if (Cam.inAppBrowser()) setMsg("The live camera doesn't work inside this app. Open SpriteCam in your browser to use it.");
    $("camIn").click();
    return;
  }
  startLive("environment");
});
$("shoot").addEventListener("click", shoot);
$("burst").addEventListener("click", burst);
$("flip").addEventListener("click", flip);
$("closeCam").addEventListener("click", closeCamera);
// Never leave the camera running in the background.
document.addEventListener("visibilitychange", () => { if (document.hidden && live) closeCamera(); });

// ---------- Save and share ----------
// The PNG is encoded shortly after each change so Share can open the share sheet
// straight from the tap (Safari refuses navigator.share after a slow await).
let exportJob = null, exportTimer = 0;
function prepareExport(){
  exportJob = null; clearTimeout(exportTimer);
  exportTimer = setTimeout(makeExport, 400);
}
function exportCanvas(){
  const mode = LCD_MODES.find(m => m.id === state.lcd), c = document.createElement("canvas");
  if (mode.gap !== undefined) {
    const img = PP.lcd(art.rgba, art.width, art.height, EXPORT_LCD_CELL, mode.gap);
    c.width = img.width; c.height = img.height;
    c.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
    return c;
  }
  const base = document.createElement("canvas"); base.width = art.width; base.height = art.height;
  base.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(art.rgba), art.width, art.height), 0, 0);
  const s = Math.max(1, Math.ceil(EXPORT_MIN_WIDTH / art.width));
  c.width = art.width * s; c.height = art.height * s;
  const x = c.getContext("2d"); x.imageSmoothingEnabled = false; x.drawImage(base, 0, 0, c.width, c.height);
  return c;
}
function makeExport(){
  if (exportJob) return exportJob;
  const c = exportCanvas(), job = {w: c.width, h: c.height, ready: null};
  job.blob = new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("PNG encoding failed")), "image/png"))
    .then(b => { job.ready = b; return b; });
  exportJob = job;
  return job;
}
function fileName(){ return "spritecam-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png"; }

$("save").addEventListener("click", async () => {
  if (!art) return;
  const job = makeExport();
  try {
    const url = URL.createObjectURL(await job.blob), a = document.createElement("a");
    a.href = url; a.download = fileName(); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setMsg(`Saving a ${job.w} × ${job.h} px PNG.`);
  } catch (e) {
    setError("Couldn't create the PNG. Please try again.");
  }
});

const canShareFiles = (() => {
  try { return !!(navigator.canShare && navigator.canShare({files: [new File([""], "x.png", {type: "image/png"})]})); }
  catch (e) { return false; }
})();
$("share").hidden = !canShareFiles;
$("share").addEventListener("click", async () => {
  if (!art) return;
  const job = makeExport();
  try {
    const blob = job.ready || await job.blob;
    await navigator.share({files: [new File([blob], fileName(), {type: "image/png"})]});
  } catch (e) {
    if (e && e.name === "AbortError") return; // share sheet closed by the user
    setError(e && e.name === "NotAllowedError" ? "Tap Share again to open the share sheet." : "Sharing isn't available here. Use Save PNG instead.");
  }
});
})();
