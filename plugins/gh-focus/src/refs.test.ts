import { assert, test } from 'orca/testing'
import { hasImage, linkRefs } from './refs'

const repo = 'https://github.com/octo/app'

test('#N and owner/name#N become links into the repo and that repo', () => {
  assert.equal(linkRefs('Same as #7.', repo), 'Same as [#7](https://github.com/octo/app/issues/7).')
  assert.equal(linkRefs('#7 first', repo), '[#7](https://github.com/octo/app/issues/7) first')
  assert.equal(linkRefs('See octo/docs#412 too', repo), 'See [octo/docs#412](https://github.com/octo/docs/issues/412) too')
  assert.equal(linkRefs('(#1, #2)', repo), '([#1](https://github.com/octo/app/issues/1), [#2](https://github.com/octo/app/issues/2))')
})

test('words, paths, entities, headings and code keep their #', () => {
  for (const text of ['abc#12', 'a/b/c#12', '&#39;', '# 12 heading', '#12a', 'issue-#12x', 'C#']) assert.equal(linkRefs(text, repo), text)
  assert.equal(linkRefs('run `git log #3` now', repo), 'run `git log #3` now')
  assert.equal(linkRefs('```\nfix #3\n```\nthen #4', repo), '```\nfix #3\n```\nthen [#4](https://github.com/octo/app/issues/4)')
})

test('links and URLs are left as they are', () => {
  const text = 'see [the fix #3](https://x.dev/#3) and https://github.com/octo/app/pull/9#issuecomment-1 and <https://a.b/#5>'
  assert.equal(linkRefs(text, repo), text)
})

test('a GitHub Enterprise repo links on its own host', () => {
  assert.equal(linkRefs('x/y#2', 'https://ghe.corp/octo/app/'), '[x/y#2](https://ghe.corp/x/y/issues/2)')
  assert.equal(linkRefs('#2', 'https://ghe.corp/octo/app/'), '[#2](https://ghe.corp/octo/app/issues/2)')
})

test('hasImage finds Markdown and HTML images', () => {
  assert.equal(hasImage('![shot](https://user-images.githubusercontent.com/1.png)'), true)
  assert.equal(hasImage('<img width="400" src="x">'), true)
  assert.equal(hasImage('[a link](https://x.dev)'), false)
})
