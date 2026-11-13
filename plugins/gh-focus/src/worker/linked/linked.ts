// What Orca links to the focused workspace: its issues and pull requests (src/worker/exec.ts reads them
// from Orca's CLI), the state GitHub has for them now, and the free agent that can be asked to link one.
import { GhError, type Gh } from '../gh'
import type { LinkedItem, WorkspaceLinks } from '../exec'
import { issueState, pullState, type RepoRef } from '../lists'
import { linkCommand } from '../../shared/look'
import { isRepoName, LINKED_LIMIT, type LinkedKind, type LinkedRef, type LinkedRow } from '../../shared/protocol'

/** The links Orca keeps for a workspace, by kind, when the workspace is of the focused repo: an
 *  item of the focused repo has `repo` null, one of another repo its `owner/name`. An item on another
 *  host (a GitHub Enterprise one while the repo is on github.com, say) is left out: its `owner/name`
 *  would name another repo here. One item each, in Orca's order. */
export function linkedRefs(links: WorkspaceLinks | null, repo: RepoRef & { url?: string }): { issues: LinkedRef[]; pulls: LinkedRef[] } {
  const host = repo.url ? new URL(repo.url).host.toLowerCase() : null
  const ours = (name: string | null) => !name || name.toLowerCase() === repo.nameWithOwner.toLowerCase()
  if (!links?.project?.startsWith('github:') || !ours(links.project.slice('github:'.length))) return { issues: [], pulls: [] }
  const of = (type: LinkedItem['type']): LinkedRef[] => {
    const seen = new Set<string>()
    return links.items.flatMap((item) => {
      if (item.type !== type || (item.host && host && item.host !== host)) return []
      const ref = { number: item.number, repo: ours(item.repo) ? null : item.repo, title: item.title, url: item.url }
      const key = `${ref.repo?.toLowerCase() ?? ''}#${ref.number}`
      if (seen.has(key)) return []
      seen.add(key)
      return [ref]
    })
  }
  return { issues: of('issue'), pulls: of('pull') }
}

const ITEM_FIELDS = `__typename
  ... on Issue { number title url state stateReason updatedAt author { login } }
  ... on PullRequest { number title url state isDraft merged updatedAt author { login } }`

type ItemNode = {
  __typename: string
  number: number
  title: string
  url: string
  state: string
  stateReason?: string | null
  isDraft?: boolean
  merged?: boolean
  updatedAt: string
  author?: { login: string } | null
}

/** One GraphQL query for the items: a `repository` per repo, an `issueOrPullRequest` per number. */
export function linkedQuery(repos: string[], numbers: number[][]): string {
  const blocks = repos.map((name, r) => {
    const [owner, repo] = name.split('/')
    const items = numbers[r].map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ${ITEM_FIELDS} }`).join('\n    ')
    return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n    ${items}\n  }`
  })
  return `query {\n  ${blocks.join('\n  ')}\n}`
}

/** The linked items as GitHub has them now, newest activity first. One GitHub has no answer for
 *  (gone, or hidden from this login) keeps Orca's title and no state, after the rest. */
export async function linkedRows(gh: Gh, repo: RepoRef, kind: LinkedKind, items: LinkedRef[], signal?: AbortSignal): Promise<{ rows: LinkedRow[] }> {
  const asked = items.slice(0, LINKED_LIMIT)
  const repos: string[] = []
  const numbers: number[][] = []
  for (const item of asked) {
    const name = item.repo ?? repo.nameWithOwner
    // Owner and repo names go into the query text, so only GitHub's own names pass.
    if (!isRepoName(name) || !Number.isInteger(item.number) || item.number < 1) continue
    let r = repos.findIndex((x) => x.toLowerCase() === name.toLowerCase())
    if (r < 0) r = repos.push(name) - 1
    numbers[r] = [...(numbers[r] ?? []), item.number]
  }
  type Data = Record<string, Record<string, ItemNode | null> | null>
  let data: Data = {}
  if (repos.length) {
    const out = (await gh(['api', 'graphql', '-f', `query=${linkedQuery(repos, numbers)}`], { cwd: repo.path, signal, json: true, partial: true })) as {
      data?: Data
      errors?: { message: string }[]
    }
    if (!out?.data) {
      const why = out?.errors?.map((e) => e.message).join('; ') || 'no data'
      throw new GhError('gh_failed', `GitHub did not answer for the linked items: ${why}`)
    }
    data = out.data
  }
  const path = kind === 'issues' ? 'issues' : 'pull'
  const rows = asked.map((item): LinkedRow => {
    const name = item.repo ?? repo.nameWithOwner
    const r = repos.findIndex((x) => x.toLowerCase() === name.toLowerCase())
    const node = r < 0 ? null : (data[`r${r}`]?.[`n${item.number}`] ?? null)
    if (!node) {
      const url = item.url ?? `https://github.com/${name}/${path}/${item.number}`
      return { number: item.number, repo: item.repo, title: item.title ?? `#${item.number}`, url, state: null, updatedAt: null, author: null }
    }
    const state = node.__typename === 'PullRequest' ? pullState(node) : issueState(node)
    return { number: node.number, repo: item.repo, title: node.title, url: node.url, state, updatedAt: Date.parse(node.updatedAt) || null, author: node.author?.login ?? null }
  })
  // A stable sort keeps Orca's order among items with no time.
  return { rows: rows.sort((a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity)) }
}

export type AgentRow = { terminalId: string | null; title: string | null; agent: string | null; state: string; stateStartedAt: number }

/** The agent to ask: one with a terminal that waits for input or is done (never one working, or
 *  blocked on a question), the one that stopped last. */
export function freeAgent(agents: AgentRow[]): (AgentRow & { terminalId: string }) | null {
  const free = agents.filter((a): a is AgentRow & { terminalId: string } => !!a.terminalId && (a.state === 'waiting' || a.state === 'done'))
  return free.sort((a, b) => b.stateStartedAt - a.stateStartedAt)[0] ?? null
}

/** How the panel names an agent: its terminal title, else its kind. */
export const agentName = (a: AgentRow): string => a.title?.trim() || a.agent || 'the agent'

/** What the agent is asked: it knows which issue or pull request it works on. */
export function linkPrompt(repoUrl: string, kind: LinkedKind): string {
  const noun = kind === 'issues' ? 'issue' : 'pull request'
  return `Link the GitHub ${noun} this workspace is working on to it in Orca: ${linkCommand(repoUrl, kind)}`
}
