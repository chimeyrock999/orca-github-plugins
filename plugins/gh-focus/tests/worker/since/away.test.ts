// When the person left each workspace, and which returns count as an absence.
import { assert, test } from 'orca/testing'
import { Away, AWAY_LIMIT, AWAY_MS } from '../../../src/worker/since/away'

const MIN = 60_000

function clock() {
  let t = Date.UTC(2026, 10, 27, 9, 0)
  return { now: () => t, wait: (ms: number) => void (t += ms), at: () => t }
}

test('a return after AWAY_MS elsewhere is an absence from when focus left; a shorter one is not', () => {
  const c = clock()
  const away = new Away(c.now)
  away.focus('w')
  const left = c.at()
  away.focus('x')
  c.wait(AWAY_MS - MIN)
  away.focus('w')
  assert.equal(away.sinceOf('w'), null)
  away.focus('x')
  const leftAgain = c.at()
  c.wait(AWAY_MS)
  away.focus('w')
  assert.equal(away.sinceOf('w'), leftAgain)
  assert.notEqual(leftAgain, left)
  assert.equal(away.sinceOf('x'), null)
})

test('the first focus and terminal changes (the same id again) are no absence', () => {
  const c = clock()
  const away = new Away(c.now)
  away.focus('w')
  c.wait(AWAY_MS * 3)
  away.focus('w')
  assert.equal(away.sinceOf('w'), null)
})

test('no workspace focused counts as away', () => {
  const c = clock()
  const away = new Away(c.now)
  away.focus('w')
  const left = c.at()
  away.focus(null)
  c.wait(AWAY_MS)
  away.focus('w')
  assert.equal(away.sinceOf('w'), left)
})

test('an absence not dismissed keeps its start through later ones; dismissed, the next one starts anew', () => {
  const c = clock()
  const away = new Away(c.now)
  away.focus('w')
  const first = c.at()
  away.focus('x')
  c.wait(AWAY_MS)
  away.focus('w')
  away.focus('x')
  c.wait(AWAY_MS)
  away.focus('w')
  assert.equal(away.sinceOf('w'), first)
  away.dismiss('w')
  assert.equal(away.sinceOf('w'), null)
  away.focus('x')
  const next = c.at()
  c.wait(AWAY_MS)
  away.focus('w')
  assert.equal(away.sinceOf('w'), next)
})

test(`at most ${AWAY_LIMIT} workspaces are remembered: the one left longest ago is forgotten`, () => {
  const c = clock()
  const away = new Away(c.now)
  for (let i = 0; i <= AWAY_LIMIT + 1; i++) {
    away.focus(`w${i}`)
    c.wait(1)
  }
  c.wait(AWAY_MS)
  away.focus('w1')
  assert.notEqual(away.sinceOf('w1'), null)
  away.focus('w0')
  assert.equal(away.sinceOf('w0'), null)
})

test('backOf: the latest return from an absence; a short visit elsewhere leaves it, a long one moves it', () => {
  const c = clock()
  const away = new Away(c.now)
  away.focus('w')
  away.focus('x')
  c.wait(AWAY_MS)
  away.focus('w')
  const back = c.at()
  assert.equal(away.backOf('w'), back)
  away.focus('x')
  c.wait(MIN)
  away.focus('w')
  assert.equal(away.backOf('w'), back)
  away.focus('x')
  c.wait(AWAY_MS)
  away.focus('w')
  assert.equal(away.backOf('w'), c.at())
  away.dismiss('w')
  assert.equal(away.backOf('w'), null)
})
