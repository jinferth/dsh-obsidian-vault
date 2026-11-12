import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'obsidian'
export const inject = ['tools']

/** Vault-relative directories that are never listed, searched, or written. */
const IGNORED_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

/** Raised for a path that would escape the vault. */
class VaultPathError extends Error {}

/** Image extensions the insert tool accepts. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'])

/** Split note text into lines without losing the trailing-newline information. */
function splitLines(text) {
  return text.split('\n')
}

/**
 * Join lines back, preserving whether the text ended with a newline.
 * @param lines - lines produced by {@link splitLines}.
 * @param hadFinalNewline - whether the original text ended with `\n`.
 */
function joinLines(lines, hadFinalNewline) {
  const body = lines.join('\n')
  return body
}

/** Split text into a frontmatter block and the remaining body. */
function splitFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: null, body: normalized }
  return { frontmatter: match[1], body: normalized.slice(match[0].length) }
}

/** Parse a `key: value` frontmatter block into ordered entries. */
function parseFrontmatter(block) {
  const entries = []
  if (block === null) return entries
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Za-z0-9_\-\u4e00-\u9fa5.]+):(.*)$/)
    if (!m) continue
    entries.push({ key: m[1], rawValue: m[2].trim() })
  }
  return entries
}

/** Render one frontmatter value as YAML text. */
function renderYamlValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderYamlScalar(item)).join(', ')}]`
  }
  return renderYamlScalar(value)
}

/** Render a YAML scalar, quoting strings that need it. */
function renderYamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  const text = String(value)
  if (/^[A-Za-z0-9_\-./\u4e00-\u9fa5]+$/.test(text) && text.length > 0) return text
  return JSON.stringify(text)
}

/** Interpret a YAML scalar's textual form back into a JS value. */
function parseYamlScalar(raw) {
  const text = raw.trim()
  if (text === '') return ''
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((part) => parseYamlScalar(part))
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return text.startsWith('"') ? JSON.parse(text) : text.slice(1, -1)
    } catch {
      return text.slice(1, -1)
    }
  }
  return text
}

/** Build a frontmatter block from ordered entries. */
function buildFrontmatter(entries) {
  if (entries.length === 0) return null
  return entries.map((e) => `${e.key}: ${e.rawValue}`).join('\n')
}

/** Turn an arbitrary file name into a safe asset name. */
function safeAssetName(sourceName) {
  const ext = extname(sourceName).toLowerCase()
  const stem = basename(sourceName, extname(sourceName))
    .replace(/[\\/:*?"<>|#^\[\]()]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const safeStem = stem.length > 0 ? stem : 'image'
  return { stem: safeStem, ext: IMAGE_EXTS.has(ext) ? ext : '.png', name: `${safeStem}${IMAGE_EXTS.has(ext) ? ext : '.png'}` }
}

/** Hash file bytes so identical images can be reused. */
async function hashFile(absPath) {
  const buf = await readFile(absPath)
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/** Atomically replace a file's contents. */
async function writeAtomic(abs, content) {
  const temp = `${abs}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, abs)
}

/**
 * Detect the dominant newline style of a text so a rewrite can preserve it.
 * Rewriting an LF body as CRLF (or the reverse) churns every line in Git even
 * when no content actually changed.
 * @param text - the original file content.
 * @returns "\r\n" when the file is CRLF-dominant, otherwise "\n".
 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/**
 * Rewrite a file while keeping its original newline style.
 * @param abs - absolute path to write.
 * @param originalText - the content as read from disk (used for EOL detection).
 * @param nextText - the new content, which uses "\n" internally.
 */
async function writeKeepingEol(abs, originalText, nextText) {
  const hadBom = originalText.startsWith('\uFEFF')
  let next = nextText.replace(/\r\n/g, '\n')
  // Frontmatter parsing normalises the BOM away; put it back so an edit does not
  // silently strip it from a file that had one.
  const hasBom = next.startsWith('\uFEFF')
  if (hadBom && !hasBom) next = `\uFEFF${next}`
  else if (!hadBom && hasBom) next = next.slice(1)
  if (detectEol(originalText) === '\r\n') {
    await writeAtomic(abs, next.replace(/\n/g, '\r\n'))
  } else {
    await writeAtomic(abs, next)
  }
}

/**
 * Normalize a wikilink target so `Note`, `Note.md`, `dir/Note` and
 * `dir/Note.md` can be compared.
 * @param target - the raw link text before `#` or `|`.
 */
function normalizeLinkTarget(target) {
  return String(target).replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase()
}

/**
 * Rewrite every wikilink in `text` that points at `oldRel` so it points at
 * `newRel` instead. Handles `[[x]]`, `[[x|alias]]`, `[[x#h]]`, `[[x#h|alias]]`
 * and the embed form `![[x]]`. A bare-file-name link is rewritten too, because
 * Obsidian resolves it when the name is unique in the vault.
 * @returns the rewritten text and how many links changed.
 */
function rewriteLinks(text, oldRel, newRel) {
  const oldNoExt = oldRel.replace(/\.md$/i, '')
  const newNoExt = newRel.replace(/\.md$/i, '')
  const oldBase = oldNoExt.split('/').pop()
  const newBase = newNoExt.split('/').pop()
  const candidates = new Set([
    normalizeLinkTarget(oldRel),
    normalizeLinkTarget(oldNoExt),
  ])
  let changed = 0

  // [[target#heading|alias]]  /  ![[target]]
  const replaced = text.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (whole, bang, inner) => {
    const pipe = inner.indexOf('|')
    const beforePipe = pipe >= 0 ? inner.slice(0, pipe) : inner
    const afterPipe = pipe >= 0 ? inner.slice(pipe) : ''
    const hash = beforePipe.indexOf('#')
    const targetPart = hash >= 0 ? beforePipe.slice(0, hash) : beforePipe
    const hashPart = hash >= 0 ? beforePipe.slice(hash) : ''
    if (targetPart.length === 0) return whole

    const normalized = normalizeLinkTarget(targetPart)
    const bareBase = targetPart.replace(/\.md$/i, '').split('/').pop().toLowerCase()

    if (!candidates.has(normalized) && bareBase !== String(oldBase).toLowerCase()) return whole

    // Replace the path part, keeping only the final segment when the original
    // link carried no directory (so a moved note keeps a short, readable link).
    const hadDir = targetPart.includes('/')
    const suffix = /\.md$/i.test(targetPart) ? '.md' : ''
    const nextTarget = hadDir ? `${newNoExt}${suffix}` : `${newBase}${suffix}`
    changed++
    return `${bang}[[${nextTarget}${hashPart}${afterPipe}]]`
  })

  return { text: replaced, changed }
}

