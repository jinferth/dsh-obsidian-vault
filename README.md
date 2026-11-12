# dsh-obsidian-vault

Obsidian vault tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

An Obsidian vault is a folder of Markdown files. This plugin lets the agent work
on that folder directly: read and search notes, create and edit them, manage YAML
frontmatter, query by tag, and rename notes without breaking the `[[wikilinks]]`
that point at them. Obsidian does not need to be running and no Obsidian plugin
is required.

## Install

Install from this repository:

```sh
dsh plugin --profile web add github:jinferth/dsh-obsidian-vault
```

> **Install by GitHub path.** The package is named `@jinferth/dsh-obsidian-vault`
> and is not published to npm, while the unscoped name `dsh-obsidian-vault` is
> already taken there by an unrelated plugin by another author. Installing by the
> bare name would fetch that project instead. Use the `github:` form above, or a
> tarball from a release.

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
      name: '@jinferth/dsh-obsidian-vault'
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
| `obsidian_list` | List notes, optionally limited to one folder. Returns path, size and modification time. |
| `obsidian_read` | Read one note by vault-relative path; `.md` may be omitted. |
| `obsidian_search` | Literal, case-insensitive search; returns each hit as path plus line number. |
| `obsidian_new` | Create a note with optional body, `tags` (comma-separated) and `properties` (JSON object string). Refuses to overwrite. |
| `obsidian_append` | Append Markdown to the end of a note, creating it when absent. |
| `obsidian_edit` | Replace one literal string (unique unless `replaceAll`), or replace lines `fromLine`..`toLine` with `content`. |
| `obsidian_frontmatter` | `get` / `set` / `delete` one frontmatter key without touching the body or other keys. |
| `obsidian_query` | Find notes by tag, by a frontmatter key, and/or inside one folder. Tags are ANDed. |
| `obsidian_move` | Move or rename a note and rewrite the wikilinks pointing at it. Links change only when the file name changes. |
| `obsidian_delete` | Move a note into the vault's `.trash` folder; `permanent` unlinks instead. |
| `obsidian_insert_image` | Copy an image into the vault and return the embed snippet, optionally appending it to a note. |
| `obsidian_batch` | Run several of the above in order from a JSON step list, stopping at the first failure. |

Parameters are deliberately plain: `tags` is a comma-separated string, `properties`
and `steps` are JSON strings. Arrays and objects are kept out of the schema on
purpose — see the wire-format note below.

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

## Wire format

Tool schemas are kept to the minimum every provider accepts, which is a
correctness requirement rather than a style choice:

- `parameters` is `{ type: 'object', properties, required }` and nothing else —
  no `enum`, no `additionalProperties`, no array- or object-valued properties;
- no `output` block is declared;
- descriptions stay short.

A reverse proxy that validates the tool contract more strictly than the harness
does will reject the **whole request** with HTTP 400 when any tool schema falls
outside what it accepts. That failure is not scoped to the offending tool: every
turn fails, including turns that never touch this plugin. The test suite pins
these rules so a later edit cannot quietly reintroduce the richer schemas.

## Tests

```sh
npm test
```

Runs 39 checks against a throwaway vault: wire-format conformance, create/read/
edit, frontmatter fidelity, CRLF and BOM preservation, wikilink rewriting on move,
`.trash` deletion, path-escape rejection, and the host-fault behaviour above. No
network, no Obsidian, no real vault.

## 中文速览

把 Obsidian 笔记库交给 Agent 操作：列出、检索、新建、按行号片段编辑、读写
frontmatter、按标签查询；重命名笔记时自动改写全库双链；删除进 `.trash` 可恢复。
写入是原子的，保留 CRLF 与 BOM。插件不导入任何 `@deepseek-ai/*` 包，只调用
`ctx.tools.register`，因此 Harness 升级不会因依赖版本范围把插件打挂；即使宿主
接口变动，也只是日志里出现一行提示，不会让 profile 起不来。

工具参数只用最简的 JSON Schema（`type` / `properties` / `required`），不用
`enum`、`additionalProperties`，参数里不出现数组与对象，也不声明 `output`。
这不是洁癖：经过会校验工具契约的反向代理时，任何一处越界的关键字都会让**整个
请求**被 400 拒绝——连带那些根本没用这个插件的对话一起失败。

安装请用 GitHub 路径：

```sh
dsh plugin --profile web add github:jinferth/dsh-obsidian-vault
```

不要用裸包名 `dsh-obsidian-vault`——npm 上那个同名包属于另一位作者，是无关的插件。
本包的包名是 `@jinferth/dsh-obsidian-vault`，尚未发布到 npm。

装好后如果提示未配置库：在 Obsidian 里打开一次库，或设置 `OBSIDIAN_VAULT`，
或在 `cordis.patch.yml` 里写 `config.vaultPath`。

## License

MIT
