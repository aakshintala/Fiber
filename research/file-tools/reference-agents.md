# Reference agents: file tools (read, write, edit)

Research for fiber issue #52 ("File tools: read, write and edit"). Primary sources only, cited by file:line or exact quoted string. Each source agent was read by a separate delegated research pass; commit/version pins are noted per agent so findings can be re-verified.

Sources read:
- **pi** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/` (npm package `@earendil-works/pi-coding-agent` **0.87.1**), `dist/` and `docs/`.
- **codex** — `openai/codex` cloned sparse (`codex-rs` only) at commit `e72da2b53805894878023d01949a25a082e0a5cb` (2026-09-26), plus `strings` on `~/.codex/packages/standalone/current/bin/codex` version `0.155.1-aarch64-apple-darwin`.
- **Claude Code** — `strings` on `~/.local/share/claude/versions/2.1.283` (newest installed; embedded `// Version: 2.1.283`).
- **fiber-zig** — `aakshintala/fiber-zig`, files `src/tools/filesystem/{read_file,write_file,edit_file}.zig` and `src/core/tooling/file_mutation_contract.zig` (mutation logic itself lives in the sibling `file_mutation.zig` / `file_mutation_execution.zig`, which the contract file's neighbours were read to trace).

Every "not found" line below names the files/patterns checked.

---

## pi

Built-in tool names: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls` (`dist/core/tools/index.js:19-28`). Default-enabled subset: `read`, `bash`, `edit`, `write` (`docs/cli.md:127`, `docs/settings.md:40`).

### 1. Names and schemas
- **read** (`dist/core/tools/read.js:10-14,35-40`): `path` string required; `offset` number optional, 1-indexed line to start; `limit` number optional, max lines to read. No schema-level defaults (TypeBox has none; runtime defaults apply in `execute`).
- **edit** (`dist/core/tools/edit.js:10-21,82-91`): `path` string required; `edits` array of `{oldText, newText}` required, `edits.length >= 1` enforced at runtime (`edit.js:75-77`). No `replace_all`. Legacy top-level `oldText`/`newText` shape is coerced (`edit.js:43-73`).
- **write** (`dist/core/tools/write.js:8-11,22-29`): `path` string required; `content` string required.
- **ls** (`dist/core/tools/ls.js:8-11,24-29`): `path` string optional, default `"."` (`ls.js:40`); `limit` number optional, default `500` (`ls.js:16,41`).

### 2. read
- **No line-number prefix.** `execute` returns raw file text; no `N|`/`N:` prefix anywhere in `read.js` or `renderers/read.js` — not found.
- Limits: `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024` (`truncate.js:10-11`), whichever hits first.
- Offset/limit: 1-based lines. `startLine = offset ? Math.max(0, offset - 1) : 0` (`read.js:98-99`); `limit` is a line count (`read.js:108-111`).
- Out-of-range offset: `` `Offset ${offset} is beyond end of file (${allLines.length} lines total)` `` (`read.js:103`).
- Truncation messages (verbatim): `` `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]` `` (`read.js:131`); byte-limited variant at `read.js:134`; user-`limit`-stopped variant `` `[${remaining} more lines in file. Use offset=${nextOffset} to continue.]` `` (`read.js:142`). Never returns a partial line (`truncate.js:8,41-42`).
- Long lines: no per-line char cap on `read` (`GREP_MAX_LINE_LENGTH=500` is grep-only, `truncate.js:12`); a first-line >50KB yields empty content plus a message (`read.js:119-123`).
- Images: jpg/png/gif/webp/bmp sniffed from the first 4100 bytes (`mime.js:2,4-31`); auto-resize on by default, max 2000×2000, 4.5MB base64 cap, JPEG quality 80 (`image-resize-core.js:3-9`). Returned as a text block plus an `{type:"image"}` block (`read.js:80-89`). No-vision model: image block is still attached but the tool appends `` `[Current model does not support images. The image will be omitted from this request.]` `` (`read.js:24-28,84-85`); downstream, `pi-ai`'s `transform-messages.js` replaces image blocks with `(tool image omitted: model does not support images)`.
- PDF/notebook: not found in `read.js`, `utils/mime.js`, or `docs/`.
- Other binary: non-image path is unconditional `buffer.toString("utf-8")` (`read.js:94-95`) — no binary sniff/refusal.
- Directory passed to read: no `EISDIR`/`isDirectory` handling in `read.js`; Node's `fs.readFile` rejection just bubbles (`read.js:155-158`).

### 3. edit
- Format: multi-replace exact string, one file per call, all `oldText`s matched against the original content (not incrementally) (`edit.js:18-19`; `edit-diff.js:207-213`). Not a patch format. No `replace_all`.
- Uniqueness: each `oldText` must occur exactly once; overlapping matches rejected (`edit-diff.js:235-252,220-223`).
- Fuzzy fallback (only after exact `indexOf` fails, `edit-diff.js:141-175`), via `normalizeForFuzzyMatch` (`edit-diff.js:31-49`): Unicode NFKC, strip trailing per-line whitespace, fold smart quotes/dashes, fold NBSP and several Unicode space characters to ASCII space. Also LF-normalizes both `oldText`/`newText` before matching (`edit-diff.js:216-218`).
- Errors (verbatim): `` `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.` `` (`edit-diff.js:184`); multi-edit variant at `edit-diff.js:186`; `` `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.` `` (`edit-diff.js:190`, multi-edit variant `192`); overlap error `edit-diff.js:251`; empty-`oldText` error `edit-diff.js:196-198`; no-op error `edit-diff.js:202`.
- Success message to the model: only `` `Successfully replaced ${edits.length} block(s) in ${path}.` `` (`edit.js:134`). A unified diff (4 lines context) and numbered diff lines exist but go into `details`, not the returned `content` (`edit.js:128-137`; `edit-diff.js:264-268,297-307`). Full file is never re-returned.
- Atomicity: all edits validated, then one `writeFile` per call (`edit.js:123-126`) — fail-before-write. No multi-file edit tool. Same-file concurrent tool calls are serialized through an in-process queue; different files run in parallel (`file-mutation-queue.js:23-50`).

### 4. write
- Create and overwrite share one code path: `"Creates the file if it doesn't exist, overwrites if it does"` (`write.js:25`). Parent dirs created via `mkdir(dir,{recursive:true})` (`write.js:18,44`). Result: `` `Successfully wrote to ${path}` `` (`write.js:50`), using the caller-supplied path string, not the resolved absolute path.

### 5. Staleness
Not found as a gate anywhere in `dist/core/tools` or `dist/core` (checked patterns `readBefore`, `stale`, `lastRead`, `fileHash`, `contentHash`, `changed since`, `must be read`). `edit.js:116` re-reads the file fresh inside `execute` every call. `readFiles`/`modifiedFiles` exist only as compaction-summary metadata (`dist/core/compaction/utils.js:48-54`), not a mutation gate. Partial vs full read is not distinguished for this purpose because there is no such gate.

### 6. Line endings / BOM / encoding
- Edit: BOM stripped for matching, re-prepended on write (`edit.js:119-125`; `utils/text.js:1-3`). Line-ending style detected from the first `\r\n` vs `\n` (`edit-diff.js:9-16`), matching happens on LF-normalized text, then the original style is restored on the changed region only (mixed-ending files keep a first-match rule) (`edit-diff.js:18-22`).
- Write: writes `content` as given, UTF-8, no BOM/CRLF/trailing-newline logic (`write.js:17`).
- Read: no BOM handling; splits only on `\n` so CRLF leaves a trailing `\r` on each displayed line (`read.js:96`).
- Non-UTF-8: decode/encode is UTF-8-only throughout (`read.js:95`, `edit.js:117`, `write.js:17`) — not preserved as another encoding.

### 7. Write mechanism
In-place `fs.writeFile(path, content, "utf-8")` (`write.js:17`; `edit.js:40`) — no temp file, no rename, no fsync, no chmod. Permission preservation: not found in tool source. Symlinks: not handled explicitly; `writeFile` follows the symlink per Node's default. Locking: an in-process promise chain keyed by canonical (realpath, falling back to resolve) path serializes same-file writes; not an OS-level lock (`file-mutation-queue.js:11-50`).

### 8. Permission/effect classification
Not found on the tool schemas — no `read-only`, risk, or approval field on `read`/`write`/`edit`/`ls`. A generic `ToolDefinition.executionMode` (`"sequential"|"parallel"`) exists (`dist/core/extensions/types.d.ts:364-371`) but none of these four tools set it. Registration only groups them: `createReadOnlyToolDefinitions` = read/grep/find/ls; `createCodingToolDefinitions` = read/bash/edit/write (`index.js:73-87`). Docs state pi "does not ask for approval before every tool call" and tools run with the OS permissions of the pi process (`docs/security.md:3`; `docs/how-pi-works.md:49`).

### 9. Directory listing
Separate tool, `ls` (`ls.js:25`). Default path `.`, default 500-entry cap, also a 50KB byte cap (`ls.js:16,27,91-92`). Output: one name per line, case-insensitive sorted, directories suffixed `/`, dotfiles included (`ls.js:62-83`); empty directory renders `(empty directory)` (`ls.js:87`); truncation notices at `ls.js:98,102`.

---

## codex

Commit `e72da2b53805894878023d01949a25a082e0a5cb`. **No first-party `read_file` or `list_dir` model tool exists** — file reads/listings reach the model only via shell commands (`cat`, `ls`, `git ls-files`, ...), which the harness merely *classifies* for UI purposes (`protocol/src/parse_command.rs:10-22`). The only file-content-mutating tool is `apply_patch`; the only other file-related tool is `view_image`.

### 1. Names and schemas
- **`apply_patch`**, registered only when `model_info.apply_patch_tool_type.is_some()` (`core/src/tools/spec_plan.rs:1269-1271`). Only one variant exists: `ApplyPatchToolType::Freeform` (`protocol/src/openai_models.rs:322-324`) — **there is no JSON function-schema variant**; not found anywhere in `codex-rs`, and the handler explicitly rejects non-`Custom` payloads (`core/src/tools/handlers/apply_patch.rs:332-336`). Freeform tool description (verbatim): `"The \`apply_patch\` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON."` (`apply_patch_spec.rs:20`; confirmed by binary `strings`). Format field: `type: "grammar"`, `syntax: "lark"` (`apply_patch_spec.rs:22-25`). Grammar (`core/assets/tools/apply_patch.lark:1-17`):
  ```
  start: begin_patch hunk+ end_patch
  begin_patch: "*** Begin Patch" LF
  end_patch: "*** End Patch" LF?
  hunk: add_hunk | delete_hunk | update_hunk
  add_hunk: "*** Add File: " filename LF add_line+
  delete_hunk: "*** Delete File: " filename LF
  update_hunk: "*** Update File: " filename LF change_move? change?
  change_move: "*** Move to: " filename LF
  change: (change_context | change_line)+ eof_line?
  change_context: ("@@" | "@@ " /(.+)/) LF
  change_line: ("+" | "-" | " ") /(.*)/ LF
  eof_line: "*** End of File" LF
  ```
  Multi-environment builds add an optional `*** Environment ID: ` line (`apply_patch_spec.rs:10-14`).
- **`view_image`** (JSON function tool), name `"view_image"` (`protocol/src/models.rs:1660`). Description: `"View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk."` (`view_image_spec.rs:44`). Params: `path` string required; `detail` enum `"high"|"original"` optional, default `"high"` (schema text and `DEFAULT_IMAGE_DETAIL`, `protocol/src/models.rs:936`), only present in the schema when a multi-detail feature flag is on; `environment_id` optional, multi-env builds only. `strict:false`, `additionalProperties:false` (`view_image_spec.rs:48`).

### 2. read_file-equivalent
No such tool. Internal FS read used by `apply_patch`/`view_image` (not model-facing): byte-read then UTF-8 decode, erroring on invalid UTF-8 (`file-system/src/lib.rs:649-658`); size cap `MAX_READ_FILE_BYTES = 512 * 1024 * 1024` (`exec-server/src/local_file_system.rs:45-50,629-637`). No line numbering, no offset/limit, no truncation message to the model — none of that machinery exists for a first-party read tool. Directory path: `apply_patch` delete on a directory → `"path is a directory"` (`apply-patch/src/lib.rs:737-741`); `view_image` on a directory → `` `image path `{path}` is not a file` `` (`view_image.rs:171-174`).
Images (via `view_image` only): loaded with `image::load_from_memory` (`view_image.rs:186-188`); returned as a data-URL image content item (`view_image.rs:239-255`); high-detail resize caps at 2048px/2500 patches, original-detail at 6000px/10000 patches (`utils/image/src/lib.rs:25-26,74-83`). No-vision-model error (verbatim, binary-confirmed): `"view_image is not allowed because you do not support image inputs"` (`view_image.rs:53-54,105-107`). Invalid/unsupported image bytes: `"unable to process image: invalid or unsupported image data"` (`view_image.rs:55-56,186-188`). PDF/notebook: not found — a non-raster file just fails the same "invalid or unsupported image data" path.

### 3. apply_patch matching/errors/atomicity
- Hunk markers are `@@`/`@@ <text>`, **not** unified-diff line numbers (`apply_patch.lark:15`; parser comment `parser.rs:116-117`).
- Locating a hunk: **first match** from the current scan position via `seek_sequence` (`file_update.rs:145-151,172`) — there is no uniqueness check and no "ambiguous match" error; two hunks targeting the same resolved path do fail, with `"multiple operations target {path}"` (`invocation.rs:235-239`).
- Fuzzy matching (`seek_sequence.rs:39-114`): exact → right-strip → trim both sides → Unicode punctuation/space normalization (dashes, quotes, NBSP → ASCII), plus a trailing-empty-line retry (`file_update.rs:155-170`).
- Errors (verbatim): `` `Failed to find context '{ctx_line}' in {path}` `` (`file_update.rs:109-111`); `` `Failed to find expected lines in {}:\n{}` `` (`file_update.rs:210-214`); empty patch → `"empty patch"` → `"patch rejected: empty patch"` (`safety.rs:73-76`; `apply_patch.rs:58-60`).
- Success (verbatim, binary-confirmed): stdout begins `"Success. Updated the following files:"` followed by `A`/`M`/`D` + path lines (`apply-patch/src/lib.rs:862-875`), wrapped in the generic exec-tool envelope (`Exit code:`/`Wall time:`/`Output:`, `core/src/tools/mod.rs:100-124`).
- Atomicity: **not transactional** — hunks apply sequentially; a failure partway through a multi-file patch leaves already-applied changes in place (`lib.rs:489-491,1109-1157`, confirmed by a failed-move test where the destination is written and the source still present).

### 4. Write/create via apply_patch
`*** Add File:` writes and **overwrites an existing file** if one is present (`apply-patch/tests/suite/tool.rs:349-361`). Missing parent directories are created recursively before retrying the write (`lib.rs:801-850`). Move overwrites its destination too (`tool.rs:326-344`).

### 5. Staleness
Not found. No session-read-set, mtime, or hash check before a patch is applied; verification simply reads the file's current bytes at apply time (`file_update.rs:34-45`). The model's system prompt tells it not to re-read after a patch (`protocol/src/prompts/base_instructions/default.md:143`) — that is guidance, not an enforced gate.

### 6. Line endings / BOM / encoding
Default mode normalizes to LF (`NormalizeToLf`, `apply-patch/src/lib.rs:64-67,79-85`; CRLF-in → LF-out test at `apply_patch_cli.rs:399-405`). A feature flag `apply_patch_preserve_line_endings` (default **off**, `features/src/lib.rs:1196-1199`) switches to preserving existing line endings and using the first existing ending for new lines (`text_file.rs:31-34,81-83`; CRLF-preserved test at `apply_patch_cli.rs:409-418`). NormalizeToLf mode always appends a trailing newline (`file_update.rs:64-67`); a file with no trailing newline gains one after an update (`apply_patch_cli.rs:630-647`). Non-UTF-8 files: `read_file_text` requires UTF-8 and errors otherwise (`file-system/src/lib.rs:649-658`). BOM: not found — no BOM-specific code in `apply-patch`.

### 7. Write mechanism
Not temp+rename. `follow_symlinks=true` path: plain `tokio::fs::write` (`exec-server/src/local_file_system.rs:663-664`). `follow_symlinks=false` path: `openat(WRONLY|CREATE|NOFOLLOW)`, truncate, write (`no_follow/unix.rs:122-143`); new files get mode `0o666` (umask-adjusted, `no_follow/unix.rs:131`); existing files are truncated in place, preserving their mode. Symlinks are followed by default (`lib.rs:72-85`) unless the runtime bypassed a required sandbox (`runtimes/apply_patch.rs:183-190`). Locking: `apply_patch` does not declare `supports_parallel_tool_calls`, defaulting to `false` (`tools/src/tool_executor.rs:122-124`) — no explicit file lock found.

### 8. Permission/effect classification
`apply_patch`: Guardian scope `FileChanges` (`protocol/src/openai_models/guardian.rs:154-158`); sandbox preference `Auto` with `escalate_on_failure:true` (`runtimes/apply_patch.rs:116-122`); a dedicated `assess_patch_safety` step returns AutoApprove/AskUser/Reject, with verbatim rejection text `"writing outside of the project; rejected by user approval settings"` and `"writing is blocked by read-only sandbox; rejected by user approval settings"` (`core/src/apply_patch.rs:28-60`; `safety.rs:13-16`); parallel calls disallowed by default. `view_image`: stable feature, default-enabled (`features/src/lib.rs:962-966`); not scoped under Guardian's `FileChanges`/`Shell` (falls to a generic `other_tools` bucket); `supports_parallel_tool_calls:true` (`view_image.rs:81-83`); flagged `is_builtin_control_tool:true` (`view_image.rs:218-221`).

### 9. Directory listing
Not its own tool. `ParsedCommand::ListFiles{cmd,path}` is purely a UI classifier applied to shell commands like `ls`/`git ls-files` (`protocol/src/parse_command.rs:19-22`; `shell-command/src/parse_command.rs:137-147`) — there is no dedicated listing schema, and output/truncation is whatever the executed shell command prints, subject to the generic exec-output truncation.

---

## Claude Code

Binary `~/.local/share/claude/versions/2.1.283` (newest installed; embedded `// Version: 2.1.283`), minified — names below are the minified identifiers found by `strings`/grep, quoted as they appear.

