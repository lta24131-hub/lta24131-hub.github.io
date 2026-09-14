/* Compact, chunked edge adjacency. Entirely local computation; no network access. */
(function (scope) {
  "use strict";
  const BLOCK = 65536;
  const MAX_EDGES = 2000000;
  class StructureEdges {
    constructor({ tolerance, origin, triangles }) {
      if (!Number.isFinite(tolerance) || tolerance <= 0 || !Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite) || !Number.isSafeInteger(triangles) || triangles <= 0) throw new Error("结构线参数无效。");
      this.tolerance = Math.max(tolerance, 1e-8);
      this.origin = origin;
      this.threshold = Math.cos(Math.PI / 6);
      let size = 1024;
      while (size < Math.min(MAX_EDGES, triangles * 3) / 0.6) size *= 2;
      this.table = new Uint32Array(size);
      this.blocks = [];
      this.count = 0;
    }
    quantize(value, axis) { return Math.round((value - this.origin[axis]) / this.tolerance); }
    edge(a, b, normal) {
      let qa = a.map((v, i) => this.quantize(v, i)), qb = b.map((v, i) => this.quantize(v, i));
      const order = qa[0] - qb[0] || qa[1] - qb[1] || qa[2] - qb[2];
      if (!order) return;
      let direction = 1;
      if (order > 0) { [a, b] = [b, a]; [qa, qb] = [qb, qa]; direction = 2; }
      let hash = 2166136261;
      for (let i = 0; i < 3; i++) { hash = Math.imul(hash ^ qa[i], 16777619); hash = Math.imul(hash ^ qb[i], 16777619); }
      let bucket = hash & (this.table.length - 1);
      while (this.table[bucket]) {
        const index = this.table[bucket] - 1, block = this.blocks[Math.floor(index / BLOCK)], offset = index % BLOCK;
        let equal = true;
        for (let i = 0; i < 3; i++) {
          if (this.quantize(block.positions[offset * 6 + i], i) !== qa[i] || this.quantize(block.positions[offset * 6 + i + 3], i) !== qb[i]) { equal = false; break; }
        }
        if (equal) {
          const dot = normal[0] * block.normals[offset * 3] + normal[1] * block.normals[offset * 3 + 1] + normal[2] * block.normals[offset * 3 + 2];
          // Ignore duplicate coplanar faces, including reversed duplicate winding.
          if (dot < -0.99999) direction = direction === 1 ? 2 : 1;
          block.flags[offset] |= direction | (Math.abs(dot) < this.threshold ? 4 : 0);
          return;
        }
        bucket = (bucket + 1) & (this.table.length - 1);
      }
      if (this.count >= MAX_EDGES) throw new Error("模型网格过密，已停止结构线计算以保护内存；实体模型仍可正常查看。");
      const index = this.count++, offset = index % BLOCK;
      if (!offset) this.blocks.push({ positions: new Float32Array(BLOCK * 6), normals: new Float32Array(BLOCK * 3), flags: new Uint8Array(BLOCK) });
      const block = this.blocks[Math.floor(index / BLOCK)];
      block.positions.set(a, offset * 6); block.positions.set(b, offset * 6 + 3);
      block.normals.set(normal, offset * 3); block.flags[offset] = direction;
      this.table[bucket] = index + 1;
    }
    add(positions) {
      if (positions.length % 9) throw new Error("结构线数据不完整。");
      for (let i = 0; i < positions.length; i += 9) {
        const a = [positions[i], positions[i + 1], positions[i + 2]], b = [positions[i + 3], positions[i + 4], positions[i + 5]], c = [positions[i + 6], positions[i + 7], positions[i + 8]];
        if (![...a, ...b, ...c].every(Number.isFinite)) throw new Error("模型含有无效坐标。");
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        if (!length) continue;
        const normal = [nx / length, ny / length, nz / length];
        this.edge(a, b, normal); this.edge(b, c, normal); this.edge(c, a, normal);
      }
    }
    finish() {
      let total = 0;
      const visible = flags => (flags & 4) || (flags & 3) !== 3;
      for (let i = 0; i < this.count; i++) if (visible(this.blocks[Math.floor(i / BLOCK)].flags[i % BLOCK])) total++;
      const positions = new Float32Array(total * 6);
      let offset = 0;
      for (let i = 0; i < this.count; i++) {
        const block = this.blocks[Math.floor(i / BLOCK)], local = i % BLOCK;
        if (!visible(block.flags[local])) continue;
        positions.set(block.positions.subarray(local * 6, local * 6 + 6), offset); offset += 6;
      }
      return positions;
    }
  }
  scope.StructureEdges = StructureEdges;
  if (typeof scope.postMessage !== "function") return;
  let edges;
  scope.onmessage = ({ data }) => {
    try {
      if (data.type === "init") edges = new StructureEdges(data);
      else if (data.type === "chunk") edges.add(new Float32Array(data.buffer));
      else if (data.type === "finish") {
        const positions = edges.finish(); edges = null;
        scope.postMessage({ type: "done", buffer: positions.buffer }, [positions.buffer]); return;
      } else throw new Error("无效的结构线任务。");
      scope.postMessage({ type: "ready" });
    } catch (error) { edges = null; scope.postMessage({ type: "error", message: error.message || String(error) }); }
  };
})(globalThis);
