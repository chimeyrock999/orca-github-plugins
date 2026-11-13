// GitHub links `#12` and `owner/repo#12` in issue text; Orca's Markdown does not, so the panel turns
// them into Markdown links first. Code, links and URLs keep their text as it is.

// Spans whose `#N` stays text: fenced and inline code, Markdown links, autolinks and HTML tags, URLs.
const KEEP = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/[^\s)>\]]+)/g
// A reference starts the text or follows a character that cannot be part of a word, path or entity.
const REF = /(^|[^\w/#&])(?:([A-Za-z0-9][\w-]*)\/([\w.-]+))?#(\d+)(?![\w-])/g

/** `text` with each issue reference made a link into `repoUrl`'s host: `#12` to the repo's issue 12,
 *  `owner/name#12` to that repo's. GitHub sends an issue link for a pull request on to it. */
export function linkRefs(text: string, repoUrl: string): string {
  const origin = /^https?:\/\/[^/]+/.exec(repoUrl)?.[0] ?? 'https://github.com'
  const link = (part: string) =>
    part.replace(REF, (_, before: string, owner: string | undefined, name: string | undefined, number: string) => {
      const label = owner ? `${owner}/${name}#${number}` : `#${number}`
      const target = owner ? `${origin}/${owner}/${name}` : repoUrl.replace(/\/+$/, '')
      return `${before}[${label}](${target}/issues/${number})`
    })
  return text
    .split(KEEP)
    .map((part, i) => (i % 2 === 1 ? part : link(part)))
    .join('')
}

/** Whether the text shows an image, which panel Markdown cannot load from the web. */
export function hasImage(text: string): boolean {
  return /!\[[^\]]*\]\([^)]+\)|<img\b/i.test(text)
}
