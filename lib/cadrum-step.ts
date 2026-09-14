import type { StepMeshData, StepQuality } from "@/lib/local-step";

type CadrumWorkerMessage = {
  type: "status" | "ready" | "mesh" | "skipped" | "done" | "error";
  phase?: "reading" | "starting" | "parsing";
  total?: number;
  completed?: number;
  failed?: number;
  name?: string;
  positions?: ArrayBuffer;
  normals?: ArrayBuffer | null;
  indices?: ArrayBuffer;
  indexType?: "uint16" | "uint32";
  message?: string;
};

const OPEN_TIMEOUT = 15 * 60 * 1000;
const PART_TIMEOUT = 5 * 60 * 1000;

function abortError() {
  return new DOMException("已停止极简本地预览", "AbortError");
}

export async function loadCadrumStep(
  file: File,
  quality: StepQuality,
  signal: AbortSignal,
  onMesh: (mesh: StepMeshData) => void,
  onProgress: (status: string, progress: number | null, batchDone?: boolean) => void,
) {
  void quality;
  if (signal.aborted) throw abortError();

  return new Promise<number>((resolve, reject) => {
    const worker = new Worker("/cadrum-step-worker.js?v=12", {
      type: "module",
      name: "cadrum-step-preview",
    });
    let settled = false;
    let total = 0;
    let meshCount = 0;
    let lastProgressAt = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(meshCount);
    };
    const abort = () => finish(abortError());
    const armTimeout = (milliseconds: number, message: string) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => finish(new Error(message)), milliseconds);
    };
    const next = () => {
      if (settled) return;
      if (signal.aborted) {
        abort();
        return;
      }
      armTimeout(PART_TIMEOUT, "当前外观部件处理超时，已停止以免手机持续卡住。");
      try {
        worker.postMessage({ type: "next" });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const reportPartProgress = (completed: number, label: string, force = false) => {
      const now = performance.now();
      const refreshModel = force || completed === total || completed % 25 === 0;
      if (!refreshModel && now - lastProgressAt < 120) return;
      lastProgressAt = now;
      const percent = total > 0 ? Math.min(100, Math.round(completed / total * 100)) : null;
      onProgress(label, percent, refreshModel);
    };

    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error("极简本地预览意外中断，可能超过了手机浏览器可用内存。"));
    };
    worker.onmessageerror = () => {
      finish(new Error("模型数据传递失败，请关闭其他应用后重新打开。"));
    };
    worker.onmessage = ({ data }: MessageEvent<CadrumWorkerMessage>) => {
      if (settled) return;
      try {
        if (data.type === "status") {
          armTimeout(OPEN_TIMEOUT, "模型结构解析超时，已停止以免手机持续卡住。");
          if (data.phase === "reading") onProgress("正在读取 STEP 文件", null);
          else if (data.phase === "starting") onProgress("正在启动极简预览引擎", null);
          else if (data.phase === "parsing") onProgress("正在解析模型结构，大文件需要一些时间", null);
          return;
        }

        if (data.type === "ready") {
          total = data.total ?? 0;
          if (!Number.isSafeInteger(total) || total <= 0) {
            finish(new Error("这个文件没有可显示的三维实体。"));
            return;
          }
          onProgress(`已找到 ${total.toLocaleString()} 个部件，开始显示外观`, 0);
          next();
          return;
        }

        if (data.type === "skipped") {
          const completed = data.completed ?? 0;
          reportPartProgress(completed, `已处理 ${completed.toLocaleString()} / ${total.toLocaleString()} 个部件`);
          armTimeout(PART_TIMEOUT, "当前外观部件处理超时，已停止以免手机持续卡住。");
          return;
        }

        if (data.type === "mesh") {
          if (
            !(data.positions instanceof ArrayBuffer) ||
            !(data.indices instanceof ArrayBuffer) ||
            (data.normals !== null && data.normals !== undefined && !(data.normals instanceof ArrayBuffer)) ||
            (data.indexType !== "uint16" && data.indexType !== "uint32")
          ) {
            throw new Error("极简预览返回了无效的模型数据。");
          }
          onMesh({
            name: data.name || "STEP 外观部件",
            positions: data.positions,
            normals: data.normals ?? null,
            indices: data.indices,
            indexType: data.indexType,
          });
          meshCount += 1;
          const completed = data.completed ?? meshCount;
          reportPartProgress(
            completed,
            `已显示 ${meshCount.toLocaleString()} 个外观部件 · 已处理 ${completed.toLocaleString()} / ${total.toLocaleString()}`,
          );
          next();
          return;
        }

        if (data.type === "done") {
          if (!meshCount) {
            finish(new Error("未生成可显示的模型外观。"));
            return;
          }
          onProgress(`极简预览完成，共显示 ${meshCount.toLocaleString()} 个部件`, 100, true);
          finish();
          return;
        }

        if (data.type === "error") {
          finish(new Error(data.message || "极简本地预览失败。"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    try {
      onProgress("正在准备极简本地预览", null);
      armTimeout(OPEN_TIMEOUT, "极简预览启动超时，请重新打开文件。");
      worker.postMessage({ type: "open", file });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
