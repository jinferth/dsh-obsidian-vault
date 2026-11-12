/**
 * dsh-obsidian-vault — Obsidian vault tools for DeepSeek Harness.
 *
 * A vault is a directory of Markdown files; these tools read and write it
 * directly, so Obsidian need not be running.
 *
 * Wire-format policy — this is the part that matters when traffic goes through
 * an upstream that validates the tool contract more strictly than the harness
 * does. Every tool declares parameters as a plain JSON Schema built only from
 * `type`, `properties` and `required`: no `enum`, no `additionalProperties`, no
 * array- or object-valued properties, no `output` block. A proxy that rejects
 * anything outside that subset answers 400 for the whole request, so the shape
 * is deliberately boring.
 */

import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'obsidian-vault'
export const inject = ['tools']

/** Directories holding application state rather than notes. */
const IGNORED = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.stfolder'])

/** Guard against pulling a huge file into the transcript by accident. */
const MAX_TEXT = 400_000

class VaultError extends Error {}

// ---------------------------------------------------------------------------
// vault resolution
// ---------------------------------------------------------------------------

function registryFile() {
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

/** config.vaultPath → OBSIDIAN_VAULT → the vault Obsidian last opened. */
function resolveVault(config) {
  const explicit = config?.vaultPath || process.env.OBSIDIAN_VAULT
  if (explicit) return resolve(String(explicit))
  try {
    const data = JSON.parse(readFileSync(registryFile(), 'utf8'))
    const vaults = Object.values(data?.vaults ?? {}).filter((entry) => entry?.path)
    const chosen = vaults.find((entry) => entry.open) ?? (vaults.length === 1 ? vaults[0] : null)
    if (chosen) return resolve(chosen.path)
  } catch {
    // No registry on this machine: the tools report the unconfigured state.
  }
  return null
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Resolve a vault-relative path, rejecting absolute paths and `..` escapes. */
function locate(root, input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new VaultError('path is required')
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new VaultError(`path must be vault-relative, got "${input}"`)
  }
  const abs = resolve(root, raw.replace(/\\/g, '/'))
  const back = relative(root, abs)
  if (back.startsWith('..') || isAbsolute(back)) {
    throw new VaultError(`path escapes the vault: ${input}`)
  }
  return { rel: back.split(sep).join('/'), abs }
}

/** Same as locate, but appends `.md` when the caller omitted the extension. */
function notePath(root, input) {
  const first = locate(root, input)
  if (/\.md$/i.test(first.rel)) return first
  return locate(root, `${first.rel}.md`)
}

/** Notes are writable; application state is not. */
function assertWritable(rel) {
  for (const part of rel.split('/')) {
    if (IGNORED.has(part.toLowerCase())) {
      throw new VaultError(`refusing to write inside ${part}/ — that is application state, not notes`)
    }
  }
}

// ---------------------------------------------------------------------------
// note IO
// ---------------------------------------------------------------------------

/**
 * Read a note, remembering its line endings and BOM so a write can restore them.
 * Rewriting an LF file as CRLF churns every line in Git even when nothing changed.
 */
async function readNote(abs) {
  const buf = await readFile(abs)
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const text = (bom ? buf.subarray(3) : buf).toString('utf8')
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return {
    text: text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    eol: crlf > lf ? '\r\n' : '\n',
    bom,
  }
}

/**
 * Replace a note atomically, preserving the original line endings and BOM.
 * A sibling temp file means an interrupted run cannot leave a truncated note.
 */
async function writeNote(abs, text, meta = {}) {
  const eol = meta.eol ?? '\n'
  let body = text.replace(/\r\n/g, '\n')
  if (eol === '\r\n') body = body.replace(/\n/g, '\r\n')
  const data = Buffer.from((meta.bom ? '\uFEFF' : '') + body, 'utf8')
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, abs)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

async function exists(abs) {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

/** Vault-relative paths of every Markdown note, in a stable order. */
async function collectNotes(root) {
  const found = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name.toLowerCase())) continue
        await walk(join(dir, entry.name))
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        found.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
      }
    }
  }
  await walk(root)
  return found
}

