/**
 * Offline test suite for the plugin.
 *
 * Mounts it against a throwaway vault with a stub registry, drives the tools and
 * asserts on the files on disk — return shapes may evolve, the vault's contents
 * are the contract. Also pins the wire format, because an upstream that
 * validates the tool contract rejects the whole request when a schema is off.
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures.push([name, error.message])
    console.log(`  FAIL  ${name}   <- ${error.message}`)
  }
}

function mount(config) {
  const tools = new Map()
  const ctx = { tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } } }
  apply(ctx, config)
  return tools
}

const exists = async (path) => {
  try { await stat(path); return true } catch { return false }
}

const textOf = (path) => readFile(path, 'utf8')

async function main() {
  const vault = await mkdtemp(join(tmpdir(), 'obsidian-test-'))
  const saved = process.env.OBSIDIAN_VAULT
  process.env.OBSIDIAN_VAULT = vault

  try {
    console.log('\n[wire format]')
    const tools = mount({})

    await check('registers 13 tools', () => assert.equal(tools.size, 13))
    await check('every tool has name, description and execute', () => {
      for (const [name, tool] of tools) {
        assert.equal(tool.name, name)
        assert.ok(tool.description.length > 20 && tool.description.length <= 300,
          `${name}: description should be 20-300 characters, got ${tool.description.length}`)
        assert.equal(typeof tool.execute, 'function', `${name}: no execute`)
      }
    })
    await check('parameters is a minimal JSON Schema', () => {
      for (const [name, tool] of tools) {
        const schema = tool.parameters
        assert.ok(schema && schema.type === 'object', `${name}: parameters.type must be 'object'`)
        assert.equal(typeof schema.properties, 'object', `${name}: properties missing`)
        if ('required' in schema) {
          assert.ok(Array.isArray(schema.required) && schema.required.length > 0,
            `${name}: omit required rather than sending an empty array`)
          for (const key of schema.required) {
            assert.ok(Object.hasOwn(schema.properties, key), `${name}: required '${key}' not in properties`)
          }
        }
      }
    })
    await check('no exotic schema keywords reach the wire', () => {
      const banned = ['enum', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', '$ref', 'pattern']
      for (const [name, tool] of tools) {
        const walk = (node, path) => {
          if (!node || typeof node !== 'object') return
          for (const [key, value] of Object.entries(node)) {
            assert.ok(!banned.includes(key), `${name}${path}.${key} uses a keyword a strict proxy may reject`)
            walk(value, `${path}.${key}`)
          }
        }
        walk(tool.parameters, '')
      }
    })
    await check('no array or object typed parameters', () => {
      for (const [name, tool] of tools) {
        for (const [key, prop] of Object.entries(tool.parameters.properties)) {
          assert.ok(['string', 'integer', 'boolean'].includes(prop.type),
            `${name}.${key}: type '${prop.type}' risks rejection`)
        }
      }
    })
    await check('no output block is declared', () => {
      for (const [name, tool] of tools) {
        assert.equal(tool.output, undefined, `${name}: output blocks are not sent`)
      }
    })

    console.log('\n[bundle contract]')
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    await check('declares dsh.bundle.patch', () => {
      assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
      assert.equal(pkg.private, undefined)
    })
    await check('patch file inserts this package', async () => {
      const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
      assert.ok(patch.includes(pkg.name), 'patch must name this package')
    })
    await check('imports nothing outside node: builtins', async () => {
      const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
      const specifiers = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1])
      assert.deepEqual(specifiers.filter((s) => !s.startsWith('node:')), [])
    })
    await check('no runtime or peer dependencies', () => {
      assert.deepEqual(pkg.dependencies ?? {}, {})
      assert.deepEqual(pkg.peerDependencies ?? {}, {})
    })

    console.log('\n[read and write]')
    await check('info reports the vault', async () => {
      const result = await tools.get('obsidian_info').execute()
      assert.equal(result.exists, true)
      assert.equal(result.notes, 0)
    })
    await check('new writes frontmatter and body', async () => {
      await tools.get('obsidian_new').execute({
        path: 'Projects/Alpha',
        content: '# Alpha',
        tags: 'demo, draft',
        properties: '{"status":"active"}',
      })
      const text = await textOf(join(vault, 'Projects/Alpha.md'))
      assert.match(text, /^---\ntags: \[demo, draft\]\nstatus: active\n---\n\n# Alpha\n$/)
    })
    await check('new refuses to overwrite', () =>
      assert.rejects(tools.get('obsidian_new').execute({ path: 'Projects/Alpha' }), /already exists/))
    await check('list returns the note', async () => {
      const result = await tools.get('obsidian_list').execute({})
      assert.equal(result.total, 1)
      assert.equal(result.notes[0].path, 'Projects/Alpha.md')
    })
    await check('read returns the body', async () => {
      const result = await tools.get('obsidian_read').execute({ path: 'Projects/Alpha' })
      assert.match(result.content, /# Alpha/)
    })
    await check('append adds at the end', async () => {
      await tools.get('obsidian_append').execute({ path: 'Projects/Alpha', content: 'tail' })
      assert.match(await textOf(join(vault, 'Projects/Alpha.md')), /# Alpha\n\ntail\n$/)
    })

    console.log('\n[editing]')
    await check('edit replaces a unique string', async () => {
      await tools.get('obsidian_edit').execute({ path: 'Projects/Alpha', oldText: 'tail', newText: 'end' })
      assert.match(await textOf(join(vault, 'Projects/Alpha.md')), /end\n$/)
    })
    await check('edit refuses an ambiguous match', async () => {
      await tools.get('obsidian_append').execute({ path: 'Projects/Alpha', content: 'dup\ndup' })
      await assert.rejects(
        tools.get('obsidian_edit').execute({ path: 'Projects/Alpha', oldText: 'dup', newText: 'x' }),
        /occurs 2 times/,
      )
    })
    await check('edit replaceLines touches only the range', async () => {
      const file = join(vault, 'Projects/Alpha.md')
      const before = (await textOf(file)).split('\n')
      const idx = before.indexOf('dup')
      await tools.get('obsidian_edit').execute({
        path: 'Projects/Alpha', fromLine: idx + 1, toLine: idx + 2, content: 'one\ntwo',
      })
      const after = (await textOf(file)).split('\n')
      assert.equal(after[idx], 'one')
      assert.equal(after[idx + 1], 'two')
      assert.ok(after.includes('# Alpha'))
    })
    await check('edit rejects an out-of-range line span', () =>
      assert.rejects(tools.get('obsidian_edit').execute({
        path: 'Projects/Alpha', fromLine: 99, toLine: 100, content: 'x',
      }), /outside the note/))

    console.log('\n[frontmatter and query]')
    await check('frontmatter get reads a key', async () => {
      const result = await tools.get('obsidian_frontmatter').execute({
        path: 'Projects/Alpha', action: 'get', key: 'status',
      })
      assert.equal(result.value, 'active')
    })
    await check('frontmatter set keeps other keys', async () => {
      await tools.get('obsidian_frontmatter').execute({
        path: 'Projects/Alpha', action: 'set', key: 'status', value: 'done',
      })
      const text = await textOf(join(vault, 'Projects/Alpha.md'))
      assert.match(text, /status: done/)
      assert.match(text, /tags: \[demo, draft\]/)
    })
    await check('query filters by tag', async () => {
      const result = await tools.get('obsidian_query').execute({ tags: 'demo' })
      assert.equal(result.total, 1)
      assert.equal(result.notes[0].path, 'Projects/Alpha.md')
    })
    await check('query filters by frontmatter value', async () => {
      const result = await tools.get('obsidian_query').execute({ key: 'status', value: 'done' })
      assert.equal(result.total, 1)
    })
    await check('search returns the matching line number', async () => {
      const result = await tools.get('obsidian_search').execute({ query: 'two' })
      assert.equal(result.total, 1)
      assert.ok(result.matches[0].line > 0)
    })

    console.log('\n[move, delete and batch]')
    await check('move rewrites incoming wikilinks', async () => {
      await tools.get('obsidian_new').execute({ path: 'Index', content: 'see [[Alpha]] and [[Alpha|alias]]' })
      const result = await tools.get('obsidian_move').execute({ from: 'Projects/Alpha', to: 'Archive/Beta' })
      assert.equal(result.rewrittenNotes, 1)
      const index = await textOf(join(vault, 'Index.md'))
      assert.match(index, /\[\[Beta\]\]/)
      assert.match(index, /\[\[Beta\|alias\]\]/)
    })
    await check('move refuses an existing destination', () =>
      assert.rejects(tools.get('obsidian_move').execute({ from: 'Index', to: 'Archive/Beta' }), /already exists/))
    await check('delete moves the note to .trash', async () => {
      await tools.get('obsidian_delete').execute({ path: 'Archive/Beta' })
      assert.equal(await exists(join(vault, 'Archive/Beta.md')), false)
      assert.equal(await exists(join(vault, '.trash')), true)
    })
    await check('batch runs steps in order', async () => {
      const result = await tools.get('obsidian_batch').execute({
        steps: JSON.stringify([
          { tool: 'obsidian_new', arguments: { path: 'B1', content: 'one' } },
          { tool: 'obsidian_append', arguments: { path: 'B1', content: 'two' } },
        ]),
      })
      assert.equal(result.completed, 2)
      assert.match(await textOf(join(vault, 'B1.md')), /one\n\ntwo\n/)
    })
    await check('batch stops at the first failure', () =>
      assert.rejects(tools.get('obsidian_batch').execute({
        steps: JSON.stringify([
          { tool: 'obsidian_read', arguments: { path: 'nope' } },
          { tool: 'obsidian_new', arguments: { path: 'B2' } },
        ]),
      }), /step 1/))
    await check('batch rejects an unknown tool', () =>
      assert.rejects(tools.get('obsidian_batch').execute({
        steps: JSON.stringify([{ tool: 'obsidian_nope' }]),
      }), /unknown tool/))

    console.log('\n[fidelity and safety]')
    await check('CRLF survives a write', async () => {
      const file = join(vault, 'crlf.md')
      await writeFile(file, '---\r\nstatus: a\r\n---\r\n\r\n# T\r\n\r\nbody\r\n')
      await tools.get('obsidian_frontmatter').execute({ path: 'crlf', action: 'set', key: 'status', value: 'b' })
      const text = await textOf(file)
      assert.equal((text.match(/\n/g) ?? []).length - (text.match(/\r\n/g) ?? []).length, 0, 'bare LF appeared')
      assert.ok((text.match(/\r\n/g) ?? []).length >= 5)
    })
    await check('BOM survives a write', async () => {
      const file = join(vault, 'bom.md')
      await writeFile(file, '\uFEFF---\nstatus: a\n---\n\n# BOM\n')
      await tools.get('obsidian_frontmatter').execute({ path: 'bom', action: 'set', key: 'status', value: 'b' })
      const bytes = await readFile(file)
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf')
    })
    await check('path traversal is refused', () =>
      assert.rejects(tools.get('obsidian_read').execute({ path: '../../etc/passwd' }), /escapes the vault/))
    await check('absolute paths are refused', () =>
      assert.rejects(tools.get('obsidian_read').execute({ path: 'C:/Windows/win.ini' }), /vault-relative/))
    await check('writing into .obsidian is refused', () =>
      assert.rejects(tools.get('obsidian_new').execute({ path: '.obsidian/evil' }), /application state/))
    await check('no temp files are left behind', async () => {
      const stray = (await readdir(vault, { recursive: true })).filter((name) => String(name).endsWith('.tmp'))
      assert.deepEqual(stray, [])
    })

    console.log('\n[host faults]')
    await check('a missing registry does not throw', () => {
      const savedError = console.error
      console.error = () => {}
      try {
        assert.doesNotThrow(() => apply({}, {}))
        assert.doesNotThrow(() => apply({ tools: {} }, {}))
      } finally {
        console.error = savedError
      }
    })
    await check('a rejected definition does not stop the others', () => {
      let attempts = 0
      const savedError = console.error
      console.error = () => {}
      try {
        apply({
          tools: {
            register: () => {
              attempts += 1
              if (attempts === 1) throw new Error('contract changed')
            },
          },
        }, {})
      } finally {
        console.error = savedError
      }
      assert.equal(attempts, 13)
    })
  } finally {
    if (saved === undefined) delete process.env.OBSIDIAN_VAULT
    else process.env.OBSIDIAN_VAULT = saved
    await rm(vault, { recursive: true, force: true })
  }

  const total = passed + failures.length
  console.log(`\n${passed}/${total} checks passed`)
  if (failures.length > 0) {
    console.log('\nfailures:')
    for (const [name, detail] of failures) console.log(`  - ${name}  <- ${detail}`)
    process.exitCode = 1
  }
}

main()
