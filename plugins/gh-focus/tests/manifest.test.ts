// The manifest as the community catalog lists it: the listing policy and the metadata the plugin
// page shows.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

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
  cover?: { path: string; alt: string }
  screenshots?: { path: string; alt: string; caption?: string; theme?: 'light' | 'dark' }[]
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

// The catalog pins the folder as `source.path`, and Orca keys the panel by its id: neither may move
// once a version is listed.
test('the folder and the panel are named after the id', () => {
  assert.equal(basename(root), manifest.id)
  assert.deepEqual(
    manifest.contributes.panels.map((p) => p.id),
    [manifest.id],
  )
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

// The catalog's image rules (Orca 1.4.256): static PNG here, at least the minimum size, at most the
// byte limit, a 16:10 cover, at most six screenshots, 8 MB in all.
const KB = 1024

function png(path: string): { width: number; height: number; bytes: number } {
  const file = readFileSync(join(root, path))
  assert.equal(file.subarray(1, 4).toString('latin1'), 'PNG', `${path} is not a PNG`)
  // Listing images must be static: an animated PNG carries an acTL chunk.
  assert.ok(!file.includes('acTL', 0, 'latin1'), `${path} is animated`)
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20), bytes: file.length }
}

test('the cover fits the catalog limits', () => {
  assert.ok(manifest.cover, 'no cover')
  assert.ok(manifest.cover.alt.length > 0 && manifest.cover.alt.length <= 160)
  const { width, height, bytes } = png(manifest.cover.path)
  assert.ok(width >= 800 && height >= 500, `cover is ${width}×${height}`)
  assert.equal(width * 10, height * 16, `cover is ${width}×${height}, not 16:10`)
  assert.ok(bytes <= 1024 * KB, `cover is ${bytes} bytes`)
})

test('the screenshots fit the catalog limits', () => {
  const shots = manifest.screenshots ?? []
  assert.ok(shots.length > 0 && shots.length <= 6, `${shots.length} screenshots`)
  for (const shot of shots) {
    assert.ok(shot.alt.length > 0 && shot.alt.length <= 160, shot.path)
    assert.ok(shot.caption && shot.caption.length <= 120, `${shot.path} caption`)
    // The shots are all dark: a `theme` would hide them from users of the light theme.
    assert.equal(shot.theme, undefined, `${shot.path} theme`)
    const { width, height, bytes } = png(shot.path)
    assert.ok(width >= 1280 && height >= 800 && width <= 4096 && height <= 4096, `${shot.path} is ${width}×${height}`)
    assert.ok(bytes <= 1536 * KB, `${shot.path} is ${bytes} bytes`)
  }
  const paths = new Set([manifest.cover?.path, ...shots.map((s) => s.path)].filter((p) => p !== undefined))
  const total = [...paths].reduce((sum, path) => sum + png(path).bytes, 0)
  assert.ok(total <= 8 * 1024 * KB, `images are ${total} bytes`)
})
