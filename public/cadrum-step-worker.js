import initCadrum, { LocalStepSession } from "./cadrum/v1/cadrum_local_preview-ddf094990a106c75.js";

const WASM_URL = new URL(
  "./cadrum/v1/cadrum_local_preview-ddf094990a106c75_bg.wasm",
  import.meta.url,
);
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const FLOAT32 = 5126;
const UINT16 = 5123;
const UINT32 = 5125;
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

let enginePromise = null;
let session = null;
let total = 0;
let succeeded = 0;
let failed = 0;
let opening = false;
let busy = false;
let terminal = false;

function messageFor(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "STEP 文件读取失败。");
}

function send(message, transfer) {
  if (terminal && message.type !== "done" && message.type !== "error") return;
  globalThis.postMessage(message, transfer || []);
}

function releaseSession() {
  const current = session;
  session = null;
  if (!current) return;
  try {
    current.free();
  } catch {
    // The worker is about to close, so a failed destructor needs no recovery.
  }
}

function stopWithError(error) {
  if (terminal) return;
  terminal = true;
  busy = false;
  releaseSession();
  send({ type: "error", message: messageFor(error) });
  globalThis.close();
}

function finish() {
  if (terminal) return;
  terminal = true;
  busy = false;
  let completed = total;
  try {
    if (session) completed = session.converted_count();
  } catch {
    // Completion still needs to release the session and close the worker.
  }
  releaseSession();
  send({ type: "done", total, completed, succeeded, failed });
  globalThis.close();
}

function ensureEngine() {
  if (!enginePromise) {
    enginePromise = initCadrum({ module_or_path: WASM_URL });
  }
  return enginePromise;
}

function integer(value, fallback = 0) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("模型网格包含无效的数据偏移。");
  }
  return result;
}

function accessorData(document, accessorIndex, bin, expectedType, allowedComponents) {
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor || accessor.sparse || accessor.type !== expectedType) {
    throw new Error("模型网格使用了暂不支持的存储方式。");
  }
  if (!allowedComponents.includes(accessor.componentType)) {
    throw new Error("模型网格的数据类型不受支持。");
  }

  const view = document.bufferViews?.[accessor.bufferView];
  if (!view || integer(view.buffer) !== 0) {
    throw new Error("模型网格缺少有效的二进制数据。");
  }

  const componentCount = TYPE_COMPONENTS[accessor.type];
  const componentBytes = accessor.componentType === UINT16 ? 2 : 4;
  const elementBytes = componentCount * componentBytes;
  const count = integer(accessor.count);
  const viewOffset = integer(view.byteOffset);
  const accessorOffset = integer(accessor.byteOffset);
  const viewLength = integer(view.byteLength);
  const stride = integer(view.byteStride, elementBytes);

  if (stride < elementBytes || stride % componentBytes !== 0) {
    throw new Error("模型网格的数据间隔无效。");
  }
  const accessorEnd = count === 0
    ? accessorOffset
    : accessorOffset + (count - 1) * stride + elementBytes;
  const end = viewOffset + accessorEnd;
  if (accessorEnd > viewLength || end > bin.byteLength) {
    throw new Error("模型网格数据不完整。");
  }

  const valueCount = count * componentCount;
  if (!Number.isSafeInteger(valueCount) || valueCount > 0x7fffffff) {
    throw new Error("模型网格过大，无法在当前设备上显示。");
  }

  const absoluteOffset = bin.byteOffset + viewOffset + accessorOffset;
  const ResultArray = accessor.componentType === FLOAT32
    ? Float32Array
    : accessor.componentType === UINT16
      ? Uint16Array
      : Uint32Array;

  if (
    IS_LITTLE_ENDIAN &&
    stride === elementBytes &&
    absoluteOffset % componentBytes === 0
  ) {
    return new ResultArray(bin.buffer, absoluteOffset, valueCount).slice();
  }

  const result = new ResultArray(valueCount);
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  let output = 0;
  for (let item = 0; item < count; item += 1) {
    const itemOffset = viewOffset + accessorOffset + item * stride;
    for (let component = 0; component < componentCount; component += 1) {
      const offset = itemOffset + component * componentBytes;
      if (accessor.componentType === FLOAT32) result[output] = data.getFloat32(offset, true);
      else if (accessor.componentType === UINT16) result[output] = data.getUint16(offset, true);
      else result[output] = data.getUint32(offset, true);
      output += 1;
    }
  }
  return result;
}

