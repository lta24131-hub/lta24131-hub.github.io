/* global importScripts, StepPartition */
importScripts("/step-partition.js?v=14");
let partition;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "index") {
      partition = new StepPartition(await data.file.text());
      if (!partition.supported) { self.postMessage({ type: "fallback" }); return; }
      self.postMessage({ type: "indexed", total: partition.faceIds.length });
    } else if (data.type === "next") {
      const batch = partition.next();
      if (!batch) { self.postMessage({ type: "done" }); return; }
      self.postMessage({ type: "batch", ...batch }, [batch.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
