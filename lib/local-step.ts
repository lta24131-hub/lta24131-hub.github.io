// Kept for the optional engine module; the viewer has one automatic import path.
export type StepQuality = "standard" | "lite" | "compatibility";
export type StepMeshData = {
  name: string;
  positions: ArrayBuffer;
  normals: ArrayBuffer | null;
  indices: ArrayBuffer;
  indexType: "uint16" | "uint32";
};
type SplitMessage = { type: string; message?: string; buffer: ArrayBuffer; completed: number; total: number };

export async function loadLocalStep(
  file: File,
  signal: AbortSignal,
  onMesh: (mesh: StepMeshData) => void,
  onProgress: (status: string, progress: number | null, batchDone?: boolean) => void,
) {
  const megabytes = file.size / 1024 / 1024;
  const params = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: megabytes > 30 ? 0.003 : 0.0015, angularDeflection: 0.5 };
  const cancelled = () => new DOMException("已停止本地读取", "AbortError");
  let totalMeshes = 0;
  let parser: Worker | null = null;
  let parserBatches = 0;
  let splitter: Worker | null = null;
  let cancelPreparation: (() => void) | null = null;

  // Reuse the compiled kernel for eight bounded batches, then release its WASM
  // heap. One parser and at most one prepared input can exist at any time.
  const parse = (buffer?: ArrayBuffer) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    if (!parser) { parser = new Worker("/step-worker.js?v=14"); parserBatches = 0; }
    const worker = parser;
    let settled = false;
    const finish = (error?: Error, heapBytes = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error || !buffer || ++parserBatches >= 8 || heapBytes >= 96 * 1024 * 1024) { worker.terminate(); parser = null; }
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(cancelled());
    const timeout = setTimeout(() => finish(new Error("当前曲面读取超时，已保留读出的部分。")), buffer ? 120000 : 900000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled) return;
      try {
        if (data.type === "mesh") { onMesh(data); totalMeshes++; }
        if (data.type === "done") finish(undefined, data.heapBytes);
        if (data.type === "error") finish(new Error(data.message));
        if (!buffer && data.type === "status") onProgress(data.phase === "parsing" ? "正在读取模型" : "正在启动 STEP 解析器", null);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    worker.onerror = (event) => { event.preventDefault(); finish(new Error("本地解析意外中断，可能超过设备可用内存；已读出的部分会保留。")); };
    worker.onmessageerror = () => finish(new Error("模型数据传递失败，请重新打开。"));
    try {
      worker.postMessage({ type: "parse", ...(buffer ? { buffer } : { file }), params, mergeMeshes: Boolean(buffer) }, buffer ? [buffer] : []);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });

  const request = (message: object, milliseconds: number) => new Promise<SplitMessage>((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const worker = splitter!;
    let settled = false;
    const finish = (error?: Error, data?: SplitMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      cancelPreparation = null;
      if (error) reject(error); else resolve(data!);
    };
    const abort = () => finish(cancelled());
    cancelPreparation = abort;
    const timer = setTimeout(() => finish(new Error("曲面准备超时，已保留读出的部分。")), milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => finish(data.type === "error" ? new Error(data.message) : undefined, data);
    worker.onerror = (event) => { event.preventDefault(); finish(new Error("分批读取中断；已读出的部分会保留。")); };
    worker.onmessageerror = () => finish(new Error("曲面数据传递失败。"));
    try { worker.postMessage(message); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });

  try {
    if (megabytes < 12) {
      await parse();
    } else {
      onProgress("正在建立曲面索引", null);
      splitter = new Worker("/step-split-worker.js?v=14");
      const indexed = await request({ type: "index", file }, 120000);
      if (indexed.type === "fallback") {
        splitter.terminate(); splitter = null;
        onProgress("正在读取此 STEP 的其他表示方式", null);
        await parse();
      } else {
        if (indexed.type !== "indexed") throw new Error("曲面索引响应无效。");
        onProgress(`已索引 ${indexed.total.toLocaleString()} 个曲面，开始分批显示`, 0);
        let batch = await request({ type: "next" }, 60000);
        while (batch.type === "batch") {
          // Exactly one prepared batch, alongside the active parse. Capture errors
          // immediately so cancellation never leaves an unhandled promise.
          const next = request({ type: "next" }, 60000).then(data => ({ data, error: null }), error => ({ data: null, error }));
          await parse(batch.buffer);
          if (signal.aborted) throw cancelled();
          onProgress(`已读取 ${batch.completed.toLocaleString()} / ${batch.total.toLocaleString()} 个曲面`, Math.round(batch.completed / batch.total * 100), true);
          const prepared = await next;
          if (prepared.error) throw prepared.error;
          batch = prepared.data!;
        }
        if (batch.type !== "done") throw new Error("曲面读取未正常结束。");
      }
    }
    if (!totalMeshes) throw new Error("未生成可显示的模型曲面。");
    return totalMeshes;
  } finally {
    (cancelPreparation as (() => void) | null)?.();
    (parser as Worker | null)?.terminate();
    splitter?.terminate();
  }
}