/**
 * Resolve a vault-relative path and reject anything that escapes the vault root.
 * @param root - the absolute vault path.
 * @param input - a vault-relative path supplied by the caller.
 * @returns the absolute path inside the vault.
 */
function inside(root, input) {
  const raw = String(input ?? '')
  // Check absoluteness before stripping separators: the old order turned
  // "/etc/passwd" into "etc/passwd" and quietly re-pointed it inside the vault.
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new VaultPathError(`path must be vault-relative, got absolute path "${input}"`)
  }
  const cleaned = raw.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  const abs = resolve(root, cleaned)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new VaultPathError(`path "${input}" escapes the vault`)
  }
  return abs
}

/** Convert an absolute path back to the vault-relative display form. */
function displayOf(root, abs) {
  return relative(root, abs).split(sep).join('/')
}

/** Whether a vault-relative path sits in an ignored directory. */
function isIgnored(relPath) {
  return relPath.split('/').some((part) => IGNORED_DIRS.has(part))
}

/** Normalize a note path to end with `.md` when it has no extension. */
function asNote(relPath) {
  return /\.md$/i.test(relPath) ? relPath : `${relPath}.md`
}

/** Escape a string so it can be embedded in a regular expression literally. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile a simple glob (`*`, `**`, `?`) into a RegExp over vault-relative paths. */
function globToRe(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else out += '[^/]*'
    } else if (ch === '?') out += '[^/]'
    else out += escapeRe(ch)
  }
  return new RegExp(`^${out}$`)
}

/**
 * Walk the vault and collect every markdown note.
 * @param root - the absolute vault path.
 * @param limit - stop after this many notes.
 * @returns vault-relative note paths, sorted.
 */
async function collectNotes(root, limit) {
  const found = []
  async function walk(dir) {
    if (found.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const abs = join(dir, entry.name)
      const rel = displayOf(root, abs)
      if (isIgnored(rel)) continue
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(rel)
    }
  }
  await walk(root)
  return found.sort()
}

/** Convert a note's content into an Obsidian-style display title (basename without extension). */
function titleOf(relPath) {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '')
}

/**
 * Build the frontmatter block for a new note.
 * @param fields - caller-supplied key/value pairs.
 * @returns the fenced YAML block followed by one blank line, or an empty string.
 */
function frontmatterBlock(fields) {
  if (!fields || Object.keys(fields).length === 0) return ''
  const lines = Object.entries(fields).map(([key, value]) => {
    const scalar = Array.isArray(value)
      ? `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`
      : JSON.stringify(String(value))
    return `${key}: ${scalar}`
  })
  return `---\n${lines.join('\n')}\n---\n\n`
}

/**
 * Path where the Obsidian desktop app records its vault registry, per platform.
 * @returns the absolute path to `obsidian.json`.
 */
function obsidianRegistryFile() {
  const env = process.env
  if (process.platform === 'win32') {
    const base = env.APPDATA || join(env.USERPROFILE ?? '', 'AppData', 'Roaming')
    return join(base, 'obsidian', 'obsidian.json')
  }
  if (process.platform === 'darwin') {
    return join(env.HOME ?? '', 'Library', 'Application Support', 'obsidian', 'obsidian.json')
  }
  return join(env.XDG_CONFIG_HOME || join(env.HOME ?? '', '.config'), 'obsidian', 'obsidian.json')
}

/**
 * Resolve the vault the tools operate on.
 *
 * Order: an explicit `config.vaultPath`, then `$OBSIDIAN_VAULT`, then whichever
 * vault Obsidian itself last opened. Bundles are installed from a package, so the
 * vault cannot be baked into the shipped configuration - without this the plugin
 * would only work on the machine it was developed on.
 * @param config - the plugin configuration resolved from cordis.patch.yml.
 * @returns the absolute vault path, or null when nothing could be resolved.
 */
function resolveVaultRoot(config) {
  const explicit = config?.vaultPath || process.env.OBSIDIAN_VAULT
  if (explicit) return resolve(explicit)
  try {
    const data = JSON.parse(readFileSync(obsidianRegistryFile(), 'utf8'))
    const vaults = Object.values(data?.vaults ?? {}).filter((entry) => entry?.path)
    const chosen = vaults.find((entry) => entry.open) ?? (vaults.length === 1 ? vaults[0] : null)
    if (chosen?.path) return resolve(chosen.path)
  } catch {
    // No registry, or it is unreadable: fall through to the unconfigured state.
  }
  return null
}

/**
 * Register the Obsidian vault tools.
 *
 * Compatibility policy: this plugin imports nothing from `@deepseek-ai/*` and
 * touches exactly one host surface - `ctx.tools.register(definition)` with a
 * plain-data definition. Tool schemas ship as data, not as objects built by a
 * version-pinned helper, so a Harness upgrade cannot break the build through a
 * dependency range. Everything below is written to degrade rather than throw:
 * an incompatible host logs what is missing and leaves the rest of the profile
 * running.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the resolved vault configuration.
 */
