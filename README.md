# next-analyze-to-ndjson

Converts the binary `.data` files produced by `next experimental-analyze --output` into plain NDJSON — one JSON object per line, ready for `jq`, `grep`, or feeding to an LLM.

## Quick start

```bash
# 1. Generate analyze data in your Next.js project
pnpm next experimental-analyze --output

# 2. Run the converter (no dependencies beyond Node.js)
node analyze-to-ndjson.mjs

# 3. Browse the output
ls analyze-ndjson/
```

## Options

```
--input <dir>   Source directory (default: .next/diagnostics/analyze/data)
--output <dir>  Output directory (default: ./analyze-ndjson)
```

## Output

| File | Description |
|---|---|
| `modules.ndjson` | Global module registry (id, ident, path) |
| `module_edges.ndjson` | Module dependency graph (from, to, kind) |
| `sources.ndjson` | Per-route source tree with sizes and client/server/js/css flags |
| `chunk_parts.ndjson` | Granular size data per (source, output file) pair |
| `output_files.ndjson` | Per-route output files with aggregated sizes |
| `routes.ndjson` | Route-level size summaries |

## Example queries

```bash
# Route sizes
jq -s 'sort_by(-.total_compressed_size)' analyze-ndjson/routes.ndjson

# Top 10 largest sources by compressed size
jq -s 'map(select(.compressed_size)) | sort_by(-.compressed_size) | .[0:10]' analyze-ndjson/sources.ndjson

# Client-side JS only
grep '"client":true' analyze-ndjson/sources.ndjson | grep '"js":true' | jq -s 'sort_by(-.compressed_size) | .[0:10]'

# Who depends on module 42?
grep '"to":42,' analyze-ndjson/module_edges.ndjson | jq .from

# Find a module by name
grep 'react-dom' analyze-ndjson/modules.ndjson | jq '{id, path}'
```

See [SKILL.md](SKILL.md) for more usage patterns.
