/* global importScripts, occtimportjs */

importScripts("/occt/occt-import-js.js");

function sendError(error) {
  const message = error instanceof Error ? error.message : String(error || "STEP 文件读取失败。");
  self.postMessage({ type: "error", message });
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "parse") return;

  try {
    self.postMessage({ type: "status", phase: "reading" });
    let buffer = event.data.buffer instanceof ArrayBuffer ? event.data.buffer : await event.data.file.arrayBuffer();
    let content = new Uint8Array(buffer);

    self.postMessage({ type: "status", phase: "starting" });
    const occt = await occtimportjs({
      locateFile: (path) => path.endsWith(".wasm") ? "/occt/occt-import-js.wasm" : `/occt/${path}`,
    });

    self.postMessage({ type: "status", phase: "parsing" });
    const result = occt.ReadStepFile(content, event.data.params ?? null);
    content = null;
    buffer = null;

    if (!result.success || !result.meshes?.length) {
      throw new Error("这个文件没有可显示的三维实体。");
    }

    const meshes = result.meshes.filter((source) => (
      source?.attributes?.position?.array?.length >= 9 &&
      source?.index?.array?.length >= 3
    ));
    result.root = null;
    result.meshes = null;

    if (!meshes.length) {
      throw new Error("当前数据没有生成可显示的外观网格；请尝试分批本地打开或整文件兼容读取。");
    }

    const total = meshes.length;
    self.postMessage({ type: "start", total });

    // All positions already include OCCT's assembly placements. Packing a batch
    // avoids thousands of draw calls on mobile without changing any coordinates.
    if (event.data.mergeMeshes && total) {
      const vertexValues = meshes.reduce((sum, mesh) => sum + mesh.attributes.position.array.length, 0);
      const indexValues = meshes.reduce((sum, mesh) => sum + mesh.index.array.length, 0);
      const positions = new Float32Array(vertexValues);
      const hasNormals = meshes.every(mesh => mesh.attributes.normal?.array?.length === mesh.attributes.position.array.length);
      const normals = hasNormals ? new Float32Array(vertexValues) : null;
      const IndexArray = vertexValues / 3 <= 65535 ? Uint16Array : Uint32Array;
      const indices = new IndexArray(indexValues);
      let vertexOffset = 0, indexOffset = 0;
      for (let i = 0; i < total; i++) {
        const mesh = meshes[i];
        const values = mesh.attributes.position.array;
        positions.set(values, vertexOffset);
        if (normals) normals.set(mesh.attributes.normal.array, vertexOffset);
        for (let j = 0; j < mesh.index.array.length; j++) indices[indexOffset + j] = mesh.index.array[j] + vertexOffset / 3;
        vertexOffset += values.length;
        indexOffset += mesh.index.array.length;
        meshes[i] = null;
      }
      const transfer = [positions.buffer, indices.buffer];
      if (normals) transfer.push(normals.buffer);
      self.postMessage({ type: "mesh", name: "STEP 曲面批次", positions: positions.buffer, normals: normals?.buffer ?? null, indices: indices.buffer, indexType: IndexArray === Uint16Array ? "uint16" : "uint32" }, transfer);
      self.postMessage({ type: "done", total: 1 });
      return;
    }

    for (let meshIndex = 0; meshIndex < total; meshIndex += 1) {
      const source = meshes[meshIndex];
      const positions = new Float32Array(source.attributes.position.array);
      const normalValues = source.attributes.normal?.array;
      const normals = normalValues?.length ? new Float32Array(normalValues) : null;
      const IndexArray = positions.length / 3 <= 65535 ? Uint16Array : Uint32Array;
      const indices = new IndexArray(source.index.array);

      const transfer = [positions.buffer, indices.buffer];
      if (normals) transfer.push(normals.buffer);

      self.postMessage({
        type: "mesh",
        meshIndex,
        total,
        name: source.name || "STEP 部件",
        positions: positions.buffer,
        normals: normals ? normals.buffer : null,
        indices: indices.buffer,
        indexType: IndexArray === Uint16Array ? "uint16" : "uint32",
      }, transfer);

      source.attributes.position.array = [];
      if (source.attributes.normal) source.attributes.normal.array = [];
      source.index.array = [];
      source.brep_faces = [];
      meshes[meshIndex] = null;
    }

    self.postMessage({ type: "done", total });
  } catch (error) {
    sendError(error);
  }
});
