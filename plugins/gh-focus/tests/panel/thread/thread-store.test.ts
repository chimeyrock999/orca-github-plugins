// The thread's pure changes: a posted comment put in place, and the linked row it moves.
import { assert, test } from 'orca/testing'
import { touched, withComment } from '../../../src/panel/thread/thread-store'
import { commentItem, issueDetail } from '../../fixtures/fixtures'

test('withComment puts a comment at the end of what is loaded; touched moves a row to the top', () => {
  const detail = issueDetail()
  const c = commentItem(9)
  const all = withComment({ ...detail, next: null, tail: [] }, c)
  assert.deepEqual([all.head.at(-1), all.comments, all.total], [c, detail.comments + 1, detail.total + 1])
  const part = withComment({ ...detail, next: 'x' }, c)
  assert.deepEqual([part.tail.at(-1), part.head.length], [c, detail.head.length])
  const rows = [
    { number: 1, repo: null, title: 'a', url: 'u', state: 'open' as const, updatedAt: 3, author: null },
    { number: 2, repo: 'o/R', title: 'b', url: 'u', state: 'open' as const, updatedAt: 2, author: null }
  ]
  assert.deepEqual(touched(rows, { number: 2, repo: 'o/r' }, 9).map((r) => [r.number, r.updatedAt]), [[2, 9], [1, 3]])
  assert.equal(touched(rows, { number: 7, repo: null }, 9), rows)
})