export function apply(ctx, config) {
  const tools = ctx?.tools
  if (!tools || typeof tools.register !== 'function') {
    console.error(
      '[dsh-obsidian-vault] ctx.tools.register is not available on this DeepSeek '
      + 'Harness build, so no tools were registered. The plugin expects the tool '
      + 'registry service declared via `inject: ["tools"]`.',
    )
    return
  }

  let root = null
  try {
    root = resolveVaultRoot(config)
  } catch (error) {
    console.error(`[dsh-obsidian-vault] could not resolve an Obsidian vault: ${error?.message}`)
  }
  const maxResults = config?.maxResults ?? 200

  const ok = (value) => value

  // Local registry so obsidian_batch can dispatch to the other tools without
  // relying on the host's lookup API being reachable from inside a plugin.
  const registry = new Map()
  const register = (definition) => {
    const execute = definition.execute
    const guarded = {
      ...definition,
      async execute(...args) {
        // A freshly installed bundle may not have a vault yet. Fail with an
        // actionable message per call instead of throwing during apply(), which
        // would take the whole profile down before the user can configure it.
        if (!root && definition.name !== 'obsidian_info') {
          throw new Error(
            'No Obsidian vault is configured. Set config.vaultPath in cordis.patch.yml, '
            + 'set the OBSIDIAN_VAULT environment variable, or open a vault once in '
            + 'Obsidian so it registers itself.',
          )
        }
        return execute.apply(definition, args)
      },
    }
    registry.set(definition.name, guarded)
    try {
      return tools.register(guarded)
    } catch (error) {
      // One rejected definition must not cost the user the other twelve tools.
      console.error(
        `[dsh-obsidian-vault] the host refused the "${definition.name}" tool: `
        + `${error?.message ?? error}. Check whether the tool definition contract `
        + 'changed in this DeepSeek Harness version.',
      )
      return undefined
    }
  }

  register({
    name: 'obsidian_info',
    description: 'Report the configured Obsidian vault: its absolute path, whether it exists, and how many markdown notes it holds. Call this first when you are unsure which vault is connected or whether a path still resolves.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['vaultPath', 'exists', 'noteCount'],
        properties: {
          vaultPath: { type: 'string' },
          exists: { type: 'boolean' },
          noteCount: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exists
          ? `Obsidian vault "${value.vaultPath}" is connected and holds ${value.noteCount} markdown note(s).`
          : value.vaultPath
            ? `Obsidian vault "${value.vaultPath}" does not exist or is not a directory.`
            : 'No Obsidian vault is configured. Set config.vaultPath, set OBSIDIAN_VAULT, or open a vault once in Obsidian.',
      }],
    },
    async execute() {
      let exists = false
      let noteCount = 0
      try {
        const info = await stat(root)
        exists = info.isDirectory()
      } catch {
        exists = false
      }
      if (exists) noteCount = (await collectNotes(root, Number.MAX_SAFE_INTEGER)).length
      return ok({ vaultPath: root ?? '', exists, noteCount })
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Obsidian vault', kind: 'other' }),
  })

  register({
    name: 'obsidian_list',
    description: 'List markdown notes in the Obsidian vault. Optional `directory` limits the walk to one folder and `glob` filters vault-relative paths (for example "Projects/**" or "*.md"). Returns each note\'s path, title, size, and modification time.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        directory: { type: 'string', description: 'Vault-relative folder to list; omit for the whole vault.' },
        glob: { type: 'string', description: 'Glob over vault-relative paths, supporting * ? and **.' },
        limit: { type: 'integer', description: 'Maximum notes to return; defaults to the configured maxResults.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['notes', 'total', 'truncated'],
        properties: {
          notes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'title', 'size', 'modified'],
              properties: {
                path: { type: 'string' },
                title: { type: 'string' },
                size: { type: 'integer' },
                modified: { type: 'string' },
              },
            },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.notes.length === 0
          ? 'No notes matched.'
          : `Found ${value.total} note(s)${value.truncated ? ` (showing first ${value.notes.length})` : ''}:\n`
            + value.notes.map((note) => `- ${note.path} (${note.size} B, ${note.modified})`).join('\n'),
      }],
    },
    async execute(args) {
      const limit = Math.min(args.limit ?? maxResults, maxResults)
      const prefix = args.directory ? displayOf(root, inside(root, args.directory)) : ''
      const matcher = args.glob ? globToRe(args.glob) : undefined
      const all = await collectNotes(root, Number.MAX_SAFE_INTEGER)
      const filtered = all.filter((rel) => {
        if (prefix && !(rel === prefix || rel.startsWith(`${prefix}/`))) return false
        return matcher ? matcher.test(rel) : true
      })
      const notes = []
      for (const rel of filtered.slice(0, limit)) {
        try {
          const info = await stat(join(root, rel))
          notes.push({
            path: rel,
            title: titleOf(rel),
            size: info.size,
            modified: new Date(info.mtimeMs).toISOString(),
          })
        } catch {
          // A note removed between the walk and the stat is simply skipped.
        }
      }
      return ok({ notes, total: filtered.length, truncated: filtered.length > limit })
    },
    presentCall: (args) => ({ card: 'generic', title: 'List notes', kind: 'search', rawInput: args }),
  })

  register({
    name: 'obsidian_read',
    description: 'Read one note from the Obsidian vault by its vault-relative path. The ".md" extension may be omitted. Returns the full raw markdown, including any frontmatter, plus the wikilinks it contains.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Vault-relative note path, for example "Projects/Roadmap".' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'title', 'content', 'lines', 'links'],
        properties: {
          path: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          lines: { type: 'integer' },
          links: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.path} (${value.lines} lines)\n\n${value.content}`,
      }],
    },
    async execute(args) {
      if (!args.path) throw new Error('path is required')
      const rel = asNote(displayOf(root, inside(root, args.path)))
      const content = await readFile(join(root, rel), 'utf8')
      const links = [...content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim())
      return ok({
        path: rel,
        title: titleOf(rel),
        content,
        lines: content.length === 0 ? 0 : content.split('\n').length,
        links: [...new Set(links)],
      })
    },
    presentCall: (args) => ({ card: 'generic', title: `Read ${args.path}`, kind: 'read', rawInput: args }),
  })

  register({
    name: 'obsidian_search',
    description: 'Search note bodies and titles in the Obsidian vault. The query is treated as a literal string unless `regex` is true. Optionally restrict the search with `glob`. Returns one entry per matching line with its note path and line number.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        regex: { type: 'boolean', description: 'Treat the query as a JavaScript regular expression.' },
        glob: { type: 'string', description: 'Glob over vault-relative paths, supporting * ? and **.' },
        limit: { type: 'integer', description: 'Maximum matches to return; defaults to the configured maxResults.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['matches', 'notesMatched', 'truncated'],
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'line', 'text'],
              properties: {
                path: { type: 'string' },
                line: { type: 'integer' },
                text: { type: 'string' },
              },
            },
          },
          notesMatched: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? 'No matches.'
          : `${value.matches.length} match(es) in ${value.notesMatched} note(s)${value.truncated ? ' (truncated)' : ''}:\n`
            + value.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n'),
      }],
    },
    async execute(args) {
      if (!args.query) throw new Error('query is required')
      const limit = Math.min(args.limit ?? maxResults, maxResults)
      const matcher = args.regex ? new RegExp(args.query, 'i') : new RegExp(escapeRe(args.query), 'i')
      const pathMatcher = args.glob ? globToRe(args.glob) : undefined
      const notes = await collectNotes(root, Number.MAX_SAFE_INTEGER)
      const matches = []
      const matchedNotes = new Set()
      let truncated = false
      for (const rel of notes) {
        if (pathMatcher && !pathMatcher.test(rel)) continue
        let content
        try {
          content = await readFile(join(root, rel), 'utf8')
        } catch {
          continue
        }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!matcher.test(lines[i])) continue
          matchedNotes.add(rel)
          if (matches.length >= limit) {
            truncated = true
            continue
          }
          matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 300) })
        }
      }
      return ok({ matches, notesMatched: matchedNotes.size, truncated })
    },
    presentCall: (args) => ({ card: 'generic', title: `Search "${args.query}"`, kind: 'search', rawInput: args }),
  })

  register({
    name: 'obsidian_new',
    description: 'Create a new note in the Obsidian vault. Fails if the note already exists, so use this for creation and `obsidian_append` for extending an existing note. Parent folders are created automatically, and optional `frontmatter` pairs become a YAML block.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Vault-relative note path; ".md" is added when missing.' },
        content: { type: 'string', description: 'The markdown body of the note.' },
        frontmatter: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional YAML frontmatter fields, for example {"tags": ["idea"], "status": "draft"}.',
        },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'bytes'],
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created note ${value.path} (${value.bytes} bytes).` }],
    },
    async execute(args) {
      if (!args.path) throw new Error('path is required')
      if (!args.content) throw new Error('content is required')
      const rel = asNote(displayOf(root, inside(root, args.path)))
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      const text = `${frontmatterBlock(args.frontmatter)}${args.content}`
      try {
        await writeFile(abs, text, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new Error(`note "${rel}" already exists; use obsidian_append to extend it`)
        }
        throw error
      }
      return ok({ path: rel, bytes: Buffer.byteLength(text, 'utf8') })
    },
    presentCall: (args) => ({ card: 'generic', title: `Create ${args.path}`, kind: 'edit', rawInput: args }),
  })

  register({
    name: 'obsidian_append',
    description: 'Append markdown to the end of an existing note in the Obsidian vault, creating the note when it does not exist yet. A newline is inserted when the note does not already end with one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Vault-relative note path; ".md" is added when missing.' },
        content: { type: 'string', description: 'Markdown to append.' },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'created', 'bytes'],
        properties: {
          path: { type: 'string' },
          created: { type: 'boolean' },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.created ? 'Created and wrote' : 'Appended to'} ${value.path} (${value.bytes} bytes total).`,
      }],
    },
    async execute(args) {
      if (!args.path) throw new Error('path is required')
      if (!args.content) throw new Error('content is required')
      const rel = asNote(displayOf(root, inside(root, args.path)))
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      let previous = ''
      let created = false
      try {
        previous = await readFile(abs, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        created = true
      }
      const separator = previous.length === 0 || previous.endsWith('\n') ? '' : '\n'
      const next = `${previous}${separator}${args.content}\n`
      const temp = `${abs}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, next, 'utf8')
      await rename(temp, abs)
      return ok({ path: rel, created, bytes: Buffer.byteLength(next, 'utf8') })
    },
    presentCall: (args) => ({ card: 'generic', title: `Append to ${args.path}`, kind: 'edit', rawInput: args }),
  })

  register({
    name: 'obsidian_edit',
    description: 'Edit one note in the Obsidian vault. Four modes, chosen by `action`:\n'
      + '- "replace" (default): literal `oldString` -> `newString`. The old text must occur exactly once unless `replaceAll` is true.\n'
      + '- "replaceLines": replace lines `fromLine`..`toLine` (1-based, inclusive) with `content`.\n'
      + '- "insertLines": insert `content` after line `atLine` (use 0 to insert at the very top).\n'
      + '- "deleteLines": delete lines `fromLine`..`toLine` (1-based, inclusive).\n'
      + 'Line numbers are 1-based and match the numbers `obsidian_read` returns. Returns the number of changes and the new line count.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Vault-relative note path; ".md" is added when missing.' },
        action: {
          type: 'string',
          description: 'replace (default) | replaceLines | insertLines | deleteLines.',
          enum: ['replace', 'replaceLines', 'insertLines', 'deleteLines'],
        },
        oldString: { type: 'string', description: 'ACTION=replace: the exact text to replace, including whitespace as it appears in the file.' },
        newString: { type: 'string', description: 'ACTION=replace: the replacement text. Use an empty string to delete the matched text.' },
        replaceAll: { type: 'boolean', description: 'ACTION=replace: replace every occurrence instead of requiring exactly one. Defaults to false.' },
        fromLine: { type: 'integer', description: 'ACTION=replaceLines/deleteLines: first line of the range, 1-based and inclusive.' },
        toLine: { type: 'integer', description: 'ACTION=replaceLines/deleteLines: last line of the range, 1-based and inclusive.' },
        atLine: { type: 'integer', description: 'ACTION=insertLines: insert after this line number; 0 inserts at the top.' },
        content: { type: 'string', description: 'ACTION=replaceLines/insertLines: the replacement or inserted text (may contain newlines).' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'action', 'changes', 'lines'],
        properties: {
          path: { type: 'string' },
          action: { type: 'string' },
          changes: { type: 'integer' },
          lines: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Edited ${value.path} (${value.action}): ${value.changes} change(s), now ${value.lines} line(s).`,
      }],
    },
    async execute(args) {
      if (!args.path) throw new Error('path is required')
      const action = args.action ?? 'replace'
      const rel = asNote(displayOf(root, inside(root, args.path)))
      const abs = join(root, rel)
      const before = await readFile(abs, 'utf8')

      if (action === 'replace') {
        if (typeof args.oldString !== 'string' || args.oldString.length === 0) throw new Error('oldString must be a non-empty string')
        if (typeof args.newString !== 'string') throw new Error('newString must be a string')
        const occurrences = before.split(args.oldString).length - 1
        if (occurrences === 0) {
          throw new Error(`oldString was not found in "${rel}"; read the note first and copy the exact text, including whitespace`)
        }
        if (occurrences > 1 && !args.replaceAll) {
          throw new Error(`oldString occurs ${occurrences} times in "${rel}"; include more surrounding context, or set replaceAll to replace every occurrence`)
        }
        const after = args.replaceAll
          ? before.split(args.oldString).join(args.newString)
          : before.replace(args.oldString, () => args.newString)
        await writeKeepingEol(abs, before, after)
        return ok({
          path: rel,
          action,
          changes: args.replaceAll ? occurrences : 1,
          lines: after.length === 0 ? 0 : after.split('\n').length,
        })
      }

      const lines = splitLines(before)
      const lineCount = lines.length
      const requireInt = (name, value, min) => {
        if (!Number.isInteger(value) || value < min) {
          throw new Error(`${name} must be an integer >= ${min} (got ${JSON.stringify(value)})`)
        }
      }

      if (action === 'replaceLines' || action === 'deleteLines') {
        requireInt('fromLine', args.fromLine, 1)
        requireInt('toLine', args.toLine, 1)
        if (args.fromLine > args.toLine) throw new Error(`fromLine (${args.fromLine}) must be <= toLine (${args.toLine})`)
        if (args.toLine > lineCount) {
          throw new Error(`toLine ${args.toLine} is out of range; "${rel}" has ${lineCount} line(s)`)
        }
        if (action === 'replaceLines' && typeof args.content !== 'string') {
          throw new Error('content must be a string for action=replaceLines')
        }
        const replacement = action === 'deleteLines'
          ? []
          : (args.content.length === 0 ? [] : splitLines(args.content))
        const next = [
          ...lines.slice(0, args.fromLine - 1),
          ...replacement,
          ...lines.slice(args.toLine),
        ]
        const after = joinLines(next, before.endsWith('\n'))
        await writeKeepingEol(abs, before, after)
        return ok({
          path: rel,
          action,
          changes: action === 'deleteLines' ? args.toLine - args.fromLine + 1 : replacement.length,
          lines: next.length,
        })
      }

      if (action === 'insertLines') {
        requireInt('atLine', args.atLine, 0)
        if (args.atLine > lineCount) {
          throw new Error(`atLine ${args.atLine} is out of range; "${rel}" has ${lineCount} line(s) (use ${lineCount} to append)`)
        }
        if (typeof args.content !== 'string' || args.content.length === 0) {
          throw new Error('content must be a non-empty string for action=insertLines (pass a single space to insert a blank line)')
        }
        const inserted = splitLines(args.content)
        const next = [
          ...lines.slice(0, args.atLine),
          ...inserted,
          ...lines.slice(args.atLine),
        ]
        const after = joinLines(next, before.endsWith('\n'))
        await writeKeepingEol(abs, before, after)
        return ok({ path: rel, action, changes: inserted.length, lines: next.length })
      }

      throw new Error(`unknown action "${action}"`)
    },
    presentCall: (args) => ({ card: 'generic', title: `Edit ${args.path}`, kind: 'edit', rawInput: args }),
  })

  register({
    name: 'obsidian_delete',
    description: 'Delete a note from the Obsidian vault by moving it into the vault\'s `.trash/` folder, so it can still be recovered. The name is kept, with a timestamp suffix when a file already occupies that path. Returns both the original path and the trash path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true, description: 'Vault-relative note path; ".md" is added when missing.' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'trashPath'],
        properties: {
          path: { type: 'string' },
          trashPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Moved ${value.path} to ${value.trashPath}`,
      }],
    },
    async execute(args) {
      if (!args.path) throw new Error('path is required')
      const rel = asNote(displayOf(root, inside(root, args.path)))
      const abs = join(root, rel)
      let info
      try {
        info = await stat(abs)
      } catch {
        throw new Error(`note "${rel}" does not exist`)
      }
      if (!info.isFile()) throw new Error(`"${rel}" is not a file`)

      const trashDir = join(root, '.trash')
      await mkdir(trashDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
      let trashName = basename(rel)
      let trashRel = `.trash/${trashName}`
      if (await stat(join(trashDir, trashName)).then(() => true, () => false)) {
        trashName = `${basename(rel, '.md')}.${stamp}.md`
        trashRel = `.trash/${trashName}`
      }
      const trashAbs = join(trashDir, trashName)
      await rename(abs, trashAbs)
      return ok({ path: rel, trashPath: trashRel })
    },
    presentCall: (args) => ({ card: 'generic', title: `Delete ${args.path}`, kind: 'delete', rawInput: args }),
  })

  register({
    name: 'obsidian_insert_image',
    description: 'Copy an image into the note\'s `assets/` folder and insert a Markdown image reference. The image is renamed to a filesystem-safe name; identical images are reused instead of duplicated. Optionally place the reference right after a given heading (`section`) and add a caption line.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', required: true, description: 'Vault-relative note path that receives the image.' },
        imagePath: { type: 'string', required: true, description: 'Absolute path of the source image file on this machine.' },
        caption: { type: 'string', description: 'Optional caption line rendered in italics below the image.' },
        section: { type: 'string', description: 'Optional heading text (without the # signs); the image is inserted right after that heading\'s section start. Without it the image is appended at the end of the note.' },
      },
      required: ['note', 'imagePath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['note', 'image', 'reused', 'lines'],
        properties: {
          note: { type: 'string' },
          image: { type: 'string' },
          reused: { type: 'boolean' },
          lines: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.reused ? 'Reused existing' : 'Copied'} ${value.image} into ${value.note} (now ${value.lines} line(s)).`,
      }],
    },
    async execute(args) {
      if (!args.note) throw new Error('note is required')
      if (!args.imagePath) throw new Error('imagePath is required')
      const sourceAbs = resolve(String(args.imagePath))
      const sourceExt = extname(sourceAbs).toLowerCase()
      if (!IMAGE_EXTS.has(sourceExt)) {
        throw new Error(`unsupported image extension "${sourceExt}"; expected one of ${[...IMAGE_EXTS].join(', ')}`)
      }
      const sourceInfo = await stat(sourceAbs).catch(() => undefined)
      if (!sourceInfo || !sourceInfo.isFile()) throw new Error(`image not found at "${sourceAbs}"`)

      const noteRel = asNote(displayOf(root, inside(root, args.note)))
      const noteAbs = join(root, noteRel)
      const noteInfo = await stat(noteAbs).catch(() => undefined)
      if (!noteInfo || !noteInfo.isFile()) throw new Error(`note "${noteRel}" does not exist`)

      // assets folder lives beside the note
      const noteDir = dirname(noteAbs)
      const assetsDir = join(noteDir, 'assets')
      await mkdir(assetsDir, { recursive: true })

      const { name: safeName } = safeAssetName(basename(sourceAbs))
      const targetAbs = join(assetsDir, safeName)
      const sourceHash = await hashFile(sourceAbs)

      let reused = false
      let chosenName = safeName
      const existing = await stat(targetAbs).catch(() => undefined)
      if (existing) {
        const existingHash = await hashFile(targetAbs)
        if (existingHash === sourceHash) {
          reused = true
        } else {
          const { stem, ext } = safeAssetName(basename(sourceAbs))
          chosenName = `${stem}-${sourceHash.slice(0, 8)}${ext}`
        }
      }
      const finalAbs = join(assetsDir, chosenName)
      if (!reused) {
        const probe = await stat(finalAbs).catch(() => undefined)
        if (probe) {
          const probeHash = await hashFile(finalAbs)
          if (probeHash === sourceHash) reused = true
        }
        if (!reused) await copyFile(sourceAbs, finalAbs)
      }

      const imageRelFromNote = displayOf(root, finalAbs)
      const noteDirRel = displayOf(root, noteDir)
      const refPath = noteDirRel === '' || noteDirRel === '.'
        ? imageRelFromNote
        : relative(noteDir, finalAbs).split(sep).join('/')

      const alt = args.caption ? String(args.caption).replace(/[\[\]]/g, '') : basename(finalAbs, extname(finalAbs))
      const block = [`![${alt}](${refPath})`]
      if (args.caption) block.push('', `*${args.caption}*`)

      const before = await readFile(noteAbs, 'utf8')
      const lines = splitLines(before)

      let insertAt = lines.length
      if (args.section) {
        const needle = String(args.section).trim().replace(/^#+\s*/, '')
        let found = -1
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^(#{2,6})\s+(.*)$/)
          if (m && m[2].trim() === needle) { found = i; break }
        }
        if (found < 0) throw new Error(`heading "${needle}" not found in "${noteRel}"`)
        // insert right after the heading line and any blank line following it
        insertAt = found + 1
        while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++
      }

      const prefixBlank = insertAt > 0 && lines[insertAt - 1].trim() !== '' ? [''] : []
      const suffixBlank = insertAt < lines.length && lines[insertAt].trim() !== '' ? [''] : []
      const next = [
        ...lines.slice(0, insertAt),
        ...prefixBlank,
        ...block,
        ...suffixBlank,
        ...lines.slice(insertAt),
      ]
      await writeKeepingEol(noteAbs, before, joinLines(next, before.endsWith('\n')))

      return ok({
        note: noteRel,
        image: displayOf(root, finalAbs),
        reused,
        lines: next.length,
      })
    },
    presentCall: (args) => ({ card: 'generic', title: `Insert image into ${args.note}`, kind: 'edit', rawInput: args }),
  })

  register({
    name: 'obsidian_frontmatter',
    description: 'Read or modify the YAML frontmatter of a note without touching the body. Modes: "get" returns all properties; "set" writes one key (creating the block when absent); "delete" removes one key. Values keep their type: strings, numbers, booleans and arrays are serialized correctly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true, description: 'Vault-relative note path; ".md" is added when missing.' },
        action: { type: 'string', required: true, description: 'get | set | delete.', enum: ['get', 'set', 'delete'] },
        key: { type: 'string', description: 'Property name for action=set/delete.' },
        value: { type: 'json', description: 'Property value for action=set. A JSON scalar or array; arrays become a YAML list.' },
      },
      required: ['path', 'action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'action', 'properties'],
        properties: {
          path: { type: 'string' },
          action: { type: 'string' },
          properties: {
            type: 'object',
            description: 'All properties after the operation, as parsed values.',
          },
        },
      },
      render: (_args, value) => {
        const keys = Object.keys(value.properties)
        return [{
          type: 'text',
          text: keys.length === 0
            ? `${value.path}: no frontmatter properties.`
            : `${value.path} (${value.action === 'get' ? 'read' : value.action === 'set' ? 'updated' : 'removed'}):\n`
              + keys.map((k) => `- ${k}: ${JSON.stringify(value.properties[k])}`).join('\n'),
        }]
      },
    },
    async execute(args) {
      if (!args.path) throw new Error('path is required')
      if (!args.action) throw new Error('action is required')
      if (!['get', 'set', 'delete'].includes(args.action)) {
        throw new Error(`unknown action "${args.action}"; expected get, set or delete`)
      }
      if ((args.action === 'set' || args.action === 'delete') && !args.key) {
        throw new Error(`key is required for action=${args.action}`)
      }
      const rel = asNote(displayOf(root, inside(root, args.path)))
      const abs = join(root, rel)
      const raw = await readFile(abs, 'utf8')
      const { frontmatter, body } = splitFrontmatter(raw)
      const entries = parseFrontmatter(frontmatter)

      const asObject = () => {
        const out = {}
        for (const e of entries) out[e.key] = parseYamlScalar(e.rawValue)
        return out
      }

      if (args.action === 'get') {
        return ok({ path: rel, action: 'get', properties: asObject() })
      }

      const key = String(args.key)

      if (args.action === 'set') {
        if (args.value === undefined) throw new Error('value is required for action=set')
        const rendered = renderYamlValue(args.value)
        const target = entries.find((e) => e.key === key)
        if (target) target.rawValue = rendered
        else entries.push({ key, rawValue: rendered })
      } else {
        const idx = entries.findIndex((e) => e.key === key)
        if (idx < 0) throw new Error(`property "${key}" not found in "${rel}"`)
        entries.splice(idx, 1)
      }

      const nextBlock = buildFrontmatter(entries)
      const after = nextBlock === null
        ? body.replace(/^\r?\n/, '')
        : `---\n${nextBlock}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`

      await writeKeepingEol(abs, raw, after)
      return ok({ path: rel, action: args.action, properties: asObject() })
    },
    presentCall: (args) => ({ card: 'generic', title: `Frontmatter ${args.action} on ${args.path}`, kind: 'edit', rawInput: args }),
  })

  register({
    name: 'obsidian_move',
    description: 'Move or rename a note inside the Obsidian vault and, by default, rewrite every wikilink in the vault that pointed at it. The target must not already exist. Link rewriting covers `[[x]]`, `[[x|alias]]`, `[[x#heading]]`, `[[x#heading|alias]]`, embeds `![[x]]`, both the `.md` and extension-less spellings, and bare file-name links. Returns the new path plus how many notes and links were updated.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', required: true, description: 'Vault-relative path of the note to move; ".md" is added when missing.' },
        to: { type: 'string', required: true, description: 'Vault-relative destination path; parent folders are created automatically.' },
        updateLinks: { type: 'boolean', description: 'Rewrite wikilinks across the vault. Defaults to true; set false to move the file only.' },
      },
      required: ['from', 'to'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'notesUpdated', 'linksUpdated'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          notesUpdated: { type: 'integer' },
          linksUpdated: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Moved ${value.from} -> ${value.to}; updated ${value.linksUpdated} link(s) in ${value.notesUpdated} note(s).`,
      }],
    },
    async execute(args) {
      if (!args.from) throw new Error('from is required')
      if (!args.to) throw new Error('to is required')
      const fromRel = asNote(displayOf(root, inside(root, args.from)))
      const toRel = asNote(displayOf(root, inside(root, args.to)))
      if (fromRel === toRel) throw new Error('from and to are the same path')

      const fromAbs = join(root, fromRel)
      const toAbs = join(root, toRel)
      const fromInfo = await stat(fromAbs).catch(() => undefined)
      if (!fromInfo || !fromInfo.isFile()) throw new Error(`note "${fromRel}" does not exist`)
      const toInfo = await stat(toAbs).catch(() => undefined)
      if (toInfo) throw new Error(`destination "${toRel}" already exists`)

      // Rewrite links BEFORE moving, so a failure leaves the vault untouched.
      let notesUpdated = 0
      let linksUpdated = 0
      const pending = []
      if (args.updateLinks !== false) {
        const allNotes = await collectNotes(root, Number.MAX_SAFE_INTEGER)
        for (const rel of allNotes) {
          if (rel === fromRel) continue
          const abs = join(root, rel)
          let text
          try {
            text = await readFile(abs, 'utf8')
          } catch {
            continue
          }
          const { text: next, changed } = rewriteLinks(text, fromRel, toRel)
          if (changed > 0 && next !== text) {
            pending.push({ abs, text: next })
            notesUpdated++
            linksUpdated += changed
          }
        }
      }

      await mkdir(dirname(toAbs), { recursive: true })
      await rename(fromAbs, toAbs)

      for (const item of pending) {
        await writeKeepingEol(item.abs, await readFile(item.abs, 'utf8').catch(() => item.text), item.text)
      }

      // The moved note may itself contain self-references.
      if (args.updateLinks !== false) {
        const movedText = await readFile(toAbs, 'utf8')
        const { text: next, changed } = rewriteLinks(movedText, fromRel, toRel)
        if (changed > 0) {
          await writeKeepingEol(toAbs, movedText, next)
          notesUpdated++
          linksUpdated += changed
        }
      }

      return ok({ from: fromRel, to: toRel, notesUpdated, linksUpdated })
    },
    presentCall: (args) => ({ card: 'generic', title: `Move ${args.from}`, kind: 'move', rawInput: args }),
  })

  register({
    name: 'obsidian_query',
    description: 'Find notes by their frontmatter properties, tags and path. `tags` are ANDed (a note must carry all of them); `properties` are exact key/value matches; `glob` filters vault-relative paths. Results can be sorted by modified, created, path or title.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags that must all be present on the note.' },
        properties: { type: 'object', additionalProperties: true, description: 'Exact property matches, for example {"status": "done"}.' },
        glob: { type: 'string', description: 'Glob over vault-relative paths, supporting * ? and **.' },
        sortBy: { type: 'string', description: 'modified (default) | created | path | title.', enum: ['modified', 'created', 'path', 'title'] },
        limit: { type: 'integer', description: 'Maximum notes to return; defaults to the configured maxResults.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['notes', 'total', 'truncated'],
        properties: {
          notes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'title', 'properties', 'size', 'modified'],
              properties: {
                path: { type: 'string' },
                title: { type: 'string' },
                properties: { type: 'object' },
                size: { type: 'integer' },
                modified: { type: 'string' },
              },
            },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.notes.length === 0
          ? 'No notes matched.'
          : `${value.total} note(s) matched${value.truncated ? ` (showing ${value.notes.length})` : ''}:\n`
            + value.notes.map((n) => `- ${n.path}  [${Object.keys(n.properties).length} props]`).join('\n'),
      }],
    },
    async execute(args) {
      const limit = Math.min(args.limit ?? maxResults, maxResults)
      const tags = (args.tags ?? []).map((t) => String(t).replace(/^#/, '').toLowerCase())
      const props = args.properties ?? {}
      const pathMatcher = args.glob ? globToRe(args.glob) : undefined
      const all = await collectNotes(root, Number.MAX_SAFE_INTEGER)
      const matched = []

      for (const rel of all) {
        if (pathMatcher && !pathMatcher.test(rel)) continue
        let text
        try {
          text = await readFile(join(root, rel), 'utf8')
        } catch {
          continue
        }
        const { frontmatter } = splitFrontmatter(text)
        const entries = parseFrontmatter(frontmatter)
        const obj = {}
        for (const e of entries) obj[e.key] = parseYamlScalar(e.rawValue)

        if (tags.length > 0) {
          const raw = obj.tags
          const noteTags = (Array.isArray(raw) ? raw : raw === undefined || raw === '' ? [] : [raw])
            .map((t) => String(t).replace(/^#/, '').toLowerCase())
          if (!tags.every((t) => noteTags.includes(t))) continue
        }

        let propsOk = true
        for (const [k, v] of Object.entries(props)) {
          const actual = obj[k]
          const norm = (x) => (Array.isArray(x) ? x.map((i) => String(i)).sort().join('\u0000') : String(x))
          if (norm(actual) !== norm(v)) { propsOk = false; break }
        }
        if (!propsOk) continue

        let info
        try {
          info = await stat(join(root, rel))
        } catch {
          continue
        }
        matched.push({
          path: rel,
          title: titleOf(rel),
          properties: obj,
          size: info.size,
          modified: new Date(info.mtimeMs).toISOString(),
          _created: obj.created,
        })
      }

      const sortBy = args.sortBy ?? 'modified'
      matched.sort((a, b) => {
        if (sortBy === 'path') return a.path.localeCompare(b.path)
        if (sortBy === 'title') return a.title.localeCompare(b.title)
        if (sortBy === 'created') {
          return String(a._created ?? '').localeCompare(String(b._created ?? ''))
        }
        return b.modified.localeCompare(a.modified)
      })

      const notes = matched.slice(0, limit).map(({ _created, ...rest }) => rest)
      return ok({ notes, total: matched.length, truncated: matched.length > limit })
    },
    presentCall: (args) => ({ card: 'generic', title: 'Query notes', kind: 'search', rawInput: args }),
  })

  register({
    name: 'obsidian_batch',
    description: 'Apply several note operations as one transaction: every operation runs in order, and if any of them fails the vault is restored to exactly its previous state. Allowed operations are obsidian_edit, obsidian_append, obsidian_new, obsidian_delete, obsidian_move and obsidian_frontmatter. Nesting obsidian_batch is rejected.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operations: {
          type: 'array',
          required: true,
          description: 'Operations to apply in order, for example [{"tool":"obsidian_append","args":{"path":"Note","content":"x"}}].',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tool: { type: 'string', required: true },
              args: { type: 'object', additionalProperties: true, required: true },
            },
          },
        },
      },
      required: ['operations'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['applied', 'rolledBack', 'results'],
        properties: {
          applied: { type: 'integer' },
          rolledBack: { type: 'boolean' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['tool', 'ok'],
              properties: {
                tool: { type: 'string' },
                ok: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.rolledBack
          ? `Rolled back: ${value.results.filter((r) => r.ok).length} of ${value.results.length} operation(s) ran before the failure; vault restored.`
          : `Applied ${value.applied} operation(s) successfully.`,
      }],
    },
    async execute(args) {
      const ops = args.operations
      if (!Array.isArray(ops) || ops.length === 0) throw new Error('operations must be a non-empty array')
      const allowed = new Set([
        'obsidian_edit', 'obsidian_append', 'obsidian_new',
        'obsidian_delete', 'obsidian_move', 'obsidian_frontmatter',
      ])

      for (const [i, op] of ops.entries()) {
        if (!op || typeof op !== 'object') throw new Error(`operation ${i} must be an object`)
        if (typeof op.tool !== 'string') throw new Error(`operation ${i} is missing "tool"`)
        if (op.tool === 'obsidian_batch') throw new Error('obsidian_batch cannot be nested')
        if (!allowed.has(op.tool)) {
          throw new Error(`operation ${i}: "${op.tool}" is not allowed in a batch; use one of ${[...allowed].join(', ')}`)
        }
        if (op.args === undefined || op.args === null || typeof op.args !== 'object') {
          throw new Error(`operation ${i} is missing "args"`)
        }
      }

      // Snapshot every note touched by the batch BEFORE running anything.
      const snapshot = new Map() // vault-relative path -> text | null (absent)
      const touchedPaths = new Set()
      const collectPaths = (op) => {
        const a = op.args
        for (const key of ['path', 'note', 'from', 'to']) {
          if (typeof a[key] === 'string' && a[key].length > 0) {
            try {
              touchedPaths.add(asNote(displayOf(root, inside(root, a[key]))))
            } catch {
              // A path that cannot resolve is not snapshot-able; the operation
              // itself will report the error.
            }
          }
        }
      }
      for (const op of ops) collectPaths(op)
      if (ops.some((o) => o.tool === 'obsidian_move')) {
        // A move can touch link targets in every note, so snapshot them all.
        for (const rel of await collectNotes(root, Number.MAX_SAFE_INTEGER)) touchedPaths.add(rel)
      }
      for (const rel of touchedPaths) {
        const abs = join(root, rel)
        const existing = await stat(abs).catch(() => undefined)
        if (existing && existing.isFile()) snapshot.set(rel, await readFile(abs, 'utf8'))
        else snapshot.set(rel, null)
      }

      const results = []
      let applied = 0
      let failure = null

      for (const op of ops) {
        const def = registry.get(op.tool)
        try {
          if (!def) throw new Error(`tool "${op.tool}" is not registered`)
          await def.execute(op.args, {})
          results.push({ tool: op.tool, ok: true })
          applied++
        } catch (error) {
          results.push({ tool: op.tool, ok: false, error: String(error?.message ?? error) })
          failure = { op, error }
          break
        }
      }

      if (failure) {
        // Restore every snapshotted note.
        for (const [rel, text] of snapshot) {
          const abs = join(root, rel)
          try {
            if (text === null) {
              await unlink(abs).catch(() => {})
            } else {
              await mkdir(dirname(abs), { recursive: true })
              await writeKeepingEol(abs, text, text)
            }
          } catch {
            // Best effort: keep restoring the rest.
          }
        }
        return ok({ applied, rolledBack: true, results })
      }

      return ok({ applied, rolledBack: false, results })
    },
    presentCall: (args) => ({ card: 'generic', title: `Batch (${args.operations.length} ops)`, kind: 'edit', rawInput: args }),
  })
}
