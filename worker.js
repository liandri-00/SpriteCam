// Runs the pixel pipeline off the main thread so the page stays responsive.
importScripts("pipeline.js");

self.onmessage = e => {
  const {id, data, width, height, params} = e.data;
  try {
    const result = PixelPipeline.process(data, width, height, params);
    self.postMessage({id, result}, [result.rgba.buffer]);
  } catch (err) {
    self.postMessage({id, error: String(err && err.message || err)});
  }
};
