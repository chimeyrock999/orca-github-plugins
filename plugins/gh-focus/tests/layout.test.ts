// What each side of src/ may import: the panel runs without Node, and shared/ is loaded by both
// sides, so neither reaches for node: modules or worker code (CLAUDE.md, Layout).
import { assert, test } from 'orca/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const src = join(import.meta.dirname, '..', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

type Import = { specifier: string; typeOnly: boolean }

// Every module a file names: imports, re-exports and import(). `import type` and `export type`
// leave nothing behind at run time, so they are marked.
function imports(text: string): Import[] {
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

function breaches(side: string, banned: (target: string, typeOnly: boolean) => boolean): string[] {
  return sources(join(src, side)).filter((file) => !file.endsWith('.check.ts')).flatMap((file) =>
    imports(readFileSync(file, 'utf8'))
      .filter(({ specifier, typeOnly }) => banned(target(file, specifier), typeOnly))
      .map(({ specifier }) => `${relative(src, file)} imports ${specifier}`),
  )
}

const nodeOrWorker = (t: string) => t.startsWith('node:') || t === 'orca/worker' || t === 'worker'

test('panel/ imports neither node: modules nor worker code', () => {
  assert.deepEqual(breaches('panel', nodeOrWorker), [])
})

test('worker/ imports no panel code', () => {
  assert.deepEqual(breaches('worker', (t) => t === 'panel'), [])
})

// The panel's `orca` module exists only in the panel; its types (Tone) are fine anywhere.
test('shared/ imports neither node: modules, worker code, panel code nor the panel runtime', () => {
  assert.deepEqual(breaches('shared', (t, typeOnly) => nodeOrWorker(t) || t === 'panel' || (t === 'orca' && !typeOnly)), [])
})

// Tests and fixtures live in tests/; only the check scenarios (panel.check.ts) borrow fixtures.
test('src/ never imports from tests/', () => {
  assert.deepEqual(breaches('.', (t) => t === '..'), [])
})

test('the check finds a banned import', () => {
  const text = "import { x } from 'node:fs'\nimport type { Tone } from 'orca'\nexport type { Y } from '../worker/gh'\nawait import('./z')"
  assert.deepEqual(imports(text), [
    { specifier: 'node:fs', typeOnly: false },
    { specifier: 'orca', typeOnly: true },
    { specifier: '../worker/gh', typeOnly: true },
    { specifier: './z', typeOnly: false },
  ])
  assert.equal(target(join(src, 'panel', 'store.ts'), '../worker/gh'), 'worker')
  assert.equal(target(join(src, 'panel', 'runs', 'run-view.tsx'), '../../shared/protocol'), 'shared')
  assert.equal(target(join(src, 'panel.check.ts'), '../tests/fixtures/fixtures'), '..')
})
