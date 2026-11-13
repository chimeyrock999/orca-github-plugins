// The manifest as the community catalog lists it: the listing policy and the metadata the plugin
// page shows.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

type Manifest = {
  id: string
  name: string
  description?: string
  engines: { orca: string }
  author?: { name: string; url?: string }
  repository?: string
  license?: string
  contributes: { panels: { id: string; title: string }[] }
}

const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')) as Manifest

function version(range: string): number[] {
  return range.replace(/^>=/, '').split('.').map(Number)
}

test('id and name do not suggest GitHub or Orca made the plugin', () => {
  assert.equal(manifest.id, 'gh-focus')
  assert.equal(manifest.name, 'gh Focus')
  assert.ok(!/^orca-/i.test(manifest.id))
  for (const name of [manifest.name, ...manifest.contributes.panels.map((p) => p.title)]) {
    assert.ok(!/github|orca/i.test(name), `${name} names another product`)
  }
  assert.match(manifest.description ?? '', /not affiliated with GitHub/)
})

test('engines.orca is the release the features were tested on', () => {
  const [major, minor, patch] = version(manifest.engines.orca)
  assert.ok(major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 256))), manifest.engines.orca)
})

test('the plugin page has its author, repository and license', () => {
  assert.equal(manifest.author?.name, 'chimeyrock999')
  assert.equal(manifest.repository, 'https://github.com/chimeyrock999/orca-github-plugins')
  assert.equal(manifest.license, 'MIT')
})