function parseGlb(glb) {
  if (!(glb instanceof Uint8Array) || glb.byteLength < 20) {
    throw new Error("部件没有生成有效的外观网格。");
  }
  const header = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const declaredLength = header.getUint32(8, true);
  if (
    header.getUint32(0, true) !== GLB_MAGIC ||
    header.getUint32(4, true) !== 2 ||
    declaredLength < 20 ||
    declaredLength > glb.byteLength
  ) {
    throw new Error("部件生成的 GLB 数据无效。");
  }

  let json = null;
  let bin = null;
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    const chunkOffset = offset + 8;
    const chunkEnd = chunkOffset + length;
    if (chunkEnd > declaredLength) throw new Error("部件生成的 GLB 数据不完整。");
    if (type === GLB_JSON_CHUNK && json === null) {
      const text = new TextDecoder().decode(
        new Uint8Array(glb.buffer, glb.byteOffset + chunkOffset, length),
      ).replace(/[\u0000\s]+$/u, "");
      json = JSON.parse(text);
    } else if (type === GLB_BIN_CHUNK && bin === null) {
      bin = {
        buffer: glb.buffer,
        byteOffset: glb.byteOffset + chunkOffset,
        byteLength: length,
      };
    }
    offset = chunkEnd;
  }
  if (!json || !bin || json.asset?.version !== "2.0") {
    throw new Error("部件生成的 GLB 缺少网格数据。");
  }

  const pieces = [];
  let vertexCount = 0;
  let indexCount = 0;
  let name = "STEP 外观部件";
  for (const mesh of json.meshes || []) {
    if (typeof mesh?.name === "string" && mesh.name) name = mesh.name;
    for (const primitive of mesh?.primitives || []) {
      if ((primitive.mode ?? 4) !== 4 || !Number.isSafeInteger(primitive.attributes?.POSITION)) continue;
      const positions = accessorData(json, primitive.attributes.POSITION, bin, "VEC3", [FLOAT32]);
      const vertices = positions.length / 3;
      if (vertices < 3) continue;

      let normals = null;
      if (Number.isSafeInteger(primitive.attributes?.NORMAL)) {
        normals = accessorData(json, primitive.attributes.NORMAL, bin, "VEC3", [FLOAT32]);
        if (normals.length !== positions.length) throw new Error("部件法线数据不完整。");
      }

      let indices;
      if (Number.isSafeInteger(primitive.indices)) {
        indices = accessorData(json, primitive.indices, bin, "SCALAR", [UINT16, UINT32]);
      } else {
        indices = new Uint32Array(vertices);
        for (let index = 0; index < vertices; index += 1) indices[index] = index;
      }
      if (indices.length < 3 || indices.length % 3 !== 0) {
        throw new Error("部件三角形索引不完整。");
      }
      for (let index = 0; index < indices.length; index += 1) {
        if (indices[index] >= vertices) throw new Error("部件三角形索引越界。");
      }

      vertexCount += vertices;
      indexCount += indices.length;
      if (
        !Number.isSafeInteger(vertexCount) ||
        !Number.isSafeInteger(indexCount) ||
        vertexCount * 3 > 0x7fffffff ||
        indexCount > 0x7fffffff
      ) {
        throw new Error("部件网格过大，无法在当前设备上显示。");
      }
      pieces.push({ positions, normals, indices, vertices });
    }
  }
  if (!pieces.length) throw new Error("部件没有可显示的三角形网格。");

  const positions = new Float32Array(vertexCount * 3);
  const hasNormals = pieces.every((piece) => piece.normals !== null);
  const normals = hasNormals ? new Float32Array(vertexCount * 3) : null;
  const IndexArray = vertexCount <= 65536 ? Uint16Array : Uint32Array;
  const indices = new IndexArray(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const piece of pieces) {
    positions.set(piece.positions, vertexOffset * 3);
    if (normals) normals.set(piece.normals, vertexOffset * 3);
    for (let index = 0; index < piece.indices.length; index += 1) {
      indices[indexOffset + index] = piece.indices[index] + vertexOffset;
    }
    vertexOffset += piece.vertices;
    indexOffset += piece.indices.length;
  }

  return { name, positions, normals, indices };
}

