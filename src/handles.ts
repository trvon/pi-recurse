import { randomUUID } from "node:crypto";
import { glob, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface LoadedFile {
  path: string;
  /** Character offsets of the file's content (after its header) in the handle text. */
  start: number;
  end: number;
  lines: number;
}

export interface Handle {
  id: string;
  label: string;
  text: string;
  files: LoadedFile[];
  bytes: number;
  lines: number;
}

export interface HandleSummary {
  handle: string;
  label: string;
  chars: number;
  bytes: number;
  lines: number;
  files: number;
  skipped: string[];
}

export interface LoadOptions {
  cwd: string;
  maxBytes: number;
  maxFiles: number;
  exclude?: string[];
}

export interface GrepMatch {
  file: string | undefined;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build*/**", "**/.venv/**", "**/__pycache__/**"];

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export class HandleStore {
  private readonly handles = new Map<string, Handle>();
  /** Handles made internally (rlm_query slices); never picked as the default handle. */
  private readonly internal = new Set<string>();

  /**
   * Resolve a handle reference from a model or script: an id, a result object carrying `handle`,
   * or text that contains exactly one known id (as when a result rewriter turned the structured
   * result into text). With no reference, the most recently loaded handle.
   */
  resolve(ref?: unknown): string {
    const id = this.tryResolve(ref);
    if (id) return id;
    if (ref === undefined || ref === null || ref === "") throw new Error("no handle loaded: call rlm_load first");
    throw new Error(`unknown handle ${JSON.stringify(ref).slice(0, 80)} (handles live for this pi process; load again)`);
  }

  /** Like resolve(), but undefined instead of an error when nothing matches. */
  tryResolve(ref?: unknown): string | undefined {
    if (ref && typeof ref === "object" && typeof (ref as { handle?: unknown }).handle === "string") ref = (ref as { handle: string }).handle;
    if (ref === undefined || ref === null || ref === "") return this.latest();
    if (typeof ref !== "string") return undefined;
    if (this.handles.has(ref)) return ref;
    const found = [...new Set(ref.match(/\b[0-9a-f]{8}\b/g) ?? [])].filter((id) => this.handles.has(id));
    return found.length === 1 ? found[0] : undefined;
  }

  /** Most recently loaded handle that the user (not pi-recurse itself) created. */
  latest(): string | undefined {
    let last: string | undefined;
    for (const id of this.handles.keys()) if (!this.internal.has(id)) last = id;
    return last;
  }

  get(id: string): Handle {
    const h = this.handles.get(id);
    if (!h) throw new Error(`unknown handle "${id}" (handles live for this pi process; load again)`);
    return h;
  }

  list(): HandleSummary[] {
    return [...this.handles.values()].map((h) => this.summary(h, []));
  }

  drop(id: string): boolean {
    this.internal.delete(id);
    return this.handles.delete(id);
  }

  loadText(text: string, label = "text", options: { internal?: boolean } = {}): HandleSummary {
    const h: Handle = {
      id: randomUUID().slice(0, 8),
      label,
      text,
      files: [],
      bytes: Buffer.byteLength(text),
      lines: countLines(text),
    };
    this.handles.set(h.id, h);
    if (options.internal) this.internal.add(h.id);
    return this.summary(h, []);
  }

  /** Load files matching `patterns` (paths or globs, relative to cwd) into one handle. */
  async loadFiles(patterns: string[], options: LoadOptions): Promise<HandleSummary> {
    const exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
    const paths = new Set<string>();
    for (const pattern of patterns) {
      const abs = isAbsolute(pattern) ? pattern : resolve(options.cwd, pattern);
      const st = await stat(abs).catch(() => undefined);
      if (st?.isFile()) {
        paths.add(abs);
        continue;
      }
      const globPattern = st?.isDirectory() ? `${abs}/**/*` : abs;
      for await (const p of glob(globPattern, { exclude })) {
        paths.add(isAbsolute(p) ? p : resolve(options.cwd, p));
        if (paths.size > options.maxFiles) break;
      }
    }

    const sorted = [...paths].sort();
    if (sorted.length > options.maxFiles) {
      throw new Error(`${sorted.length}+ files match; the limit is ${options.maxFiles}. Narrow the pattern.`);
    }

    const parts: string[] = [];
    const files: LoadedFile[] = [];
    const skipped: string[] = [];
    let offset = 0;
    let bytes = 0;
    for (const abs of sorted) {
      const st = await stat(abs).catch(() => undefined);
      if (!st?.isFile()) continue;
      const rel = relative(options.cwd, abs) || abs;
      if (bytes + st.size > options.maxBytes) {
        throw new Error(`input exceeds ${options.maxBytes} bytes at ${rel}. Narrow the pattern or raise maxLoadBytes in pi-recurse.json.`);
      }
      const buf = await readFile(abs);
      if (isBinary(buf)) {
        skipped.push(rel);
        continue;
      }
      const content = buf.toString("utf8");
      const header = `=== FILE: ${rel} ===\n`;
      const start = offset + header.length;
      parts.push(header, content, "\n");
      files.push({ path: rel, start, end: start + content.length, lines: countLines(content) });
      offset = start + content.length + 1;
      bytes += buf.length;
    }

    const text = parts.join("");
    const h: Handle = {
      id: randomUUID().slice(0, 8),
      label: patterns.join(", "),
      text,
      files,
      bytes,
      lines: countLines(text),
    };
    this.handles.set(h.id, h);
    return this.summary(h, skipped);
  }

  /** Text of one loaded file, by exact or suffix path match. */
  fileText(id: string, path: string): { path: string; text: string } {
    const h = this.get(id);
    const f = h.files.find((x) => x.path === path) ?? h.files.find((x) => x.path.endsWith(path));
    if (!f) throw new Error(`no file "${path}" in handle ${id}`);
    return { path: f.path, text: h.text.slice(f.start, f.end) };
  }

  /** Lines [start, start+count) of the handle text, 1-based. */
  lineRange(id: string, start: number, count: number): string {
    const text = this.get(id).text;
    if (count <= 0) return "";
    let from = 0;
    for (let line = 1; line < Math.max(1, start); line++) {
      const next = text.indexOf("\n", from);
      if (next < 0) return "";
      from = next + 1;
    }
    let end = from;
    for (let line = 0; line < count; line++) {
      const next = text.indexOf("\n", end);
      if (next < 0) return text.slice(from);
      if (line === count - 1) return text.slice(from, next);
      end = next + 1;
    }
    return "";
  }

  charRange(id: string, start: number, end: number): string {
    return this.get(id).text.slice(Math.max(0, start), Math.max(0, end));
  }

  /** File that contains a character offset, if the handle was loaded from files. */
  fileAt(id: string, offset: number): LoadedFile | undefined {
    return this.get(id).files.find((f) => offset >= f.start && offset <= f.end);
  }

  grep(id: string, pattern: string, options: { flags?: string; context?: number; maxMatches?: number } = {}): GrepMatch[] {
    const h = this.get(id);
    const flags = (options.flags ?? "").replace(/[gy]/g, "");
    const re = new RegExp(pattern, flags);
    const context = Math.max(0, options.context ?? 0);
    const max = Math.max(1, options.maxMatches ?? 50);
    const out: GrepMatch[] = [];
    const lines = h.text.split("\n");
    let offset = 0;
    let fileIdx = 0;
    let fileLine = 0;
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const line = lines[i] ?? "";
      while (fileIdx < h.files.length && offset > (h.files[fileIdx]?.end ?? 0)) {
        fileIdx++;
        fileLine = 0;
      }
      const file = h.files[fileIdx];
      const inFile = file && offset >= file.start && offset <= file.end;
      if (inFile) fileLine++;
      if (re.test(line) && !line.startsWith("=== FILE: ")) {
        out.push({
          file: inFile ? file.path : undefined,
          line: inFile ? fileLine : i + 1,
          text: line,
          before: lines.slice(Math.max(0, i - context), i),
          after: lines.slice(i + 1, i + 1 + context),
        });
      }
      offset += line.length + 1;
    }
    return out;
  }

  /** Matching paths only: stop at each file's first hit instead of allocating every match. */
  matchingFiles(id: string, pattern: string, flags = ""): string[] {
    const h = this.get(id);
    const re = new RegExp(pattern, flags.replace(/[gy]/g, ""));
    const paths: string[] = [];
    for (const file of h.files) {
      let start = file.start;
      while (start <= file.end) {
        const newline = h.text.indexOf("\n", start);
        const end = newline < 0 ? file.end : Math.min(newline, file.end);
        const line = h.text.slice(start, end);
        if (!line.startsWith("=== FILE: ") && re.test(line)) {
          paths.push(file.path);
          break;
        }
        start = end + 1;
      }
    }
    return paths;
  }

  private summary(h: Handle, skipped: string[]): HandleSummary {
    return { handle: h.id, label: h.label, chars: h.text.length, bytes: h.bytes, lines: h.lines, files: h.files.length, skipped };
  }
}
