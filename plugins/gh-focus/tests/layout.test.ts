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

// Every module a file names: static and type imports, re-exports and import().
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g)].map((m) => m[2])
}

// The folder under src/ a specifier lands in ('..' outside src/), or the bare module name.
function target(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier
  return relative(src, resolve(file, '..', specifier)).split(sep)[0]
}

function breaches(side: string, banned: (target: string) => boolean): string[] {
  return sources(join(src, side)).filter((file) => !file.endsWith('.check.ts')).flatMap((file) =>
    specifiers(readFileSync(file, 'utf8'))
      .filter((specifier) => banned(target(file, specifier)))
      .map((specifier) => `${relative(src, file)} imports ${specifier}`),
  )
}

const nodeOrWorker = (t: string) => t.startsWith('node:') || t === 'orca/worker' || t === 'worker'

test('panel/ imports neither node: modules nor worker code', () => {
  assert.deepEqual(breaches('panel', nodeOrWorker), [])
})

test('shared/ imports neither node: modules, worker code nor panel code', () => {
  assert.deepEqual(breaches('shared', (t) => nodeOrWorker(t) || t === 'panel' || t === 'orca'), [])
})

// Tests and fixtures live in tests/; only the check scenarios (panel.check.ts) borrow fixtures.
test('src/ never imports from tests/', () => {
  assert.deepEqual(breaches('.', (t) => t === '..'), [])
})

test('the check finds a banned import', () => {
  assert.deepEqual(specifiers("import { x } from 'node:fs'\nexport type { Y } from '../worker/gh'\nawait import('./z')"), [
    'node:fs',
    '../worker/gh',
    './z',
  ])
  assert.equal(target(join(src, 'panel', 'store.ts'), '../worker/gh'), 'worker')
  assert.equal(target(join(src, 'panel', 'runs', 'run-view.tsx'), '../../shared/protocol'), 'shared')
  assert.equal(target(join(src, 'panel.check.ts'), '../tests/fixtures/fixtures'), '..')
})