// ---------------------------------------------------------------------------
// frontmatter — edited line by line so untouched keys keep their exact text
// ---------------------------------------------------------------------------

function splitFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { block: null, body: text }
  return { block: match[1], body: text.slice(match[0].length) }
}

function formatValue(value) {
  const text = String(value ?? '')
  if (text === '') return '""'
  if (/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .\-/]*$/.test(text)) return text
  return JSON.stringify(text)
}

const keyRe = (key, suffix = '.*') =>
  new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[ \\t]*${suffix}$`, 'm')

function readKey(block, key) {
  if (block === null) return null
  const hit = keyRe(key, '(.*)').exec(block)
  if (!hit) return null
  const raw = hit[1].trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1')
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map((v) => v.trim().replace(/^["'](.*)["']$/s, '$1'))
  }
  return raw
}

/** Write `key: value`, replacing the existing line when present. */
function setKey(block, key, value) {
  return writeKeyLine(block, key, `${key}: ${formatValue(value)}`)
}

/** Write an already-formatted `key: ...` line, for values like inline lists. */
function writeKeyLine(block, key, line) {
  const base = block ?? ''
  if (keyRe(key, '.*').test(base)) return base.replace(keyRe(key, '.*'), line)
  return base === '' ? line : `${base}\n${line}`
}

function dropKey(block, key) {
  if (block === null) return null
  return block.replace(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*\\n?`, 'm'), '')
}

function joinFrontmatter(block, body) {
  if (block === null || block.trim() === '') return body
  return `---\n${block.replace(/\n+$/, '')}\n---\n\n${body.replace(/^\n+/, '')}`
}

// ---------------------------------------------------------------------------
// wikilinks
// ---------------------------------------------------------------------------

const WIKILINK = /\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]/g
const MDLINK = /\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g

function titleOf(rel) {
  return basename(rel).replace(/\.md$/i, '')
}

/**
 * Rewrite links that pointed at `oldRel` so they point at `newRel`.
 * Obsidian resolves `[[name]]` by file name, so a pure folder move needs no
 * rewrite — only a rename changes the link text.
 */
