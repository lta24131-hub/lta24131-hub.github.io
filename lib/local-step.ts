export type StepQuality = "standard" | "lite" | "compatibility";
export type StepMeshData = {
  name: string;
  positions: ArrayBuffer;
  normals: ArrayBuffer | null;
  indices: ArrayBuffer;
  indexType: "uint16" | "uint32";
};

export async function loadLocalStep(
  file: File,
  quality: StepQuality,
  signal: AbortSignal,
  onMesh: (mesh: StepMeshData) => void,
  onProgress: (status: string, progress: number | null, batchDone?: boolean) => void,
) {
  const megabytes = file.size / 1024 / 1024;
  const precision = quality === "lite"
    ? { linearDeflection: megabytes > 120 ? 0.01 : megabytes > 60 ? 0.006 : 0.004, angularDeflection: 0.75 }
    : { linearDeflection: megabytes > 30 ? 0.003 : 0.0015, angularDeflection: 0.5 };
  const params = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", ...precision };
  const cancelled = () => new DOMException("已停止本地读取", "AbortError");
  let totalMeshes = 0;

  // A fresh parser worker per batch releases the entire WASM heap, including
  // allocator high-water marks. Never queue multiple input batches in memory.
  const parse = (buffer?: ArrayBuffer) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const worker = new Worker("/step-worker.js?v=11");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(cancelled());
    const timeout = setTimeout(() => finish(new Error("当前曲面读取超时，已保留读出的部分；可以改用极简预览。")), buffer ? 120000 : 900000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled) return;
      try {
        if (data.type === "mesh") { onMesh(data); totalMeshes++; }
        if (data.type === "done") finish();
        if (data.type === "error") finish(new Error(data.message));
        if (!buffer && data.type === "status") onProgress(data.phase === "parsing" ? "正在读取完整模型" : "正在启动 STEP 解析器", null);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    worker.onerror = (event) => { event.preventDefault(); finish(new Error("本地解析意外中断，可能超过设备可用内存；已读出的部分会保留。")); };
    worker.onmessageerror = () => finish(new Error("模型数据传递失败，请重新打开。"));
    try {
      worker.postMessage({ type: "parse", ...(buffer ? { buffer } : { file }), params, mergeMeshes: Boolean(buffer) }, buffer ? [buffer] : []);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });

  if (megabytes < 12 || quality === "compatibility") {
    await parse();
    return totalMeshes;
  }
  onProgress("正在建立曲面索引", null);
  const splitter = new Worker("/step-split-worker.js?v=11");
  try {
    const supported = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, result = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(cancelled());
      const next = () => {
        if (signal.aborted) { abort(); return; }
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("曲面分批准备超时，请尝试整文件兼容读取。")), 60000);
        splitter.postMessage({ type: "next" });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      timer = setTimeout(() => finish(new Error("曲面索引准备超时，请尝试整文件兼容读取。")), 120000);
      splitter.onerror = (event) => { event.preventDefault(); finish(new Error("分批读取中断；已读出的部分会保留。")); };
      splitter.onmessageerror = () => finish(new Error("曲面数据传递失败。"));
      splitter.onmessage = async ({ data }) => {
        if (settled) return;
        clearTimeout(timer);
        try {
          if (data.type === "fallback") { finish(undefined, false); return; }
          if (data.type === "error") { finish(new Error(data.message)); return; }
          if (data.type === "done") { finish(); return; }
          if (data.type === "indexed") {
            onProgress(`已索引 ${data.total.toLocaleString()} 个曲面，开始分批显示`, 0);
            next();
          }
          if (data.type === "batch") {
            await parse(data.buffer);
            if (settled || signal.aborted) return;
            const percent = Math.round(data.completed / data.total * 100);
            onProgress(`已读取 ${data.completed.toLocaleString()} / ${data.total.toLocaleString()} 个曲面`, percent, true);
            // Give the renderer and terminated worker a turn before allocating again.
            await new Promise(done => setTimeout(done, 16));
            if (!settled) next();
          }
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      splitter.postMessage({ type: "index", file });
    });
    splitter.terminate();
    if (!supported) {
      onProgress("此 STEP 使用其他表示方式，切换为整文件读取", null);
      await parse();
    }
  } finally { splitter.terminate(); }
  if (!totalMeshes) throw new Error("未生成可显示的模型曲面。");
  return totalMeshes;
}
