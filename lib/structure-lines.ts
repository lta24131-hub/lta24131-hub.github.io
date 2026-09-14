import * as THREE from "three";

export async function buildStructureLines(model: THREE.Group, signal: AbortSignal, progress: (percent: number) => void) {
  const aborted = () => new DOMException("已停止结构线计算", "AbortError");
  if (signal.aborted) throw aborted();
  model.updateMatrixWorld(true);
  const inverse = model.matrixWorld.clone().invert();
  const meshes: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; count: number }[] = [];
  const bounds = new THREE.Box3();
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return;
    const geometry = object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const matrix = inverse.clone().multiply(object.matrixWorld);
    bounds.union(geometry.boundingBox!.clone().applyMatrix4(matrix));
    meshes.push({ geometry, matrix, count: geometry.index?.count ?? geometry.getAttribute("position").count });
  });
  const triangles = meshes.reduce((sum, mesh) => sum + Math.floor(mesh.count / 3), 0);
  if (!triangles || bounds.isEmpty()) throw new Error("模型没有可整理的结构线。");
  const size = bounds.getSize(new THREE.Vector3());
  const worker = new Worker("/structure-worker.js?v=15");
  type Reply = { type: string; message?: string; buffer?: ArrayBuffer };
  const request = (message: object, transfer: Transferable[] = []) => new Promise<Reply>((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const finish = (error?: Error, data?: Reply) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error) reject(error); else resolve(data!);
    };
    const abort = () => finish(aborted());
    const timer = setTimeout(() => finish(new Error("结构线计算超时，实体模型不受影响。")), 60000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => finish(data.type === "error" ? new Error(data.message) : undefined, data);
    worker.onerror = event => { event.preventDefault(); finish(new Error("结构线计算中断，实体模型不受影响。")); };
    worker.onmessageerror = () => finish(new Error("结构线数据传递失败。"));
    try { worker.postMessage(message, transfer); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
  try {
    await request({ type: "init", triangles, tolerance: Math.max(size.x, size.y, size.z) * 1e-7, origin: bounds.min.toArray() });
    const point = new THREE.Vector3();
    let completed = 0, lastProgress = -1;
    for (const { geometry, matrix, count } of meshes) {
      const source = geometry.getAttribute("position"), index = geometry.index;
      // Transfer only one small copy; the original render buffers stay on the GPU.
      for (let first = 0; first < count; first += 36000) {
        if (signal.aborted) throw aborted();
        const end = Math.min(first + 36000, count), positions = new Float32Array((end - first) * 3);
        for (let i = first; i < end; i++) {
          point.fromBufferAttribute(source, index ? index.getX(i) : i).applyMatrix4(matrix);
          point.toArray(positions, (i - first) * 3);
        }
        await request({ type: "chunk", buffer: positions.buffer }, [positions.buffer]);
        completed += (end - first) / 3;
        const percent = Math.min(99, Math.floor(completed / triangles * 100));
        if (percent !== lastProgress) { progress(percent); lastProgress = percent; }
      }
    }
    const result = await request({ type: "finish" });
    if (result.type !== "done" || !result.buffer) throw new Error("未收到结构线结果。");
    return new Float32Array(result.buffer);
  } finally { worker.terminate(); }
}
