#!/usr/bin/env node
// Converts Next.js bundle analyzer .data files to NDJSON for offline analysis.
// Usage: node tools/analyze-to-ndjson.mjs [--input <dir>] [--output <dir>]

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

// --- CLI args ---

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

const inputDir = arg("--input", ".next/diagnostics/analyze/data");
const outputDir = arg("--output", "./analyze-ndjson");

// --- Binary format helpers ---

function parseDataFile(filePath) {
  const buf = readFileSync(filePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jsonLength = view.getUint32(0, false); // big-endian
  const jsonStr = new TextDecoder("utf-8").decode(buf.subarray(4, 4 + jsonLength));
  const header = JSON.parse(jsonStr);
  const binaryOffset = 4 + jsonLength;
  const binaryView = new DataView(buf.buffer, buf.byteOffset + binaryOffset, buf.byteLength - binaryOffset);
  return { header, binaryView };
}

function readEdgesAtIndex(binaryView, ref, index) {
  if (!ref || ref.length === 0) return [];
  const { offset } = ref;
  const numOffsets = binaryView.getUint32(offset, false);
  if (index < 0 || index >= numOffsets) return [];

  const offsetsStart = offset + 4;
  const prevOffset = index === 0 ? 0 : binaryView.getUint32(offsetsStart + (index - 1) * 4, false);
  const edgeCount = binaryView.getUint32(offsetsStart + index * 4, false) - prevOffset;
  if (edgeCount === 0) return [];

  const dataStart = offset + 4 + 4 * numOffsets;
  const edges = [];
  for (let j = 0; j < edgeCount; j++) {
    edges.push(binaryView.getUint32(dataStart + (prevOffset + j) * 4, false));
  }
  return edges;
}

function readAllEdges(binaryView, ref) {
  if (!ref || ref.length === 0) return [];
  const { offset } = ref;
  const numOffsets = binaryView.getUint32(offset, false);
  const result = [];
  for (let i = 0; i < numOffsets; i++) {
    result.push(readEdgesAtIndex(binaryView, ref, i));
  }
  return result;
}

// --- Discover routes by scanning for analyze.data files ---

function discoverRoutes(dataDir) {
  const routes = [];
  function walk(dir, routePrefix) {
    const analyzeFile = join(dir, "analyze.data");
    if (existsSync(analyzeFile)) {
      routes.push({ route: routePrefix || "/", filePath: analyzeFile });
    }
    for (const entry of readdirSync(dir)) {
      if (entry === "analyze.data" || entry === "modules.data" || entry === "routes.json") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, (routePrefix || "") + "/" + entry);
      }
    }
  }
  walk(dataDir, "");
  return routes;
}

// --- Path reconstruction ---

function buildFullPaths(sources) {
  const cache = new Map();
  function getFullPath(index) {
    if (cache.has(index)) return cache.get(index);
    const s = sources[index];
    if (!s) { cache.set(index, ""); return ""; }
    let p;
    if (s.parent_source_index == null) {
      p = s.path;
    } else {
      p = getFullPath(s.parent_source_index) + s.path;
    }
    cache.set(index, p);
    return p;
  }
  return sources.map((_, i) => getFullPath(i));
}

// --- Source flags from output filenames ---

function getSourceFlags(sourceIndex, sourceChunkPartsMap, chunkParts, outputFiles) {
  let client = false, server = false, traced = false;
  let js = false, css = false, json = false, asset = false;

  const partIndices = sourceChunkPartsMap.get(sourceIndex) || [];
  for (const cpIdx of partIndices) {
    const cp = chunkParts[cpIdx];
    if (!cp) continue;
    const of = outputFiles[cp.output_file_index];
    if (!of) continue;
    const fn = of.filename;

    if (fn.startsWith("[client-fs]/")) client = true;
    else if (fn.startsWith("[project]/")) traced = true;
    else server = true;

    if (fn.endsWith(".js")) js = true;
    else if (fn.endsWith(".css")) css = true;
    else if (fn.endsWith(".json")) json = true;
    else asset = true;
  }

  return { client, server, traced, js, css, json, asset };
}

// --- NDJSON writer helper ---

function ndjsonWriter(filePath) {
  let buf = "";
  let count = 0;
  const FLUSH_THRESHOLD = 50_000;
  writeFileSync(filePath, "");
  return {
    write(obj) {
      buf += JSON.stringify(obj) + "\n";
      count++;
      if (buf.length > FLUSH_THRESHOLD) {
        appendFileSync(filePath, buf);
        buf = "";
      }
    },
    flush() {
      if (buf.length > 0) { appendFileSync(filePath, buf); buf = ""; }
      return count;
    },
  };
}

// --- Main ---