### 1. Names and schemas
- **Read** (`name:at`; `ruleContentField:"file_path"`): description `"Read a file from the local filesystem."`. Params: `file_path` string required; `offset` optional nonnegative int ("The line number to start reading from. Only provide if the file is too large to read at once"); `limit` optional positive int; `pages` optional string ("Page range for PDF files (e.g., \"1-5\", \"3\", \"10-20\"). Only applicable to PDF files. Maximum ${QRe} pages per request." with `QRe=20`). `isReadOnly(){return!0}`, `isConcurrencySafe(){return!0}`.
- **Write** (`name:wn`): description `"Write a file to the local filesystem."`. Params: `file_path` required (absolute); `content` required. Output includes `type:["create","update"]`, plus `structuredPatch`, `originalFile` (null for new files or when previous content was too large to include).
- **Edit** (`name:kt`): descriptions include `"Performs exact string replacements in files."`. Params: `file_path` required; `old_string` required; `new_string` required; `replace_all` boolean optional, default `false`. Input aliases coerced: `path`→`file_path`, `old_str`→`old_string`, `new_str`→`new_string`, `replace_name`→`replace_all`. Empty `old_string` is special-cased as a create.
- **NotebookEdit** (`name:tc`): `"Edit a cell in a Jupyter notebook — replace, insert, or delete."`. Params: `notebook_path` required (absolute); `cell_id` optional; `new_source` required; `cell_type` optional enum `["code","markdown"]`; `edit_mode` optional enum `["replace","insert","delete"]`, default `replace`.
- **MultiEdit**: no separate tool definition found in this binary (searched for `name:"MultiEdit"`). It survives only as a permission name (`var q2=["Write","Edit","MultiEdit","NotebookEdit"]`). The model-facing Edit schema takes one `old_string`/`new_string` pair (checked against this session's own Edit tool definition, 2026-09-26). An internal helper applies a list of `{old_string,new_string}` edits in order to a running buffer; that list is not a model argument.
- Separate embedded SDK-style tool set exists in the same binary with lowercase names `write`, `edit`, `glob` (different schemas, e.g. write: `"Write a UTF-8 text file relative to the workdir, creating parent directories as needed."`) — a second, simpler tool surface alongside the main CLI ones.
- **Glob** (`name:ro`) and **Grep** (`name:$r`) are separate tools from Read.

### 2. Read
- Line-number format (verbatim): `"Results are returned using cat -n format, with line numbers starting at 1"`; and, more precisely, `"Each line is the line number, a single separator (a tab or \`:\`), then the verbatim file content (including any leading whitespace)."`
- Default/max lines: `COt=2000`; `"Reads up to ${COt} lines by default."` No separate hard cap beyond a caller-supplied `limit` was found.
- Offset/limit: default `offset=1`; 1-based line numbers, `limit` in lines.
- Size caps: `A1e=262144` (256KB) default max size; `SB=10485760` (10MB) appears on a distinct branch. Error (verbatim): `"File content (${Ut(e)}) exceeds maximum allowed size (${Ut(n)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file."`
- Token cap: `yLr=25000` tokens, override env var `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`; `_Lr=128` chars-per-token heuristic; error `"File content (${e} tokens) exceeds maximum allowed tokens (${t}). ..."`. Output carries a flag documented as: `"True when a whole-file read was auto-paginated because it exceeded the token cap (the content is a partial first page)."`, with banner prefix `"[Truncated: PARTIAL view — "`.
- Long-line cut: no fixed numeric per-line truncation length found; instead the tool tells the model: `"this file's lines are too long for Read's offset/limit chunking. If a shell tool is available, slice by character range (e.g. python read()[A:B], dd, or cut -c) instead."`
- Empty file: `"<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"`. Offset past EOF: `` `Warning: the file exists but is shorter than the provided offset (${e.file.startLine}). The file has ${e.file.totalLines} lines.` ``.
- Dedup: `"File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading."`
- Images: `"Reads images (PNG, JPG, …) and presents them visually."`; formats enum `["image/jpeg","image/png","image/gif","image/webp"]`; output includes base64 data, MIME type, and post-resize displayed width. Error: `"File has an image extension but its content is not a valid PNG/JPEG/GIF/WebP. Detected: ["`; CMYK JPEG explicitly rejected: `"it is a CMYK JPEG, which Claude Code cannot decode"`. No "model doesn't support images" string was found for Read specifically (unlike pi and codex, which both have one).
- PDF: `"This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: \"1-5\")."`; max 20 pages/request (`QRe=20`), 1-indexed pages; error `` `Page range "${e}" exceeds maximum of ${QRe} pages per request. Please use a smaller range.` ``.
- Notebooks: `"This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations."`
- Other binary: `"This tool cannot read binary files. The file appears to be a binary ${W} file. Please use appropriate tools for binary file analysis."`; device files: `"Cannot read '${g}': this device file would block or produce infinite output."`
- Directory path: `"This tool can only read files, not directories. To list files in a directory, use the registered shell tool."` (implementation-level fallback: `` `EISDIR: illegal operation on a directory, read '${e}'` ``).

### 3. Edit / MultiEdit
- Uniqueness (verbatim): `` `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (${w}) before matching.`` and `"The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`."`
- `replace_all`: boolean, default `false`; `"Use \`replace_all\` for replacing and renaming strings across the file."`
- Fuzzy/whitespace matching: **not found** as documented match semantics (prompt insists on an exact match including indentation). One retry note exists though: `"(note: Edit also tried swapping \uXXXX escapes and their characters; neither form matched, so the mismatch is likely elsewhere in old_string. Re-read the file and copy the exact surrounding text.)"` — a narrow escape-form retry, not general fuzzy matching.
- No-match error: `"String to replace not found in file."`
- Multiple-matches error: `` `Found ${Fe} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.` ``
- Success text: `` `The file ${r} has been updated successfully${W}.${q}${ge}` `` (replace_all variant: `"...All occurrences were successfully replaced...`"). Output schema includes a diff patch and the original file contents — so the model is shown a diff, not the whole file, on success.
- No-op guard: `"No changes to make: old_string and new_string are exactly the same."`
- Size cap: `` `File is too large to edit (${Ut(He)}). Maximum editable file size is ${Ut(X4t)}.` `` with `X4t=1073741824` (1GB).
- MultiEdit-specific sequencing error: `"Cannot edit file: old_string is a substring of a new_string from a previous edit."` — implies edits within one call are applied in order against a running buffer (not all against the pristine original, unlike pi). Cross-file atomicity language: not found.

