/* Bounded STEP surface batches. Keep the original assembly graph, placements and units.
 * Only filter shell face lists; never invent transformations or drop hidden parts.
 * Used in a dedicated worker, and imported by local regression tests.
 */
(function (scope) {
  "use strict";
  const TOKEN = /'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|#(\d+)/g;
  const FACE = /^(?:ADVANCED_FACE|FACE_SURFACE|FACE)\s*\(/;
  const ROOT = /^(?:SHAPE_DEFINITION_REPRESENTATION|CONTEXT_DEPENDENT_SHAPE_REPRESENTATION|SHAPE_REPRESENTATION_RELATIONSHIP|REPRESENTATION_RELATIONSHIP)\s*\(|^\(\s*REPRESENTATION_RELATIONSHIP\s*\(/;
  const REPR = /^(?:[A-Z_]*SHAPE_REPRESENTATION)\s*\(/;

  function references(record) {
    const ids = [];
    TOKEN.lastIndex = record.indexOf("=") + 1;
    let token;
    while ((token = TOKEN.exec(record))) if (token[1]) ids.push(Number(token[1]));
    return ids;
  }

  // Remove only a complete list member that references an omitted face. The
  // scanner preserves names, escaped quotes, comments and every other STEP token.
  function filterFaces(record, faces, selected) {
    let cursor = 0;
    function sequence(nested) {
      const parts = [];
      let part = "";
      const add = () => {
        const ref = /^\s*#(\d+)\s*$/.exec(part.replace(/\/\*[\s\S]*?\*\//g, ""));
        if (!ref || !faces.has(+ref[1]) || selected.has(+ref[1])) parts.push(part);
        part = "";
      };
      while (cursor < record.length) {
        const char = record[cursor++];
        if (char === "'") {
          part += char;
          while (cursor < record.length) {
            const next = record[cursor++];
            part += next;
            if (next === "'") {
              if (record[cursor] === "'") { part += record[cursor++]; continue; }
              break;
            }
          }
        } else if (char === "/" && record[cursor] === "*") {
          const end = record.indexOf("*/", cursor + 1);
          if (end < 0) throw new Error("STEP 注释未结束。");
          part += "/" + record.slice(cursor, end + 2);
          cursor = end + 2;
        } else if (char === "(") {
          part += "(" + sequence(true) + ")";
        } else if (nested && (char === "," || char === ")")) {
          add();
          if (char === ")") return parts.join(",");
        } else part += char;
      }
      add();
      return parts.join(",");
    }
    return sequence(false);
  }

  class StepPartition {
    constructor(text) {
      this.text = text;
      this.pages = new Map();
      this.faces = new Set();
      this.cursor = 0;
      const roots = [], representations = [];
      const data = /\bDATA\s*;/g.exec(text);
      if (!data) throw new Error("没有找到 STEP 数据段。");
      this.header = text.slice(0, data.index + data[0].length);
      let cursor = data.index + data[0].length;
      while (cursor < text.length) {
        if (/\s/.test(text[cursor])) { cursor++; continue; }
        if (text.slice(cursor, cursor + 2) === "/*") {
          const end = text.indexOf("*/", cursor + 2);
          if (end < 0) throw new Error("STEP 注释未结束。");
          cursor = end + 2; continue;
        }
        if (text.slice(cursor, cursor + 6) === "ENDSEC") break;
        const start = cursor;
        if (text[cursor++] !== "#") throw new Error("这种 STEP 数据布局暂不支持分批读取。");
        const numberStart = cursor;
        while (text.charCodeAt(cursor) >= 48 && text.charCodeAt(cursor) <= 57) cursor++;
        const id = Number(text.slice(numberStart, cursor));
        if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) throw new Error("STEP 编号不受支持。");
        while (/\s/.test(text[cursor])) cursor++;
        if (text[cursor++] !== "=") throw new Error("STEP 实体格式不完整。");
        const rhs = cursor;
        let quote = false, done = false;
        for (; cursor < text.length; cursor++) {
          const char = text[cursor];
          if (char === "'") {
            if (quote && text[cursor + 1] === "'") cursor++;
            else quote = !quote;
          } else if (!quote && char === "/" && text[cursor + 1] === "*") {
            const end = text.indexOf("*/", cursor + 2);
            if (end < 0) throw new Error("STEP 注释未结束。");
            cursor = end + 1;
          } else if (!quote && char === ";") { cursor++; done = true; break; }
        }
        if (!done) throw new Error("STEP 文件不完整。");
        const pageId = Math.floor(id / 65536), offset = (id % 65536) * 2;
        let page = this.pages.get(pageId);
        if (!page) { page = new Uint32Array(131072); this.pages.set(pageId, page); }
        if (page[offset + 1]) throw new Error("STEP 包含重复编号。");
        page[offset] = start; page[offset + 1] = cursor;
        const kind = text.slice(rhs, Math.min(cursor, rhs + 180)).trimStart();
        if (FACE.test(kind)) this.faces.add(id);
        if (ROOT.test(kind)) roots.push(id);
        if (REPR.test(kind)) representations.push(id);
      }
      // Non-BRep STEP (e.g. AP242 tessellated entities) stays on the unmodified path.
      if (!this.faces.size || !representations.length) { this.supported = false; return; }
      this.meta = this.closure(roots.length ? roots : representations, true);
      this.faceIds = [...this.faces];
      this.metaRecords = [...this.meta].map(id => {
        const record = this.record(id);
        return { record, filtered: references(record).some(ref => this.faces.has(ref)) };
      });
      this.supported = true;
    }

    record(id) {
      const page = this.pages.get(Math.floor(id / 65536)), offset = (id % 65536) * 2;
      if (!page || !page[offset + 1]) throw new Error(`STEP 缺少引用实体 #${id}。`);
      return this.text.slice(page[offset], page[offset + 1]);
    }

    closure(seeds, stopAtFaces) {
      const ids = new Set(), pending = [...seeds];
      while (pending.length) {
        const id = pending.pop();
        if (ids.has(id) || (stopAtFaces && this.faces.has(id))) continue;
        ids.add(id);
        const refs = references(this.record(id));
        for (const ref of refs) if (!ids.has(ref)) pending.push(ref);
      }
      return ids;
    }

    next() {
      if (this.cursor >= this.faceIds.length) return null;
      const selected = new Set(), geometry = new Set();
      let size = 0;
      while (this.cursor < this.faceIds.length && selected.size < 200) {
        const id = this.faceIds[this.cursor];
        const refs = this.closure([id], false);
        let extra = 0;
        for (const ref of refs) if (!geometry.has(ref) && !this.meta.has(ref)) extra += this.record(ref).length + 1;
        if (selected.size && size + extra > 1024 * 1024) break;
        if (extra > 12 * 1024 * 1024) throw new Error("有单个曲面过于复杂，已保留读出的部分。");
        size += extra; selected.add(id); this.cursor++;
        for (const ref of refs) if (!this.meta.has(ref)) geometry.add(ref);
      }
      const records = [this.header];
      for (const entry of this.metaRecords) records.push(entry.filtered ? filterFaces(entry.record, this.faces, selected) : entry.record);
      for (const id of geometry) records.push(this.record(id));
      records.push("ENDSEC;\nEND-ISO-10303-21;");
      return {
        buffer: new TextEncoder().encode(records.join("\n")).buffer,
        completed: this.cursor,
        total: this.faceIds.length,
      };
    }
  }
  scope.StepPartition = StepPartition;
})(globalThis);