function main() {
  if (!existsSync(inputDir)) {
    console.error(`Input directory not found: ${inputDir}`);
    console.error("Run 'pnpm next experimental-analyze --output' first.");
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  // 1. Parse modules.data
  const modulesFile = join(inputDir, "modules.data");
  if (!existsSync(modulesFile)) {
    console.error(`modules.data not found in ${inputDir}`);
    process.exit(1);
  }

  const { header: modHeader, binaryView: modBinary } = parseDataFile(modulesFile);
  const modules = modHeader.modules;

  const modulesWriter = ndjsonWriter(join(outputDir, "modules.ndjson"));
  for (let i = 0; i < modules.length; i++) {
    modulesWriter.write({ id: i, ident: modules[i].ident, path: modules[i].path });
  }
  const modulesCount = modulesWriter.flush();
  console.log(`modules.ndjson: ${modulesCount} modules`);

  // 2. Module edges
  const edgesWriter = ndjsonWriter(join(outputDir, "module_edges.ndjson"));
  for (const [refName, kind] of [
    ["module_dependencies", "sync"],
    ["async_module_dependencies", "async"],
  ]) {
    const ref = modHeader[refName];
    if (!ref) continue;
    for (let i = 0; i < modules.length; i++) {
      for (const target of readEdgesAtIndex(modBinary, ref, i)) {
        edgesWriter.write({ from: i, to: target, kind });
      }
    }
  }
  const edgesCount = edgesWriter.flush();
  console.log(`module_edges.ndjson: ${edgesCount} edges`);

  // 3. Per-route data
  const routes = discoverRoutes(inputDir);
  const sourcesWriter = ndjsonWriter(join(outputDir, "sources.ndjson"));
  const chunkPartsWriter = ndjsonWriter(join(outputDir, "chunk_parts.ndjson"));
  const outputFilesWriter = ndjsonWriter(join(outputDir, "output_files.ndjson"));
  const routesWriter = ndjsonWriter(join(outputDir, "routes.ndjson"));

  for (const { route, filePath } of routes) {
    const { header, binaryView } = parseDataFile(filePath);
    const { sources, chunk_parts, output_files, source_chunk_parts, source_children, source_roots } = header;

    // Build full paths
    const fullPaths = buildFullPaths(sources);

    // Build source → chunk_parts index map
    const sourceChunkPartsMap = new Map();
    if (source_chunk_parts && source_chunk_parts.length > 0) {
      for (let i = 0; i < sources.length; i++) {
        const parts = readEdgesAtIndex(binaryView, source_chunk_parts, i);
        if (parts.length > 0) sourceChunkPartsMap.set(i, parts);
      }
    }

    // Compute per-source sizes and flags
    const sourceSizes = new Map();
    for (const [srcIdx, partIndices] of sourceChunkPartsMap) {
      let size = 0, compressedSize = 0;
      for (const cpIdx of partIndices) {
        const cp = chunk_parts[cpIdx];
        if (cp) { size += cp.size; compressedSize += cp.compressed_size; }
      }
      sourceSizes.set(srcIdx, { size, compressed_size: compressedSize });
    }

    // Determine which sources are directories using source_children
    const isDirSet = new Set();
    if (source_children && source_children.length > 0) {
      for (let i = 0; i < sources.length; i++) {
        const children = readEdgesAtIndex(binaryView, source_children, i);
        if (children.length > 0) isDirSet.add(i);
      }
    }
    // Also mark root sources that have children as dirs
    if (source_roots) {
      for (const rootIdx of source_roots) {
        // If a root has source_children, it's a dir
        if (isDirSet.has(rootIdx)) continue;
        // Roots with no chunk_parts and children pointing to them are dirs
        const children = source_children && source_children.length > 0
          ? readEdgesAtIndex(binaryView, source_children, rootIdx)
          : [];
        if (children.length > 0) isDirSet.add(rootIdx);
      }
    }

    // Write sources
    let routeTotalSize = 0, routeTotalCompressed = 0;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const isDir = isDirSet.has(i);
      const sizes = sourceSizes.get(i);
      const flags = getSourceFlags(i, sourceChunkPartsMap, chunk_parts, output_files);

      const obj = {
        route,
        id: i,
        path: s.path,
        full_path: fullPaths[i],
        parent_id: s.parent_source_index ?? null,
        is_dir: isDir,
      };
      if (sizes) {
        obj.size = sizes.size;
        obj.compressed_size = sizes.compressed_size;
        routeTotalSize += sizes.size;
        routeTotalCompressed += sizes.compressed_size;
      }
      // Only add flags if source has chunk_parts (i.e., produces output)
      if (sourceChunkPartsMap.has(i)) {
        Object.assign(obj, flags);
      }
      sourcesWriter.write(obj);
    }

    // Write chunk_parts
    for (const cp of chunk_parts) {
      chunkPartsWriter.write({
        route,
        source_id: cp.source_index,
        output_file: output_files[cp.output_file_index]?.filename ?? `<unknown:${cp.output_file_index}>`,
        size: cp.size,
        compressed_size: cp.compressed_size,
      });
    }

    // Write output_files with aggregated sizes
    // Build per-output-file aggregation using output_file_chunk_parts edges
    const { output_file_chunk_parts } = header;
    for (let i = 0; i < output_files.length; i++) {
      let totalSize = 0, totalCompressed = 0, numParts = 0;
      if (output_file_chunk_parts && output_file_chunk_parts.length > 0) {
        const parts = readEdgesAtIndex(binaryView, output_file_chunk_parts, i);
        for (const cpIdx of parts) {
          const cp = chunk_parts[cpIdx];
          if (cp) { totalSize += cp.size; totalCompressed += cp.compressed_size; numParts++; }
        }
      }
      outputFilesWriter.write({
        route,
        id: i,
        filename: output_files[i].filename,
        total_size: totalSize,
        total_compressed_size: totalCompressed,
        num_parts: numParts,
      });
    }

    // Write route summary
    routesWriter.write({
      route,
      total_size: routeTotalSize,
      total_compressed_size: routeTotalCompressed,
      num_sources: sources.length,
      num_output_files: output_files.length,
    });
  }

  const sc = sourcesWriter.flush();
  const cpc = chunkPartsWriter.flush();
  const ofc = outputFilesWriter.flush();
  const rc = routesWriter.flush();

  console.log(`sources.ndjson: ${sc} sources`);
  console.log(`chunk_parts.ndjson: ${cpc} chunk parts`);
  console.log(`output_files.ndjson: ${ofc} output files`);
  console.log(`routes.ndjson: ${rc} routes`);
  console.log(`\nOutput written to ${outputDir}/`);
}

main();
