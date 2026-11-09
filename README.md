# dsh-obsidian-vault

Obsidian vault tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

An Obsidian vault is a folder of Markdown files. This plugin lets the agent work
on that folder directly: read and search notes, create and edit them, manage YAML
frontmatter, query by tag, and rename notes without breaking the `[[wikilinks]]`
that point at them. Obsidian does not need to be running and no Obsidian plugin
is required.

## Install

```sh
dsh plugin --profile web add dsh-obsidian-vault
```

Or straight from GitHub:

```sh
dsh plugin --profile web add github:jinferth/dsh-obsidian-vault
```

Restart the profile, then confirm the tools loaded:

```sh
dsh --profile web --dump-config
```

## Configure the vault

The vault is resolved automatically:

1. `config.vaultPath` in `cordis.patch.yml`
2. the `OBSIDIAN_VAULT` environment variable
3. the vault Obsidian last opened, read from its own registry
   (`%APPDATA%\obsidian\obsidian.json` on Windows,
   `~/Library/Application Support/obsidian/obsidian.json` on macOS,
   `$XDG_CONFIG_HOME/obsidian/obsidian.json` on Linux)

To pin one vault, add a config block:

```yaml
- insert:
    - id: obsidian-vault
      name: dsh-obsidian-vault
      config:
        vaultPath: '/home/me/Obsidian'
        maxResults: 200
```

`maxResults` (default 200) caps how many notes `obsidian_list` and
`obsidian_search` return at once.

## Tools

| Tool | What it does |
|---|---|
| `obsidian_info` | Absolute vault path, whether it exists, note count. Call this first when unsure which vault is connected. |
| `obsidian_list` | List notes, optionally limited to a folder or filtered by a glob (`Projects/**`, `*.md`). |
| `obsidian_read` | Read one note by vault-relative path; `.md` may be omitted. Line numbers match `obsidian_edit`. |
| `obsidian_search` | Search note titles and bodies, literally or with `regex`. |
| `obsidian_new` | Create a note with optional frontmatter. Refuses to overwrite an existing note. |
| `obsidian_append` | Append Markdown to the end of a note, creating it when absent. |
| `obsidian_edit` | Four modes: `replace` (literal, must be unique unless `replaceAll`), `replaceLines`, `insertLines`, `deleteLines`. |
| `obsidian_frontmatter` | `get` / `set` / `delete` one frontmatter key without touching the body. |
| `obsidian_query` | Find notes by frontmatter properties, tags and path; tags are ANDed. |
| `obsidian_move` | Move or rename a note and, by default, rewrite every wikilink in the vault that points at it. |
| `obsidian_delete` | Move a note into the vault's `.trash` folder instead of unlinking it. |
| `obsidian_insert_image` | Copy an image into the vault and reference it from a note. |
| `obsidian_batch` | Run several of the above as one transaction: if any step fails, earlier steps are rolled back. |

## Safety behaviour

- **Paths stay inside the vault.** Absolute paths and `..` traversal are rejected
  with a `VaultPathError`, so a malformed tool call cannot touch the rest of the
  disk.
- **Application state is off limits.** `.obsidian/`, `.trash/` and `.git/` are
  never listed, searched or written.
- **Writes are atomic.** Content goes to a temporary file which is then renamed
  over the target, so an interrupted run cannot truncate a note.
- **Encoding is preserved.** A CRLF file stays CRLF and a BOM stays a BOM; an
  edit does not turn one field into a whole-file diff in Git.
- **Deletion is recoverable.** `obsidian_delete` moves the note into `.trash`.

## Compatibility with DeepSeek Harness releases

Harness is in developer preview and its plugin API may change. This plugin is
built to survive that:

- **It imports nothing from `@deepseek-ai/*`.** All imports are Node built-ins.
  There is no dependency range that a Harness release can invalidate, and no
  lockfile to drift.
- **It touches exactly one host surface:** `ctx.tools.register(definition)`.
  Tool schemas are plain data objects, not values produced by a version-pinned
  helper such as `defineTool`.
- **It degrades instead of throwing.** If the tool registry is missing, or the
  host rejects one definition, the plugin logs a message naming the contract it
  expected and keeps the rest of the profile running. It never fails the boot.
- **No vault configured is not a crash.** Tools explain how to configure one
  instead of throwing during load.

If a future release does change the tool contract, the failure mode is a
`[dsh-obsidian-vault] ...` line in the log naming what broke, not a dead profile.

## Tests

```sh
npm test
```

Runs 25 checks against a throwaway vault: tool registration, create/read/edit,
frontmatter fidelity, CRLF and BOM preservation, wikilink rewriting on move,
`.trash` deletion, path-escape rejection, and the compatibility behaviour above.
No network, no Obsidian, no real vault.

## 中文速览

把 Obsidian 笔记库交给 Agent 操作：列出、检索、新建、按行号片段编辑、读写
frontmatter、按标签查询；重命名笔记时自动改写全库双链；删除进 `.trash` 可恢复。
写入是原子的，保留 CRLF 与 BOM。插件不导入任何 `@deepseek-ai/*` 包，只调用
`ctx.tools.register`，因此 Harness 升级不会因依赖版本范围把插件打挂；即使宿主
接口变动，也只是日志里出现一行提示，不会让 profile 起不来。

装好后如果提示未配置库：在 Obsidian 里打开一次库，或设置 `OBSIDIAN_VAULT`，
或在 `cordis.patch.yml` 里写 `config.vaultPath`。

## License

MIT