### 4. Write
- `"Writes a file to the local filesystem, overwriting if one exists."`; `"This tool will overwrite the existing file if there is one at the provided path."`
- Read-before-write is enforced (see §5): `"If this is an existing file, you MUST use the ${at} tool first to read the file's contents. This tool will fail if you did not read the file first."`
- Parent-directory creation: **not found** in the main Write tool's own description/code; only the separate lowercase SDK-style `write` tool documents and performs it (`"...creating parent directories as needed."`, `mkdir(dirname,{recursive:true})`).
- Non-regular-file target: `` `${g} exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.` ``; directory target: `` `${g} is a directory, not a file. To create a file inside it, include the file name in file_path.` ``
- Result text: create → `` `File created successfully at: ${e}${D}${F}${W}` ``; update → `` `The file ${e} has been updated successfully.${D}${F}${W}` ``.

### 5. Staleness
Enforced, with several exact error strings:
- `"File has not been read yet. Read it first before writing to it."`
- `"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it."`
- Multi-host variants: `` `File has been modified on ${e} since this session read it. Read it again there (Read with "_host": "${e}") before attempting to write it.` ``

Comparison is **mtime vs a stored read timestamp**, with an optional content/hash fallback: `if(await bS(D)>W.timestamp)` (mtime newer than recorded read time triggers the error); a hash helper `S(e){return{sha256:...,bytes:...}}` and `HMt` (byte-length + sha256 match) sit next to the write path as a recovery check — `if(!(await bS(n)>s.timestamp))return; if(sD(s)&&SH(s,Db(r)))return; throw ...` — i.e. mtime is checked first, and if it looks stale, a content/hash match can still let it through. Read tracking distinguishes partial reads: `if((e.offset??1)>1||e.isPartialView)return!1` — only a full-file read satisfies the "read it" requirement for the fast path.