function rewriteLinks(text, oldRel, newRel) {
  const oldName = titleOf(oldRel)
  const newName = titleOf(newRel)
  if (oldName === newName) return text
  return text
    .replace(WIKILINK, (whole, target, anchor, alias) => (
      target.trim() === oldName ? `[[${newName}${anchor ?? ''}${alias ?? ''}]]` : whole
    ))
    .replace(MDLINK, (whole, target, anchor) => (
      target === oldRel || target === `/${oldRel}` ? `](${newRel}${anchor ?? ''})` : whole
    ))
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Register the vault tools.
 *
 * Degrades rather than throws: a missing registry, an unresolvable vault or a
 * rejected definition must never take the host profile down. Each failure is
 * logged and the remaining tools still register.
 */
export function apply(ctx, config) {
  const tools = ctx?.tools
  if (!tools || typeof tools.register !== 'function') {
    console.error('[obsidian-vault] ctx.tools.register is unavailable; nothing was registered')
    return
  }

  let root = null
  try {
    root = resolveVault(config)
  } catch (error) {
    console.error(`[obsidian-vault] could not resolve a vault: ${error?.message}`)
  }

  const need = () => {
    if (!root) {
      throw new Error(
        'No Obsidian vault is configured. Set config.vaultPath in cordis.patch.yml, '
        + 'set OBSIDIAN_VAULT, or open a vault once in Obsidian so it registers itself.',
      )
    }
    return root
  }

  const definitions = []
  const tool = (spec) => definitions.push(spec)

  // 1 ------------------------------------------------------------------
  tool({
    name: 'obsidian_info',
    description: 'Report the connected Obsidian vault: its absolute path, whether it exists, and how many Markdown notes it holds.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      if (!root) return { vault: '', exists: false, notes: 0 }
      const ok = await exists(root)
      return { vault: root, exists: ok, notes: ok ? (await collectNotes(root)).length : 0 }
    },
  })

  // 2 ------------------------------------------------------------------
  tool({
    name: 'obsidian_list',
    description: 'List Markdown notes, optionally limited to one folder. Returns vault-relative paths with size and modification time.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Vault-relative folder; omit for the whole vault.' },
        limit: { type: 'integer', description: 'Maximum notes to return. Defaults to 200.' },
      },
    },
    async execute(args) {
      const base = need()
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 200
      const prefix = String(args?.directory ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const all = await collectNotes(base)
      const scoped = prefix ? all.filter((rel) => rel === prefix || rel.startsWith(`${prefix}/`)) : all
      const slice = scoped.slice(0, limit)
      const notes = []
      for (const rel of slice) {
        const info = await stat(join(base, rel))
        notes.push({ path: rel, size: info.size, modified: info.mtime.toISOString() })
      }
      return { notes, total: scoped.length, truncated: scoped.length > slice.length }
    },
  })

  // 3 ------------------------------------------------------------------
  tool({
    name: 'obsidian_read',
    description: 'Read one note by its vault-relative path and return its full Markdown text. The ".md" extension may be omitted.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path, for example "Projects/Roadmap".' },
      },
      required: ['path'],
    },
    async execute(args) {
      const base = need()
      const { rel, abs } = notePath(base, args?.path)
      if (!(await exists(abs))) throw new VaultError(`note not found: ${rel}`)
      const note = await readNote(abs)
      const content = note.text.length > MAX_TEXT
        ? `${note.text.slice(0, MAX_TEXT)}\n\n[truncated: ${note.text.length} characters total]`
        : note.text
      return { path: rel, characters: note.text.length, content }
    },
  })

  // 4 ------------------------------------------------------------------
  tool({
    name: 'obsidian_search',
    description: 'Search note text for a literal string, case-insensitive, and return each hit as path plus line number.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to find.' },
        limit: { type: 'integer', description: 'Maximum hits to return. Defaults to 50.' },
      },
      required: ['query'],
    },
    async execute(args) {
      const base = need()
      const needle = String(args?.query ?? '').toLowerCase()
      if (!needle) throw new VaultError('query is required')
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 50
      const matches = []
      for (const rel of await collectNotes(base)) {
        if (matches.length >= limit) break
        const note = await readNote(join(base, rel))
        const lines = note.text.split('\n')
        for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
          }
        }
      }
      return { matches, total: matches.length, truncated: matches.length >= limit }
    },
  })

  // 5 ------------------------------------------------------------------
  tool({
    name: 'obsidian_new',
    description: 'Create a note with optional body text, comma-separated tags and extra frontmatter keys. Fails when the note already exists.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path; ".md" is added when missing.' },
        content: { type: 'string', description: 'Markdown body to write.' },
        tags: { type: 'string', description: 'Comma-separated tags, for example "meeting,weekly".' },
        properties: { type: 'string', description: 'Extra frontmatter as a JSON object string, for example {"status":"draft"}.' },
      },
      required: ['path'],
    },
    async execute(args) {
      const base = need()
      const { rel, abs } = notePath(base, args?.path)
      assertWritable(rel)
      if (await exists(abs)) throw new VaultError(`note already exists: ${rel}`)

      let block = null
      const tags = String(args?.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean)
      if (tags.length > 0) block = writeKeyLine(null, 'tags', `tags: [${tags.join(', ')}]`)

      const extra = String(args?.properties ?? '').trim()
      if (extra) {
        let parsed
        try {
          parsed = JSON.parse(extra)
        } catch {
          throw new VaultError('properties must be a JSON object string')
        }
        for (const [key, value] of Object.entries(parsed ?? {})) block = setKey(block, key, value)
      }

      const body = String(args?.content ?? '').replace(/\r\n/g, '\n')
      const tail = body === '' || body.endsWith('\n') ? body : `${body}\n`
      const text = `${block === null ? '' : `---\n${block}\n---\n\n`}${tail}`
      await writeNote(abs, text, { eol: '\n', bom: false })
      return { path: rel, characters: text.length, created: true }
    },
  })

  // 6 ------------------------------------------------------------------
  tool({
    name: 'obsidian_append',
    description: 'Append Markdown to the end of a note, creating the note when it does not exist yet.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path.' },
        content: { type: 'string', description: 'Markdown to append.' },
      },
      required: ['path', 'content'],
    },
    async execute(args) {
      const base = need()
      const { rel, abs } = notePath(base, args?.path)
      assertWritable(rel)
      const chunk = String(args?.content ?? '').replace(/\r\n/g, '\n')
      if (!chunk) throw new VaultError('content is required')
      const tail = chunk.endsWith('\n') ? chunk : `${chunk}\n`

      if (!(await exists(abs))) {
        await writeNote(abs, tail, { eol: '\n', bom: false })
        return { path: rel, created: true, characters: tail.length }
      }
      const note = await readNote(abs)
      const sep = note.text === '' || note.text.endsWith('\n\n') ? '' : (note.text.endsWith('\n') ? '\n' : '\n\n')
      const text = `${note.text}${sep}${tail}`
      await writeNote(abs, text, note)
      return { path: rel, created: false, characters: text.length }
    },
  })

  // 7 ------------------------------------------------------------------
  tool({
    name: 'obsidian_edit',
    description: 'Edit a note in place: replace one literal string (unique unless replaceAll), or replace lines fromLine..toLine with content. Line numbers start at 1 and match obsidian_read.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path.' },
        oldText: { type: 'string', description: 'Exact text to replace. Omit to use the line range instead.' },
        newText: { type: 'string', description: 'Replacement text for oldText.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
        fromLine: { type: 'integer', description: 'First line to replace, 1-based and inclusive.' },
        toLine: { type: 'integer', description: 'Last line to replace, 1-based and inclusive.' },
        content: { type: 'string', description: 'Replacement text for the line range.' },
      },
      required: ['path'],
    },
    async execute(args) {
      const base = need()
      const { rel, abs } = notePath(base, args?.path)
      assertWritable(rel)
      if (!(await exists(abs))) throw new VaultError(`note not found: ${rel}`)
      const note = await readNote(abs)
      const before = note.text
      let after

      if (typeof args?.oldText === 'string' && args.oldText !== '') {
        const hits = before.split(args.oldText).length - 1
        if (hits === 0) throw new VaultError(`oldText was not found in ${rel}`)
        if (hits > 1 && args.replaceAll !== true) {
          throw new VaultError(`oldText occurs ${hits} times in ${rel}; add more context or set replaceAll`)
        }
        const replacement = String(args?.newText ?? '')
        after = args.replaceAll === true
          ? before.split(args.oldText).join(replacement)
          : before.replace(args.oldText, () => replacement)
      } else {
        const from = Number(args?.fromLine)
        const to = Number(args?.toLine ?? args?.fromLine)
        const lines = before.split('\n')
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          throw new VaultError('pass oldText, or fromLine with toLine, to choose what to replace')
        }
        if (from < 1 || to < from || to > lines.length) {
          throw new VaultError(`line range ${from}..${to} is outside the note (1..${lines.length})`)
        }
        const block = String(args?.content ?? '').replace(/\r\n/g, '\n').split('\n')
        after = [...lines.slice(0, from - 1), ...block, ...lines.slice(to)].join('\n')
      }

      if (after === before) return { path: rel, changed: false }
      await writeNote(abs, after, note)
      return { path: rel, changed: true, characters: after.length }
    },
  })

  // 8 ------------------------------------------------------------------
  tool({
    name: 'obsidian_delete',
    description: 'Move a note into the vault trash folder so it stays recoverable. Pass permanent true only for irreversible deletion.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path.' },
        permanent: { type: 'boolean', description: 'Delete from disk instead of moving to .trash.' },
      },
      required: ['path'],
    },
    async execute(args) {
      const base = need()
      const { rel, abs } = notePath(base, args?.path)
      if (!(await exists(abs))) throw new VaultError(`note not found: ${rel}`)
      if (args?.permanent === true) {
        await unlink(abs)
        return { path: rel, permanent: true }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const name = `${stamp} ${basename(rel)}`
      const target = join(base, '.trash', name)
      await mkdir(dirname(target), { recursive: true })
      await rename(abs, target)
      return { path: rel, permanent: false, trashedAs: `.trash/${name}` }
    },
  })

  // 9 ------------------------------------------------------------------
  tool({
    name: 'obsidian_move',
    description: 'Move or rename a note and rewrite the wikilinks pointing at it. Links change only when the file name changes; a folder move needs no rewrite.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current vault-relative path.' },
        to: { type: 'string', description: 'New vault-relative path; ".md" is added when missing.' },
      },
      required: ['from', 'to'],
    },
    async execute(args) {
      const base = need()
      const src = notePath(base, args?.from)
      const dst = notePath(base, args?.to)
      assertWritable(dst.rel)
      if (!(await exists(src.abs))) throw new VaultError(`note not found: ${src.rel}`)
      if (src.rel === dst.rel) throw new VaultError('source and destination are identical')
      if (await exists(dst.abs)) throw new VaultError(`destination already exists: ${dst.rel}`)

      await mkdir(dirname(dst.abs), { recursive: true })
      await rename(src.abs, dst.abs)

      let rewrittenNotes = 0
      if (titleOf(src.rel) !== titleOf(dst.rel)) {
        for (const rel of await collectNotes(base)) {
          const abs = join(base, rel)
          const note = await readNote(abs)
          const next = rewriteLinks(note.text, src.rel, dst.rel)
          if (next !== note.text) {
            await writeNote(abs, next, note)
            rewrittenNotes += 1
          }
        }
      }
      return { from: src.rel, to: dst.rel, rewrittenNotes }
    },
  })

  // 10 -----------------------------------------------------------------
  tool({
    name: 'obsidian_frontmatter',
    description: 'Read, set or delete one YAML frontmatter key without touching the body or the other keys.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative note path.' },
        action: { type: 'string', description: 'One of: get, set, delete.' },
        key: { type: 'string', description: 'Frontmatter key.' },
        value: { type: 'string', description: 'Value to set; ignored for get and delete.' },
      },
      required: ['path', 'action', 'key'],
    },
    async execute(args) {
      const base = need()
      const { rel, abs } = notePath(base, args?.path)
      assertWritable(rel)
      if (!(await exists(abs))) throw new VaultError(`note not found: ${rel}`)
      const note = await readNote(abs)
      const { block, body } = splitFrontmatter(note.text)
      const action = String(args?.action ?? 'get')
      const key = String(args?.key ?? '')
      if (!key) throw new VaultError('key is required')

      if (action === 'get') return { path: rel, key, value: readKey(block, key) }
      if (action === 'set') {
        const next = setKey(block, key, args?.value ?? '')
        const text = joinFrontmatter(next, body)
        await writeNote(abs, text, note)
        return { path: rel, key, value: readKey(next, key), changed: text !== note.text }
      }
      if (action === 'delete') {
        const next = dropKey(block, key)
        const text = joinFrontmatter(next, body)
        await writeNote(abs, text, note)
        return { path: rel, key, deleted: next !== block }
      }
      throw new VaultError(`unknown action "${action}"; expected get, set or delete`)
    },
  })

  // 11 -----------------------------------------------------------------
  tool({
    name: 'obsidian_query',
    description: 'Find notes by tag or by a frontmatter key, optionally restricted to one folder. Multiple tags must all be present.',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'string', description: 'Comma-separated tags.' },
        key: { type: 'string', description: 'Frontmatter key to test, for example "status".' },
        value: { type: 'string', description: 'Required value for that key.' },
        directory: { type: 'string', description: 'Vault-relative folder to search in.' },
      },
    },
    async execute(args) {
      const base = need()
      const wanted = String(args?.tags ?? '').split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
      const key = String(args?.key ?? '').trim()
      const value = String(args?.value ?? '').trim().toLowerCase()
      const prefix = String(args?.directory ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

      const notes = []
      for (const rel of await collectNotes(base)) {
        if (prefix && !(rel === prefix || rel.startsWith(`${prefix}/`))) continue
        const note = await readNote(join(base, rel))
        const { block } = splitFrontmatter(note.text)
        if (wanted.length > 0) {
          const raw = readKey(block, 'tags') ?? readKey(block, 'tag')
          const owned = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/))
            .map((t) => String(t).replace(/^#/, '').toLowerCase())
          if (!wanted.every((t) => owned.includes(t))) continue
        }
        if (key) {
          const actual = readKey(block, key)
          if (actual === null) continue
          if (value && String(actual).toLowerCase() !== value) continue
        }
        notes.push({ path: rel, title: titleOf(rel) })
      }
      return { notes, total: notes.length }
    },
  })

  // 12 -----------------------------------------------------------------
  tool({
    name: 'obsidian_insert_image',
    description: 'Copy an image into the vault and return the Markdown snippet that embeds it. Optionally append that snippet to a note.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the image on this machine.' },
        name: { type: 'string', description: 'File name to use inside the vault.' },
        folder: { type: 'string', description: 'Vault folder for the image. Defaults to attachments.' },
        note: { type: 'string', description: 'Optional note to append the embed snippet to.' },
      },
      required: ['source'],
    },
    async execute(args) {
      const base = need()
      const source = String(args?.source ?? '')
      if (!source || !isAbsolute(source)) throw new VaultError('source must be an absolute path')
      if (!(await exists(source))) throw new VaultError(`file not found: ${source}`)

      const folder = String(args?.folder ?? 'attachments').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'attachments'
      const fileName = String(args?.name ?? basename(source))
      const target = locate(base, `${folder}/${fileName}`)
      assertWritable(target.rel)
      await mkdir(dirname(target.abs), { recursive: true })
      await copyFile(source, target.abs)

      const snippet = `![[${target.rel}]]`
      if (args?.note) {
        const { rel, abs } = notePath(base, args.note)
        assertWritable(rel)
        if (await exists(abs)) {
          const note = await readNote(abs)
          const sep = note.text.endsWith('\n') ? '\n' : '\n\n'
          await writeNote(abs, `${note.text}${sep}${snippet}\n`, note)
        } else {
          await writeNote(abs, `${snippet}\n`, { eol: '\n', bom: false })
        }
      }
      return { path: target.rel, snippet }
    },
  })

  // 13 -----------------------------------------------------------------
  tool({
    name: 'obsidian_batch',
    description: 'Run several note operations in order, stopping at the first failure. Pass a JSON array string of {"tool","arguments"} steps.',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'string', description: 'JSON array of steps, for example [{"tool":"obsidian_new","arguments":{"path":"A"}}].' },
      },
      required: ['steps'],
    },
    async execute(args) {
      let steps
      try {
        steps = JSON.parse(String(args?.steps ?? ''))
      } catch {
        throw new VaultError('steps must be a JSON array string')
      }
      if (!Array.isArray(steps) || steps.length === 0) throw new VaultError('steps must be a non-empty array')

      const done = []
      for (const step of steps) {
        const toolName = String(step?.tool ?? '')
        const target = definitions.find((d) => d.name === toolName && toolName !== 'obsidian_batch')
        if (!target) throw new VaultError(`step ${done.length + 1}: unknown tool "${toolName}"`)
        try {
          await target.execute(step?.arguments ?? {})
        } catch (error) {
          throw new VaultError(`step ${done.length + 1} (${toolName}) failed: ${error?.message}`)
        }
        done.push(toolName)
      }
      return { completed: done.length, steps: done }
    },
  })

  for (const definition of definitions) {
    try {
      tools.register(definition)
    } catch (error) {
      // One rejected definition must not cost the user the other twelve tools.
      console.error(`[obsidian-vault] the host refused "${definition.name}": ${error?.message}`)
    }
  }
}
