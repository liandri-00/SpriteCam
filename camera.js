// SpriteCam live camera: opens the camera stream and grabs frames from it. Knows nothing about the
// pipeline or the page layout; app.js drives it.
(function (root) {
"use strict";

// In-app browsers (Instagram, Facebook, LinkedIn…) often block or break camera streaming.
const IN_APP = /Instagram|FBAN|FBAV|FB_IAB|LinkedInApp|Line\/|Twitter|TikTok|musical_ly|Snapchat/i;

function inAppBrowser(){ return IN_APP.test(navigator.userAgent || ""); }
function supported(){ return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false; }

async function cameraCount(){
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput").length;
  } catch (e) {
    return 1;
  }
}

// Opens the camera facing `facing` ("environment" or "user") and resolves once frames are flowing.
// The <video> must stay in the DOM (iOS stops updating hidden or detached videos), so the caller
// passes one it has placed on the page.
async function open(video, facing){
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {facingMode: {ideal: facing}, width: {ideal: 1280}, height: {ideal: 960}}
  });
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth) await new Promise(res => video.addEventListener("loadedmetadata", res, {once: true}));
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    throw e;
  }
  // The front camera is shown mirrored, like a mirror or any selfie camera, and shots keep what was on screen.
  const settings = stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
  const mirrored = (settings.facingMode || facing) === "user";
  const grabCanvas = document.createElement("canvas");
  const grabCtx = grabCanvas.getContext("2d", {willReadFrequently: true});

  function draw(ctx, w, h){
    ctx.save();
    if (mirrored) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
  }
  return {
    video, mirrored,
    get width(){ return video.videoWidth; },
    get height(){ return video.videoHeight; },
    // Current frame scaled straight to w x h, as RGBA. Cheap enough to call every frame.
    grab(w, h){
      if (grabCanvas.width !== w || grabCanvas.height !== h) { grabCanvas.width = w; grabCanvas.height = h; }
      grabCtx.imageSmoothingQuality = "high";
      draw(grabCtx, w, h);
      return grabCtx.getImageData(0, 0, w, h).data;
    },
    // Current frame at full size (capped to `maxSide`) on a new canvas, for a shot.
    still(maxSide){
      const s = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(video.videoWidth * s)); c.height = Math.max(1, Math.round(video.videoHeight * s));
      const x = c.getContext("2d"); x.imageSmoothingQuality = "high";
      draw(x, c.width, c.height);
      return c;
    },
    close(){
      stream.getTracks().forEach(t => t.stop());
      video.pause(); video.srcObject = null;
    }
  };
}

root.SpriteCamCamera = {inAppBrowser, supported, cameraCount, open};
})(self);
