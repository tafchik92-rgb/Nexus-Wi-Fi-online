/* ============================================================
   NEXUS//POS — voucher file importer
   Reads .xlsx voucher exports (e.g. TP-Link Omada "VoucherList"
   files) plus .csv / plain-text code lists — entirely client-side,
   zero dependencies. XLSX is ZIP+XML: a minimal ZIP reader feeds
   the browser's built-in DecompressionStream, and the sheet XML is
   parsed with tolerant regexes (no DOM needed, so the same code is
   unit-testable in Node).
   ============================================================ */
"use strict";

(function (root) {

  /* ---------------- minimal ZIP reader ---------------- */

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // Returns a map of {fileName: () => Promise<Uint8Array>} for a ZIP archive.
  function readZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);

    // End-of-central-directory: scan backwards for its signature.
    let eocd = -1;
    const stop = Math.max(0, bytes.length - 65558);
    for (let i = bytes.length - 22; i >= stop; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a valid ZIP/XLSX file");

    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    const entries = {};
    const decoder = new TextDecoder();

    for (let i = 0; i < count; i++) {
      if (view.getUint32(off, true) !== 0x02014b50) break;
      const method = view.getUint16(off + 10, true);
      const compSize = view.getUint32(off + 20, true);
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const localOff = view.getUint32(off + 42, true);
      const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
      if (compSize === 0xffffffff || localOff === 0xffffffff) {
        throw new Error("ZIP64 archives are not supported");
      }
      entries[name] = async () => {
        // local header repeats name/extra with its own lengths
        const lNameLen = view.getUint16(localOff + 26, true);
        const lExtraLen = view.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const data = bytes.subarray(start, start + compSize);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error("Unsupported ZIP compression method " + method);
      };
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* ---------------- sheet XML → 2D string table ---------------- */

  const decodeEntities = (s) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

  const colIndex = (letters) => {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  function parseSharedStrings(xml) {
    if (!xml) return [];
    // each <si> may hold one <t> or several rich-text runs
    return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
      [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join("")
    );
  }

  function parseSheet(xml, shared) {
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      for (const c of rowMatch[1].matchAll(cellRe)) {
        const attrs = c[1], inner = c[2] || "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs);
        const type = (/t="(\w+)"/.exec(attrs) || [])[1] || "n";
        const idx = ref ? colIndex(ref[1]) : cells.length;
        let val = "";
        if (type === "inlineStr") {
          val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join("");
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = type === "s" ? (shared[+v[1]] ?? "") : decodeEntities(v[1]);
        }
        cells[idx] = val;
      }
      if (cells.some((v) => v !== undefined && String(v).trim() !== "")) {
        rows.push([...cells].map((v) => (v === undefined ? "" : String(v))));
      }
    }
    return rows;
  }

  async function xlsxToTable(arrayBuffer) {
    const zip = readZip(arrayBuffer);
    const sheetNames = Object.keys(zip)
      .filter((n) => /^xl\/worksheets\/sheet[^/]*\.xml$/.test(n))
      .sort();
    if (sheetNames.length === 0) throw new Error("No worksheet found in this file");
    const decoder = new TextDecoder();
    const shared = parseSharedStrings(
      zip["xl/sharedStrings.xml"] ? decoder.decode(await zip["xl/sharedStrings.xml"]()) : ""
    );
    const sheetXml = decoder.decode(await zip[sheetNames[0]]());
    return parseSheet(sheetXml, shared);
  }

  /* ---------------- CSV / plain text → table ---------------- */

  function csvToTable(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    return rows;
  }

  /* ---------------- table → voucher entries ---------------- */

  // Maps a price-ish string ("USD10", "$5", "10.00") to a voucher group.
  function typeFromPrice(s) {
    const m = /(\d+(?:\.\d+)?)/.exec(String(s ?? ""));
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (n === 5) return "V5";
    if (n === 10) return "V10";
    if (n === 0) return "REC";
    return null;
  }

  // Finds the code/price columns from a header row (checked within the
  // first 5 rows); falls back to "first column is the code" for bare lists.
  function extractVouchers(table) {
    let headerRow = -1, codeCol = 0, priceCol = -1;
    const norm = (s) => String(s ?? "").trim().toLowerCase();
    for (let r = 0; r < Math.min(5, table.length); r++) {
      const cells = table[r].map(norm);
      const ci = cells.findIndex((c) => c === "code" || c === "voucher code" || c === "voucher" || c === "voucher #");
      if (ci !== -1) {
        headerRow = r; codeCol = ci;
        priceCol = cells.findIndex((c) => c.includes("price"));
        break;
      }
    }
    const entries = [];
    const detected = { V5: 0, V10: 0, REC: 0 };
    let unknown = 0;
    for (let r = headerRow + 1; r < table.length; r++) {
      const code = String(table[r][codeCol] ?? "").trim();
      if (!code) continue;
      const type = priceCol >= 0 ? typeFromPrice(table[r][priceCol]) : null;
      if (type) detected[type]++; else unknown++;
      entries.push({ code, type });
    }
    return { entries, detected, unknown, hadHeader: headerRow !== -1 };
  }

  // file → {entries, detected, unknown, hadHeader}
  async function readVoucherFile(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 2));
    const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
    const table = isZip
      ? await xlsxToTable(buf)
      : csvToTable(new TextDecoder().decode(buf).replace(/^\uFEFF/, ""));
    return extractVouchers(table);
  }

  root.NexusImport = { readVoucherFile, xlsxToTable, csvToTable, extractVouchers, typeFromPrice };

})(typeof window !== "undefined" ? window : globalThis);