async function openSession(data) {
  if (opening || session || terminal) throw new Error("STEP 读取器已经启动。");
  opening = true;
  try {
    send({ type: "status", phase: "reading" });
    const bufferPromise = data.buffer instanceof ArrayBuffer
      ? Promise.resolve(data.buffer)
      : data.file?.arrayBuffer?.();
    if (!bufferPromise) throw new Error("没有收到可读取的 STEP 文件。");

    send({ type: "status", phase: "starting" });
    const [buffer] = await Promise.all([bufferPromise, ensureEngine()]);
    if (terminal) return;

    send({ type: "status", phase: "parsing" });
    session = new LocalStepSession(new Uint8Array(buffer));
    total = session.part_count();
    if (!total) throw new Error("这个文件没有可显示的三维实体。");
    const bounds = Array.from(session.model_bounds());
    send({
      type: "ready",
      total,
      completed: session.converted_count(),
      bounds,
      parseMillis: session.parse_millis(),
      rankMillis: session.rank_millis(),
    });
  } finally {
    opening = false;
  }
}

function convertUntilMeshUnsafe() {
  if (terminal || !session) return;
  const before = session.converted_count();
  if (before >= total) {
    finish();
    return;
  }

  let glb;
  try {
    glb = session.next_part_glb(0.01, 1.0);
  } catch (error) {
    const completed = session.converted_count();
    failed += 1;
    if (completed <= before) {
      stopWithError(error);
      return;
    }
    send({ type: "skipped", total, completed, failed, message: messageFor(error) });
    setTimeout(convertUntilMesh, 0);
    return;
  }

  const completed = session.converted_count();
  if (completed <= before && completed < total) {
    stopWithError(new Error("STEP 读取器没有继续前进，已停止以避免设备卡死。"));
    return;
  }
  if (!glb?.byteLength) {
    if (completed >= total) finish();
    else {
      failed += 1;
      send({ type: "skipped", total, completed, failed, message: "部件没有生成外观网格。" });
      setTimeout(convertUntilMesh, 0);
    }
    return;
  }

  let mesh;
  try {
    mesh = parseGlb(glb);
  } catch (error) {
    failed += 1;
    send({ type: "skipped", total, completed, failed, message: messageFor(error) });
    setTimeout(convertUntilMesh, 0);
    return;
  }

  const meshIndex = succeeded;
  succeeded += 1;
  busy = false;
  const transfer = [mesh.positions.buffer, mesh.indices.buffer];
  if (mesh.normals) transfer.push(mesh.normals.buffer);
  send({
    type: "mesh",
    meshIndex,
    total,
    completed,
    failed,
    name: mesh.name === "STEP 外观部件" ? `${mesh.name} ${completed}` : mesh.name,
    positions: mesh.positions.buffer,
    normals: mesh.normals ? mesh.normals.buffer : null,
    indices: mesh.indices.buffer,
    indexType: mesh.indices instanceof Uint16Array ? "uint16" : "uint32",
  }, transfer);
}

function convertUntilMesh() {
  try {
    convertUntilMeshUnsafe();
  } catch (error) {
    stopWithError(error);
  }
}

globalThis.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "open") {
    openSession(event.data).catch(stopWithError);
    return;
  }
  if (type !== "next" || terminal || busy) return;
  if (!session) {
    stopWithError(new Error("STEP 读取器还没有准备好。"));
    return;
  }
  busy = true;
  convertUntilMesh();
});