### 6. Line endings / BOM / encoding
- Detection: UTF-16LE BOM (`0xFF 0xFE`) and UTF-8 BOM (`0xEF 0xBB 0xBF`) bytes are both checked, but UTF-8-BOM is still labeled `"utf8"` in the detector (`function Bgn`).
- Line-ending detection: majority vote of trailing `\r` per line → `"CRLF"` or `"LF"` (`function jgn`).
- Read strips `\r` from displayed content (`content:c.replaceAll('\r'...)`); Write uses a different writer when the detected style is CRLF (`Bt==="utf8"&&St!=="CRLF")kle(...):Pg(...)`), implying CRLF files get their line endings restored on write.
- Trailing newline: only used for content-equivalence comparisons (`e.content.replace(/\n+$/,"")===n.content.replace(/\n+$/,"")`), plus a Read-side note: `"the last has no trailing newline, so \`wc -l\` reports ${e-1} — Read through line ${e} and leave the file as it is"`.

### 7. Write mechanism
- **Atomic temp+rename**, staged in a directory `var UD=".cc-writes"`, temp filename `` `.tmp.${process.pid}.${J(6).toString('hex')}` ``. Logged as `` `File ${i} written atomically` `` / `` `Failed to write file atomically: ${c}` ``.
- Symlinks: **refused**, not followed: `` `Refusing to write through symlink: ${e}. Resolve the symlink and pass the real target path explicitly.` `` and an O_NOFOLLOW variant. Reading through a symlink logs (but allows) it: `` `Reading through symlink: ${n} -> ${r}` ``.
- Hard links: **refused** in-place rewrite when a file has multiple names on disk: `"Could not rewrite ${e} in place: this file has other names on disk (it is hard-linked, ${t} names in all), and writing it in place would change the file under every one of those names. Remove the extra links, then try again."` — the only one of the four agents with hard-link-aware protection.
- Permissions: explicitly preserved/set — `"Preserving file permissions: ${o.toString(8)}"`, `"Setting permissions for new file: ${o.toString(8)}"`.
- Locking as a Write/Edit feature: not found (only `.git/index.lock`, which is git's own lock, unrelated).

### 8. Permission/effect classification
- Permission-settings integration exists at the tool level: `"File is in a directory that is denied by your permission settings."`; `"File is covered by a Read deny rule in your permission settings and cannot be edited."` / `"...cannot be written."`
- `Read.isReadOnly(){return!0}`, `isConcurrencySafe(){return!0}` are set; no equivalent `isReadOnly`/`isDestructive` literal was found set on Write/Edit/NotebookEdit definitions themselves (a generic MCP-style annotation schema with `readOnlyHint`/`destructiveHint`/`openWorldHint`/`idempotentHint` exists in the binary but wasn't found attached to these tools).
- `filePatternTools:["Read","Write","Edit","Glob","NotebookRead","NotebookEdit","Cd"]` is the group whose paths get checked against permission rules; a note clarifies MultiEdit-shaped calls route through the same Edit(path) check.

### 9. Directory listing
Separate tools, not folded into Read: **Glob** (`"Fast file pattern matching. Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\". Returns matching file paths sorted by modification time."`, truncated to 100 files) and **Grep**. A bare `"LS"` name appears only in permission-rule sets (`cn=new Set([...filePatternTools,$r,"MultiEdit","LS"])`) with **no actual `name:"LS"` tool definition found** — likely a vestigial/legacy name kept in a permission list after LS was folded into Glob, or an internal alias not exposed as a callable tool in this build.

---

## fiber-zig (owner's archived Zig agent)

Cloned `aakshintala/fiber-zig`. Tool names: `read_file`, `write_file`, `edit_file` (`src/builtins/tools.zig:284-373`). `write_file.call`/`edit_file.call` in the tool-stub files **do not perform the mutation themselves** — they return an authorization-required placeholder (`write_file.zig:123-130`, `edit_file.zig:148-155`); actual mutation logic lives in `src/core/tooling/file_mutation.zig` and `file_mutation_execution.zig`, governed by the shared contract in `file_mutation_contract.zig`.

### 1. Names and schemas
- **read_file** (`read_file.zig:22-25`): `path: []u8` required; `start_line: usize = 1` optional (1-based, default 1); `line_count: usize = default_max_read_file_lines` optional (default 400, `tool_dispatch.zig:49`; decode clamps to a hard max of 2000, `read_file.zig:16,66`). Model-facing schema requires only `["path"]`.
- **write_file** (`write_file.zig:9-11`): `path: []u8`, `content: []u8`, both required, no defaults. Content prep cap `4 * 1024 * 1024` bytes (`write_file.zig:6,114-118`). Contract twin: `file_mutation_contract.zig:504-507`.
- **edit_file** (`edit_file.zig:9-12`): `path`, `old_string`, `new_string`, all required `[]u8`. **No `replace_all` field** — a schema test explicitly asserts its absence (`builtins/tools.zig:1217`). Schema text: `"Exact text to find in the file. Must match exactly once."` (`builtins/tools.zig:353`).

### 2. read_file
- Output format (verbatim structure, spot-checked): `` `<path>notes/today.txt</path>\n<content>\n1\thello\n</content>` `` (`read_file.zig:512`) — i.e. `<path>{rel}</path>\n<content>\n` then per line `{number}{pad}\t{text}\n`, then `</content>` (`read_file.zig:350-378`).
- Offset/limit: 1-based **lines**, not bytes. Default `start_line=1`; default `line_count=400`, capped further per-call to `ctx.max_read_file_lines` (also 400 by default, `tool_dispatch.zig:49,208`).
- Other caps: decode-time max `line_count` 2000 (`read_file.zig:16`); snapshot read cap 10MB (`max_snapshot_file_bytes`, `read_file.zig:12,142-143`); model-output byte budget 256KB (`max_model_output_bytes`, `read_file.zig:14,262-265`); per-line clip 2000 chars (`max_read_file_line_len`, `tool_dispatch.zig:50,209`). Note: a separate `default_max_read_file_bytes=50*1024` constant exists (`tool_dispatch.zig:48`) but is **not referenced** by `read_file.zig` — dead/unused for this path.
- Truncation messages (exact, verbatim): `"... (line truncated)"` (long line); `"... [showing {d} of {d} lines; use start_line/line_count to read more.]\n"`; `"... [showing {d} of at least {d} lines; file snapshot was capped before EOF.]\n"`; `"... [start_line {d} is beyond end of file; total lines {d}]\n"`.
- Images/PDF/notebook: **not found** in `read_file.zig`/`write_file.zig`/`edit_file.zig`/`text_utils.zig` (checked for `image/png`, `resize`, `pdf`, `notebook`, `.ipynb`). Images are handled by a wholly separate `vision` tool (`builtins/tools.zig:214-215`; `ExecutorKind.vision`, `tool_dispatch.zig:389`) — read_file never touches them.
- Binary/non-UTF-8: `text_utils.isModelSafeText` rejects NUL bytes or invalid UTF-8; the tool then returns `` `<path>{s}</path>\n<content>binary or non-utf8 file omitted ({d} bytes)</content>` `` (`read_file.zig:153-161`) — and, notably, the read tracker's hash/mtime record is **skipped** for that path.
- Directory path: opened with `.no_follow`, mapped to a `NotRegularFile` error, with message `"read_file requires a regular file"` and suggestion `"Use glob_files to inspect directory contents, then choose a regular file."` (`read_file.zig:130-133,184-195`).

### 3. edit_file
- Format: single exact byte-string replace, one occurrence, one file, no patch/hunk format, no multi-edit. Matching via `std.mem.find` on raw bytes, non-overlapping (`file_mutation.zig:1444-1495`).
- No `replace_all`; no fuzzy/whitespace/Unicode normalization anywhere in the match path — checked `edit_file.zig` and `file_mutation.zig` for NFC/NFD/trim/CRLF-folding, none found. A `normalizeLineEndingsInPlace` helper exists in `text_utils.zig:71` but is **not called** from any of the filesystem tool files.
- Errors (verbatim): `"edit_file failed: old_string and new_string are identical"` (`file_mutation.zig:1438`); `"edit_file failed: old_string not found in file"` (`1446`); `"edit_file failed: old_string is not unique (found {d} occurrences), provide more context"` (`1451`); identity-changed guard `"file mutation preparation failed: approved filesystem identity changed"` (`132-133,1361-1363,1440-1441`).
- Success shown to the model is **not a diff** — just `` `{s} {s} ({d} bytes)` `` (e.g. `"edited path (N bytes)"`, `file_mutation_execution.zig:167-174`). A structured diff (with `old_line`/`new_line` ops) exists only as an approval/UI preview (`file_mutation.zig:259-263,1537-1548`; `file_mutation_contract.zig:588-590`), never returned to the model. No-op guard: `"No changes to {s}; it already contains the requested content"` (`file_mutation_execution.zig:79-86`).
- Atomicity: one path per call by contract (`file_mutation_contract.zig:515-522`); staged then `rename`d as a single unit (`file_mutation.zig:618-623`). There is no multi-edit or multi-file transaction to be atomic across.

### 4. write_file
- `"Create or overwrite a file using complete contents"` (`builtins/tools.zig:40`); `permission_target_kind = .path_create_parent`.
- Missing parent directories are created during apply (`createDir(...,.default_dir)`, `file_mutation.zig:879-886`); an existing target is read as the preimage and fully replaced.
- Result text: `"wrote {path} ({d} bytes)"` (success) / `"No changes to {s}; it already contains the requested content"` (no-op).

### 5. Staleness
Does **not** gate on "was this file read this session" — grepped `write_file.zig`, `edit_file.zig`, `file_mutation.zig`, `file_mutation_execution.zig`, `tool_admission.zig` for `ReadTracker`/`lookup`: no references outside `read_file.zig`'s own tests. `read_file` does *record* an mtime + SHA-256 content hash per read (`read_file.zig:322-336`; `read_tracker.zig:12-20`), and a comment there claims it's `"used by read-before-overwrite checks"` (`read_tracker.zig:62`) — but no such consumer exists in the mutation path, so this is dead/aspirational wiring.

What **is** enforced is a "changed since preview" check at *apply* time (not "changed since read"): the mutation contract carries an `expected` preimage (SHA-256 `content_hash` + `FileIdentity{device,inode,kind}` + size + mode); apply time re-derives all of these from disk and rejects on mismatch with reason `.stale_preimage` and exact text `"file mutation rejected because the file changed after preview; make a new tool call for a fresh preview"` (`file_mutation.zig:985-1021,51,487,554`; `file_mutation_execution.zig:257`). **mtime is not part of that comparison** — only content hash, device/inode/kind, size, and permission mode are.

### 6. Line endings / BOM / encoding
No CRLF/BOM/trailing-newline normalization anywhere in the filesystem tool or mutation files (checked for `BOM`, `efbbbf`, `CRLF`, and calls to `normalizeLineEndingsInPlace`: none). Read splits only on `\n`, so CRLF files show a trailing `\r` in displayed lines. Write/edit copy argument/preimage bytes through unchanged. Non-UTF-8: read refuses to show content (see §2); write/edit have no UTF-8 validation of their own, so invalid UTF-8 can still be written if it survived JSON decoding.

### 7. Write mechanism
**Atomic temp+rename**, the most explicit of the four: temp name is `".fiber-stage-"` + 32 hex chars, created exclusively with the destination's (or default) permission mode, written, `syncFile`'d, then `rename`d onto the target (`file_mutation.zig:491-533,618-623`). Symlinks are never followed during preimage stat/open or path traversal (`follow_symlinks=false` throughout, `file_mutation.zig:1359,987-989,839,860`; read also uses `.no_follow`, `read_file.zig:130`). Existing file mode is copied onto the staged file; new files get a default mode; new directories get a default mode. Locking: no OS file lock, but a per-prepared-mutation atomic "commit claim" bool prevents double-committing the same prepared mutation object (`file_mutation.zig:168-170,603-612`); across separate tool calls, only a leading read-only prefix of a batch runs in parallel — `write_file`/`edit_file` calls are never treated as read-only and so are excluded from that parallel window (`parallel_execution.zig:16-36,472-490`).

### 8. Permission/effect classification
Explicit per-tool classifier fields (not a single risk enum):

| Tool | activity_kind | requires_approval | permission_target_kind | reads_only | irreversible |
|---|---|---|---|---|---|
| read_file | `.read` | `false` | `.path_existing` | `true` | `false` |
| write_file | `.write` | `true` | `.path_create_parent` | `false` | `true` |
| edit_file | `.edit` | `true` | `.path_existing_parent` | `false` | `true` |

(`builtins/tools.zig:299-413`; `read_file.zig:406-413`; `write_file.zig:134-141`; `edit_file.zig:159-166`.) This is the only one of the four agents with a structured, per-tool machine-readable permission/effect declaration.

### 9. Directory listing
Not its own dedicated tool file (no `list_dir.zig`/`ls.zig` exists). The listing role is filled by `glob_files` (`activity_kind=.list`, `builtins/tools.zig:219-247`), and `read_file`'s own directory-rejection message explicitly points there: `"Use glob_files to inspect directory contents, then choose a regular file."` Output: `` `[glob] {d} matches for {s}\n` `` then one `" - {s}\n"` line per path; empty → `` `[glob] no matches for {s}\n` ``; a count-only mode; truncation `"... truncated to first {d} matches\n"`.

---

## Comparison table

| | pi | codex | Claude Code | fiber-zig |
|---|---|---|---|---|
| **Read: own tool?** | Yes (`read`) | No — shell only | Yes (`Read`) | Yes (`read_file`) |
| **Line numbers in read output** | None | N/A | `cat -n`-style: number + tab/`:` + text | `{number}{pad}\t{text}` inside `<content>` |
| **Offset/limit units** | 1-based lines | N/A | 1-based lines | 1-based lines |
| **Default read lines** | up to 2000 or 50KB | N/A | up to 2000 | 400 (hard cap 2000) |
| **Read byte/size cap** | 50KB (`DEFAULT_MAX_BYTES`) | N/A | 256KB default, 10MB on another branch, 25000-token cap | 10MB snapshot, 256KB model-output budget |
| **Image tool** | folded into `read` | separate `view_image` | folded into `Read` | separate `vision` tool |
| **No-vision-model message** | yes, explicit | yes, explicit | not found | N/A (separate tool, not checked) |
| **PDF support** | not found | not found | yes, `pages` param, 20-page cap | not found |
| **Notebook support** | not found | not found | yes (`.ipynb`, all cells+outputs) | not found |
| **Directory-passed-to-read** | unhandled `EISDIR` bubble | N/A (no read tool) | explicit refusal message | explicit refusal + points to listing tool |
| **Edit format** | multi-block exact replace (one call, one file) | patch grammar (`apply_patch`, Lark, hunks) | single exact replace + `replace_all` flag | single exact replace, exactly one occurrence |
| **Uniqueness enforcement** | yes, per block | no — first-match, no ambiguity error | yes, unless `replace_all` | yes, always (no `replace_all` at all) |
| **Fuzzy/whitespace matching on edit** | yes (NFKC, quote/dash/space folding) | yes (rstrip, trim, Unicode punct/space fold) | no (exact only; narrow `\uXXXX` escape retry) | no |
| **Edit success shown to model** | text count only; diff goes to UI-only `details` | stdout `Success...` + changed-file list | diff patch + original content in output schema | plain text `"edited path (N bytes)"`; diff is UI-preview only |
| **Multi-edit atomicity (same file)** | validate-all-then-write-once | sequential hunks, no rollback on mid-patch failure | one block per call; internal helper applies edits in order to a running buffer | N/A — one edit per call by design |
| **Write: create dirs?** | yes, recursive | yes, recursive (apply_patch Add) | not found on main Write; yes on secondary SDK `write` tool | yes, during apply |
| **Read-before-write/edit gate** | not found (no gate) | not found (no gate) | **yes** — mtime vs stored read-timestamp, with content-hash fallback | **no** read-before-write gate; separate "changed since preview" hash+identity check at apply time |
| **Write mechanism** | in-place `writeFile`, no temp/rename | in-place write or `O_NOFOLLOW` truncate-write; no temp/rename | atomic temp+rename (`.cc-writes`, `.tmp.<pid>.<hex>`) | atomic temp+rename (`.fiber-stage-<hex>`), with `syncFile` |
| **Symlink handling on write** | unhandled (Node follows by default) | follows unless sandbox bypass | **refuses** to write through a symlink | never follows (`follow_symlinks=false`) |
| **Hard-link handling** | not found | not found | **refuses** in-place rewrite of multiply-linked files | not found |
| **Line-ending handling** | detect + restore per matched edit region | normalize to LF by default; feature-flagged preserve mode | detect majority CRLF/LF, separate writer path for CRLF | none — passthrough, CRLF leaves `\r` in read output |
| **BOM handling** | stripped for edit matching, re-added on write | not found | detected (both UTF-8 and UTF-16LE BOM bytes) but UTF-8 BOM still labeled `"utf8"` | not found — passthrough |
| **Non-UTF-8 files** | forced UTF-8 decode/encode (lossy) | requires UTF-8, errors otherwise | not found in citations gathered | read refuses and omits content; write/edit have no check |
| **Permission/effect classification per tool** | none found (only broad read-only vs coding tool grouping) | Guardian scope (`FileChanges`) + sandbox policy + approval assessment on `apply_patch` | permission-rule integration (`filePatternTools`, deny-rule messages) but no `isReadOnly`/`isDestructive` literal on Write/Edit | explicit struct fields per tool: `activity_kind`, `requires_approval`, `permission_target_kind`, `reads_only`, `irreversible` |
| **Directory listing** | separate `ls` tool | not a tool — shell-command classifier only | separate `Glob`/`Grep` (no standalone `LS` tool def found; name survives only in permission lists) | separate `glob_files` tool (no `list_dir`/`ls` file exists) |

## Surprises

1. **Codex has no first-party file-read or file-listing tool at all.** Every "read a file" or "list a directory" action the model can see is really a shell command (`cat`, `ls`, `git ls-files`, ...) that the harness merely labels for its own UI (`protocol/src/parse_command.rs:10-22`); there is no line-numbering, no offset/limit, no truncation contract, no image/PDF/notebook handling outside of the dedicated `view_image` tool. This is a materially different shape from the other three agents and worth deciding explicitly for fiber rather than assuming Codex has an equivalent to compare against.
2. **`apply_patch` has only ever had a freeform/Lark-grammar variant, never a JSON function-schema variant** — the JSON variant this task asked to compare does not exist in `codex-rs` at all (checked exhaustively; the handler code path actively rejects non-freeform payloads).
3. **`apply_patch` is not transactional across hunks or files in one patch call.** A patch that fails partway through leaves already-applied changes on disk (confirmed by a repo test where a failed move leaves the destination written and the source still present) — the opposite of pi's and fiber-zig's "all-or-nothing" per-call behaviour.
4. **Claude Code's staleness check compares mtime against a stored read-timestamp, not a content hash**, and it has a *content-hash fallback* that can let a write through even when mtime looks stale — i.e. mtime is the primary signal, hash is the escape hatch, not the other way around. It's also the only one of the four agents with a read-before-write/edit gate at all; pi, codex, and fiber-zig all allow writing/editing without having read the file first.
5. **fiber-zig's "read-before-overwrite" comment is aspirational, not real.** `read_tracker.zig:62` explicitly claims its content hash is "used by read-before-overwrite checks," but no code in the mutation path actually consults `ReadTracker.lookup` — the real staleness protection in fiber-zig is a completely different mechanism (changed-since-*preview*, checked at apply time via content hash + device/inode/kind + size + mode, not mtime, and not gated on having read the file at all).
6. **Claude Code is the only agent with hard-link-aware write protection** — it explicitly refuses to rewrite a file in place if it has multiple hard-linked names, to avoid silently changing content under every other name. None of pi, codex, or fiber-zig mention hard links.
7. **Fuzzy/whitespace-tolerant matching on edits is a two-two split, not universal.** pi and codex (independently) both normalize Unicode punctuation/dashes/quotes/spaces as a fallback after an exact match fails; Claude Code and fiber-zig both require an exact byte-for-byte match with no such fallback (Claude Code has only a narrow retry for `\uXXXX` escape-vs-literal-character mismatches).
8. **MultiEdit is no longer a standalone tool in Claude Code 2.1.283.** The model-facing Edit is one `old_string`/`new_string` pair, so a multi-block change takes several Edit calls. pi is the only one of the four whose model-facing edit takes a list of blocks.
9. **fiber-zig is the only agent with a fully typed, machine-readable per-tool permission/effect declaration** (`activity_kind`, `requires_approval`, `permission_target_kind`, `reads_only`, `irreversible` as real struct fields) — the other three agents express permissioning as prose in tool descriptions, ad hoc grouping arrays, or scattered error-message text, not as a schema the tool itself carries.
10. **A vestigial `"LS"` string survives in Claude Code's permission-rule sets with no corresponding tool definition** — evidence that directory listing was folded into Glob at some point but the old name wasn't fully cleaned out of every reference.
