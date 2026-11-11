/**
 * Offline smoke test for the plugin.
 *
 * Mounts the plugin against a throwaway vault with a stub tool registry, then
 * drives the tools and asserts on the files on disk - the tools' return shapes
 * may evolve, but the vault's contents are the contract that matters.
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

/** Mount the plugin with a capturing registry and return the registered tools. */
function mount(config) {
  const tools = new Map()
  const ctx = { tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } } }
  apply(ctx, config)
  return tools
}

/** Run a check with console.error muted, for cases that intentionally log. */
function silence(fn) {
  const saved = console.error
  console.error = () => {}
  try { return fn() } finally { console.error = saved }
}

const exists = async (path) => {
  try { await stat(path); return true } catch { return false }
}

async function main() {
  const vault = await mkdtemp(join(tmpdir(), 'dsh-obsidian-'))
  const saved = { OBSIDIAN_VAULT: process.env.OBSIDIAN_VAULT }
  process.env.OBSIDIAN_VAULT = vault

  try {
    console.log('\n[contract]')
    const tools = mount({})

    await check('registers 13 tools', () => assert.equal(tools.size, 13))
    await check('every tool has a description and execute', () => {
      for (const [name, tool] of tools) {
        assert.equal(tool.name, name)
        assert.ok(tool.description.length > 20, `${name} has a thin description`)
        assert.equal(typeof tool.execute, 'function', `${name} has no execute`)
      }
    })
    await check('obsidian_info is safe without a vault', async () => {
      const result = await tools.get('obsidian_info').execute()
      assert.equal(result.exists, true)
      assert.equal(result.noteCount, 0)
    })

    console.log('\n[create / read / list]')
    await check('new writes a note with frontmatter', async () => {
      await tools.get('obsidian_new').execute({
        path: 'Projects/Alpha',
        content: '# Alpha\n\nFirst line.\n',
        frontmatter: { tags: ['demo'], status: 'draft' },
      })
      const text = await readFile(join(vault, 'Projects/Alpha.md'), 'utf8')
      assert.match(text, /^---\n/)
      assert.match(text, /status: draft|status: "draft"/)
      assert.match(text, /# Alpha/)
    })
    await check('new refuses to overwrite', () =>
      assert.rejects(tools.get('obsidian_new').execute({ path: 'Projects/Alpha', content: 'x' })))
    await check('list finds the note', async () => {
      const result = await tools.get('obsidian_list').execute({})
      assert.equal(result.total, 1)
      assert.equal(result.notes[0].path, 'Projects/Alpha.md')
    })
    await check('read returns the body', async () => {
      const result = await tools.get('obsidian_read').execute({ path: 'Projects/Alpha' })
      assert.match(JSON.stringify(result), /First line/)
    })

    console.log('\n[editing]')
    await check('replace rewrites exactly once', async () => {
      await tools.get('obsidian_edit').execute({
        path: 'Projects/Alpha', action: 'replace', oldString: 'First line.', newString: 'Second line.',
      })
      assert.match(await readFile(join(vault, 'Projects/Alpha.md'), 'utf8'), /Second line\./)
    })
    await check('replace rejects an ambiguous match', async () => {
      await tools.get('obsidian_append').execute({ path: 'Projects/Alpha', content: '\ndup\ndup\n' })
      await assert.rejects(tools.get('obsidian_edit').execute({
        path: 'Projects/Alpha', action: 'replace', oldString: 'dup', newString: 'x',
      }), /occurs 2 times/)
    })
    await check('replaceLines touches only the range', async () => {
      const file = join(vault, 'Projects/Alpha.md')
      const before = (await readFile(file, 'utf8')).split('\n')
      const heading = before.indexOf('# Alpha')
      assert.ok(heading >= 0, 'fixture should still carry the heading')
      await tools.get('obsidian_edit').execute({
        path: 'Projects/Alpha',
        action: 'replaceLines',
        fromLine: heading + 3,
        toLine: heading + 4,
        content: 'kept\ndup',
      })
      const lines = (await readFile(file, 'utf8')).split('\n')
      assert.equal(lines[heading + 2], 'kept')
      assert.ok(lines.includes('# Alpha'), 'the heading above the range must survive')
    })
    await check('append adds at the end', async () => {
      await tools.get('obsidian_append').execute({ path: 'Projects/Alpha', content: 'tail-marker' })
      assert.match(await readFile(join(vault, 'Projects/Alpha.md'), 'utf8'), /tail-marker\n?$/)
    })

    console.log('\n[frontmatter / search / query]')
    await check('frontmatter set keeps other keys', async () => {
      await tools.get('obsidian_frontmatter').execute({
        path: 'Projects/Alpha', action: 'set', key: 'status', value: 'done',
      })
      const text = await readFile(join(vault, 'Projects/Alpha.md'), 'utf8')
      assert.match(text, /status: done|status: "done"/)
      assert.match(text, /tags:/)
    })
    await check('search finds a body term', async () => {
      const result = await tools.get('obsidian_search').execute({ query: 'tail-marker' })
      assert.match(JSON.stringify(result), /Alpha/)
    })
    await check('query filters by tag', async () => {
      const result = await tools.get('obsidian_query').execute({ tags: ['demo'] })
      assert.match(JSON.stringify(result), /Alpha/)
    })

    console.log('\n[move / delete]')
    await check('move rewrites incoming wikilinks', async () => {
      await tools.get('obsidian_new').execute({ path: 'Index', content: 'see [[Alpha]] and [[Alpha|alias]]\n' })
      await tools.get('obsidian_move').execute({ from: 'Projects/Alpha', to: 'Archive/Beta' })
      const text = await readFile(join(vault, 'Index.md'), 'utf8')
      assert.match(text, /\[\[Beta\]\]/, 'bare wikilink should follow the rename')
      assert.match(text, /\[\[Beta\|alias\]\]/, 'aliased wikilink should follow the rename')
      assert.equal(await exists(join(vault, 'Archive/Beta.md')), true)
    })
    await check('delete moves the note into .trash', async () => {
      await tools.get('obsidian_delete').execute({ path: 'Archive/Beta' })
      assert.equal(await exists(join(vault, 'Archive/Beta.md')), false)
      assert.equal(await exists(join(vault, '.trash')), true)
    })

    console.log('\n[fidelity and safety]')
    await check('CRLF survives an edit', async () => {
      const file = join(vault, 'crlf.md')
      await writeFile(file, '---\r\nstatus: a\r\n---\r\n\r\n# T\r\n\r\nbody\r\n')
      await tools.get('obsidian_frontmatter').execute({ path: 'crlf', action: 'set', key: 'status', value: 'b' })
      const bytes = await readFile(file)
      const crlf = (bytes.toString('utf8').match(/\r\n/g) ?? []).length
      const lf = (bytes.toString('utf8').match(/\n/g) ?? []).length - crlf
      assert.equal(lf, 0, `expected no bare LF, found ${lf}`)
      assert.ok(crlf >= 5, `expected CRLF to survive, found ${crlf}`)
    })
    await check('BOM survives an edit', async () => {
      const file = join(vault, 'bom.md')
      await writeFile(file, '\uFEFF---\nstatus: a\n---\n\n# BOM note\n')
      await tools.get('obsidian_frontmatter').execute({ path: 'bom', action: 'set', key: 'status', value: 'b' })
      const bytes = await readFile(file)
      assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf', 'BOM should still lead the file')
    })
    await check('path traversal is refused', () =>
      assert.rejects(tools.get('obsidian_read').execute({ path: '../../etc/passwd' }), /escapes the vault/))
    await check('absolute paths are refused', () =>
      assert.rejects(tools.get('obsidian_read').execute({ path: '/etc/passwd' }), /vault-relative|escapes/))
    await check('no temp files are left behind', async () => {
      const { readdir } = await import('node:fs/promises')
      const stray = (await readdir(vault, { recursive: true })).filter((name) => name.endsWith('.tmp'))
      assert.deepEqual(stray, [])
    })

    console.log('\n[host compatibility]')
    await check('survives a host without a tool registry', () => {
      silence(() => {
        assert.doesNotThrow(() => apply({}, {}), 'missing registry must not throw')
        assert.doesNotThrow(() => apply(undefined, undefined), 'missing ctx must not throw')
        assert.doesNotThrow(() => apply({ tools: {} }, {}), 'registry without register must not throw')
      })
    })
    await check('one rejected definition does not stop the others', () => {
      let attempts = 0
      const ctx = {
        tools: {
          register: () => {
            attempts += 1
            if (attempts === 1) throw new Error('definition contract changed')
          },
        },
      }
      silence(() => assert.doesNotThrow(() => apply(ctx, {})))
      assert.equal(attempts, 13, 'every tool should still be offered to the host')
    })
    await check('a broken registry does not break a working mount', async () => {
      const tools = mount({})
      const result = await tools.get('obsidian_info').execute()
      assert.equal(result.exists, true)
    })

    console.log('\n[bundle contract]')
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    await check('package.json declares dsh.bundle.patch', () => {
      assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
      assert.equal(pkg.name, '@jinferth/dsh-obsidian-vault')
      assert.equal(pkg.private, undefined, 'a private package cannot be installed as a bundle')
    })
    await check('the patch file inserts this package', async () => {
      const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
      assert.match(patch, /-\s*insert:/, 'patch must be an insert list')
      assert.ok(patch.includes(pkg.name), 'patch must name this package')
    })
    await check('index exports the plugin contract', async () => {
      const mod = await import('../index.js')
      assert.equal(typeof mod.apply, 'function')
      assert.deepEqual(mod.inject, ['tools'])
      assert.ok(mod.name, 'plugin must export a name')
    })
    await check('imports nothing outside node: builtins', async () => {
      const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
      const specifiers = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1])
      const external = specifiers.filter((spec) => !spec.startsWith('node:'))
      // This is the anti-breakage guard: an external import would tie the plugin
      // to a package version that a Harness release can invalidate.
      assert.deepEqual(external, [], `unexpected external imports: ${external.join(', ')}`)
    })
    await check('declares no runtime dependencies', () => {
      assert.deepEqual(pkg.dependencies ?? {}, {})
      assert.deepEqual(pkg.peerDependencies ?? {}, {})
    })

    console.log('\n[unconfigured state]')
    await check('tools fail loudly when no vault is configured', async () => {
      delete process.env.OBSIDIAN_VAULT
      const blank = await mkdtemp(join(tmpdir(), 'dsh-nohome-'))
      const savedEnv = { APPDATA: process.env.APPDATA, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
      process.env.APPDATA = blank
      process.env.HOME = blank
      process.env.XDG_CONFIG_HOME = blank
      try {
        const bare = mount({})
        const info = await bare.get('obsidian_info').execute()
        assert.equal(info.vaultPath, '')
        await assert.rejects(bare.get('obsidian_list').execute({}), /No Obsidian vault is configured/)
      } finally {
        Object.assign(process.env, savedEnv)
        await rm(blank, { recursive: true, force: true })
      }
    })
  } finally {
    if (saved.OBSIDIAN_VAULT === undefined) delete process.env.OBSIDIAN_VAULT
    else process.env.OBSIDIAN_VAULT = saved.OBSIDIAN_VAULT
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
