// What each side of src/ may import: the panel runs without Node, and shared/ is loaded by both
// sides, so neither reaches for node: modules or worker code (CLAUDE.md, Layout).
import { assert, test } from 'orca/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'

const src = join(import.meta.dirname, '..', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// Each side's files: its folder, and its entry (`src/panel.tsx`, `src/worker.ts`).
const SIDES: Record<string, string[]> = {
  panel: [...sources(join(src, 'panel')), join(src, 'panel.tsx')],
  worker: [...sources(join(src, 'worker')), join(src, 'worker.ts')],
  shared: sources(join(src, 'shared')),
  all: sources(src),
}

type Import = { specifier: string; typeOnly: boolean }

/** The code with its comments left out. Strings and template literals are read past, so a `/*` or
 *  `//` inside one (`'src/*'`, a URL) does not start a comment. */
function withoutComments(code: string): string {
  let out = ''
  let i = 0
  // Open template literals, and the `${` depth inside each, so a `}` closes the right one.
  const templates: number[] = []
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (templates.length && templates[templates.length - 1] === 0 && c !== '`') {
      // Template text: read up to its end or the next `${`.
      if (c === '\\') {
        out += c + (next ?? '')
        i += 2
      } else if (c === '$' && next === '{') {
        templates[templates.length - 1] = 1
        out += '${'
        i += 2
      } else {
        out += c
        i++
      }
      continue
    }
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end < 0 ? code.length : end + 2
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1
      out += code.slice(i, j + 1)
      i = j + 1
    } else if (c === '`') {
      if (templates.length && templates[templates.length - 1] === 0) templates.pop()
      else templates.push(0)
      out += c
      i++
    } else {
      // Inside a `${…}`: braces count, and the last `}` goes back to the template's text.
      if (templates.length && c === '{') templates[templates.length - 1]++
      if (templates.length && c === '}') templates[templates.length - 1]--
      out += c
      i++
    }
  }
  return out
}

// Every module a file names: imports, re-exports, import() and require() (also `import x =
// require(…)`), with comments left out. `import type` and `export type` leave nothing behind at run
// time, so they are marked.
function imports(code: string): Import[] {
  const text = withoutComments(code)
  const named = [...text.matchAll(/\b(?:import|export)(\s+type)?\b[^'"`]*?\bfrom\s+(['"])([^'"]+)\2/g)].map((m) => ({
    specifier: m[3],
    typeOnly: Boolean(m[1]),
  }))
  const loaded = [...text.matchAll(/\b(?:import|require)\s*\(?\s*(['"`])([^'"`$]+)\1/g)].map((m) => ({ specifier: m[2], typeOnly: false }))
  return [...named, ...loaded]
}

// The folder under src/ a specifier lands in ('..' outside src/), or the bare module name.
function target(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier
  return relative(src, resolve(file, '..', specifier)).split(sep)[0]
}

function breaches(side: keyof typeof SIDES, banned: (target: string, typeOnly: boolean) => boolean, except: string[] = []): string[] {
  return SIDES[side]
    .filter((file) => !except.includes(relative(src, file)))
    .flatMap((file) =>
      imports(readFileSync(file, 'utf8'))
        .filter(({ specifier, typeOnly }) => banned(target(file, specifier), typeOnly))
        .map(({ specifier }) => `${relative(src, file)} imports ${specifier}`),
    )
}

// Node's built-ins, with or without `node:` (`fs` as well as `node:fs`).
const isNode = (t: string) => t.startsWith('node:') || builtinModules.includes(t.split('/')[0])
const nodeOrWorker = (t: string) => isNode(t) || t === 'orca/worker' || t === 'worker' || t === 'worker.ts'

test('the panel (panel/ and panel.tsx) imports neither Node modules nor worker code', () => {
  assert.deepEqual(breaches('panel', nodeOrWorker), [])
})

test('the worker (worker/ and worker.ts) imports no panel code', () => {
  assert.deepEqual(breaches('worker', (t) => t === 'panel' || t === 'panel.tsx'), [])
})

// The panel's `orca` module exists only in the panel; its types (Tone) are fine anywhere.
test('shared/ imports neither Node modules, worker code, panel code nor the panel runtime', () => {
  assert.deepEqual(
    breaches('shared', (t, typeOnly) => nodeOrWorker(t) || t === 'panel' || t === 'panel.tsx' || (t === 'orca' && !typeOnly)),
    [],
  )
})

// Tests and fixtures live in tests/; only the check scenarios borrow fixtures.
test('src/ never imports from tests/', () => {
  assert.deepEqual(breaches('all', (t) => t === '..', ['panel.check.ts']), [])
})

// #36's layout: only the entries and the check scenarios directly in src/, no tests or fixtures in it.
test('src/ holds only the entries and the check scenarios at its root, and no tests or fixtures', () => {
  const root = readdirSync(src, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  assert.deepEqual(root.sort(), ['panel.check.ts', 'panel.tsx', 'worker.ts'])
  assert.deepEqual(
    SIDES.all.map((file) => relative(src, file)).filter((file) => /\.test\.tsx?$|fixtures/.test(file)),
    [],
  )
})

test('the check finds a banned import', () => {
  const text = "// export rows that come from 'worker'\nimport { x } from 'node:fs'\nimport { join } from 'path'\nimport type { Tone } from 'orca'\nexport type { Y } from '../worker/gh'\nawait import('./z')"
  assert.deepEqual(imports(text), [
    { specifier: 'node:fs', typeOnly: false },
    { specifier: 'path', typeOnly: false },
    { specifier: 'orca', typeOnly: true },
    { specifier: '../worker/gh', typeOnly: true },
    { specifier: './z', typeOnly: false },
  ])
  // require, import = require and a template literal; a `/*` in a string hides nothing after it.
  const more = "const glob = 'src/*'\nconst a = require('node:fs')\nimport b = require('fs')\nconst c = () => import(`../worker/gh`)\nconst d = `${'x'}`\nimport { e } from 'node:os'"
  assert.deepEqual(
    imports(more).map((m) => m.specifier).sort(),
    ['../worker/gh', 'fs', 'node:fs', 'node:os'],
  )
  assert.equal(withoutComments("const u = 'https://x' // gone\n/* gone */ const t = `a ${'b'} // kept`"), "const u = 'https://x' \n const t = `a ${'b'} // kept`")
  assert.ok(isNode('path') && isNode('fs/promises') && isNode('node:fs') && !isNode('orca'))
  assert.equal(target(join(src, 'panel', 'store.ts'), '../worker/gh'), 'worker')
  assert.equal(target(join(src, 'panel.tsx'), './worker/gh'), 'worker')
  assert.equal(target(join(src, 'panel', 'runs', 'run-view.tsx'), '../../shared/protocol'), 'shared')
  assert.equal(target(join(src, 'panel.check.ts'), '../tests/fixtures/fixtures'), '..')
})
