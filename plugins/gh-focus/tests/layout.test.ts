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

// Every module a file names: imports, re-exports and import(), with comments left out. `import type`
// and `export type` leave nothing behind at run time, so they are marked.
function imports(code: string): Import[] {
  const text = code.replace(/\/\*[^]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const named = [...text.matchAll(/\b(?:import|export)(\s+type)?\b[^'"]*?\bfrom\s+(['"])([^'"]+)\2/g)].map((m) => ({
    specifier: m[3],
    typeOnly: Boolean(m[1]),
  }))
  const bare = [...text.matchAll(/\bimport\s*\(?\s*(['"])([^'"]+)\1/g)].map((m) => ({ specifier: m[2], typeOnly: false }))
  return [...named, ...bare]
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

test('the check finds a banned import', () => {
  const text = "// export rows that come from 'worker'\nimport { x } from 'node:fs'\nimport { join } from 'path'\nimport type { Tone } from 'orca'\nexport type { Y } from '../worker/gh'\nawait import('./z')"
  assert.deepEqual(imports(text), [
    { specifier: 'node:fs', typeOnly: false },
    { specifier: 'path', typeOnly: false },
    { specifier: 'orca', typeOnly: true },
    { specifier: '../worker/gh', typeOnly: true },
    { specifier: './z', typeOnly: false },
  ])
  assert.ok(isNode('path') && isNode('fs/promises') && isNode('node:fs') && !isNode('orca'))
  assert.equal(target(join(src, 'panel', 'store.ts'), '../worker/gh'), 'worker')
  assert.equal(target(join(src, 'panel.tsx'), './worker/gh'), 'worker')
  assert.equal(target(join(src, 'panel', 'runs', 'run-view.tsx'), '../../shared/protocol'), 'shared')
  assert.equal(target(join(src, 'panel.check.ts'), '../tests/fixtures/fixtures'), '..')
})
