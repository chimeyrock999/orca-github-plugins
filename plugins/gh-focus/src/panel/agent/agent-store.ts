// The workspace's free agent, which the panel types a prompt into: the Issues and Pull requests tabs
// ask it to link one, a failed run asks it to fix the run. One agent state for the workspace on
// screen, shared by both.
import { atom, plugin, read, set } from 'orca'
import type { AskAbout, BusyAgent, FreeAgent, LinkedKind, PanelError } from '../../shared/protocol'
import { repo, requestFailed } from '../store'
import { focusKey } from '../thread/thread-store'

/** The free agent of the workspace on screen (`where`); `agent` null when none is free, and then
 *  `busy` the one at work or waiting on a question, if any. `asked` is what it was asked about last, `asking` while the prompt is on its way, `error` why the last ask about
 *  something did not go through. */
export type AgentState = {
  where: string
  agent: FreeAgent | null
  busy: BusyAgent | null
  asking: boolean
  asked: AskedAgent | null
  error: { about: AskAbout; error: PanelError } | null
}

/** What the agent was asked about last, the terminal the prompt went into and the name it answered
 *  as: kept while the agent is looked up again (it works on it by then), until Dismiss. `started`
 *  once that terminal was seen at work since the ask: an agent asked while at work stops first from
 *  its earlier task, and only a stop after it started again can be the end of the ask. */
export type AskedAgent = { about: AskAbout; terminalId: string; name: string; started: boolean }
export const agent = atom<AgentState | null>(null)

/** The agent state for the workspace on screen, once found. */
export function agentNow(): AgentState | null {
  const a = read(agent)
  return a && a.where === focusKey() ? a : null
}

const same = (a: AskAbout | null | undefined, b: AskAbout): boolean =>
  !!a && ('run' in b ? 'run' in a && a.run === b.run : 'link' in a && a.link === b.link)

/** Whether the agent was asked about this, last. */
export const wasAsked = (a: AgentState | null, about: AskAbout): boolean => same(a?.asked?.about, about)

/** Why asking about this did not go through, if it did not: each offer shows only its own. */
export const askFailed = (a: AgentState | null, about: AskAbout): PanelError | null => (a?.error && same(a.error.about, about) ? a.error.error : null)

/** Looks for a free agent when an offer shows for a workspace (or on Refresh, or when an agent
 *  there changes state): a failure, such as Orca not allowing it, is no agent. */
let finding = 0
export async function findAgent(again = false): Promise<void> {
  const where = focusKey()
  if (!again && read(agent)?.where === where) return
  // Agent events come quickly: only the latest look answers.
  const mine = ++finding
  const answer = await plugin.request('agent.find').catch(requestFailed)
  if (mine !== finding || focusKey() !== where) return
  // What the agent was asked stays: a look-up from another offer must not drop it (the asked agent
  // stopping still reopens the links, `askedStopped`). Another workspace starts afresh.
  const was = read(agent)
  const asked = was?.where === where ? was.asked : null
  set(agent, { where, agent: answer.ok ? answer.agent : null, busy: answer.ok ? answer.busy : null, asking: false, asked, error: null })
}

/** Whether an agent changing state is looked for again: only when Orca names its workspace and that is
 *  the panel's (`workspaceListId`; only the panel's agents are offered, and Orca names none for a pane
 *  tied to no workspace), and not while it is being asked. The offer on screen decides the rest
 *  (`offerAgent`). */
export function mayRefindAgent(workspaceListId?: string): boolean {
  const r = read(repo)
  if (!workspaceListId || (r?.ok && r.workspaceId !== workspaceListId)) return false
  return !agentNow()?.asking
}

/** An offer to ask the agent about this shows (or its agent changed state, `again`): the agent is
 *  looked for, except while it is being asked, or once it was asked about this (Enter on the prompt
 *  sets it working, and the callout stays until the agent asked to link one stops, see
 *  `askedStopped`, or until Dismiss). Asked about something else, it is looked for again: it may have
 *  started work since, unseen. */
export function offerAgent(about: AskAbout, again = false): Promise<void> | void {
  const a = agentNow()
  if (a?.asking || wasAsked(a, about)) return
  return findAgent(again || !!a?.asked)
}

/** The kind to ask Orca about again when an agent changes state: the one the agent was asked to
 *  link, once its terminal stops (`waiting` or `done`) after it was seen at work since the ask (it may
 *  have linked one by then); null for any other terminal or state, before it started, or when it was
 *  asked to fix a run. A `working` event of that terminal marks it started. */
export function askedStopped(e: { terminalId?: string; state: string }): LinkedKind | null {
  const a = agentNow()
  const asked = a?.asked
  if (!a || !asked || !e.terminalId || e.terminalId !== asked.terminalId) return null
  if (e.state === 'working') {
    if (!asked.started) set(agent, { ...a, asked: { ...asked, started: true } })
    return null
  }
  if (!('link' in asked.about) || !asked.started) return null
  return e.state === 'waiting' || e.state === 'done' ? asked.about.link : null
}

/** Types the prompt about this into the free agent's terminal; the person presses Enter there. */
export async function askAgent(about: AskAbout): Promise<void> {
  const a = agentNow()
  if (!a?.agent || a.asking) return
  const { where, agent: offered } = a
  set(agent, { ...a, asking: true, error: null })
  const answer = await plugin.request('agent.ask', { about, terminalId: offered.terminalId }).catch(requestFailed)
  if (focusKey() !== where) return
  if (answer.ok) {
    const asked = { about, terminalId: offered.terminalId, name: answer.agent, started: false }
    return set(agent, { ...a, agent: { ...offered, name: answer.agent }, asking: false, asked, error: null })
  }
  const error = { about, error: answer.error }
  if (answer.error.code !== 'no_agent') return set(agent, { ...a, asking: false, error })
  // No agent free any more: it says why, and asks again what the agent is doing now.
  await findAgent(true)
  const now = agentNow()
  if (now) set(agent, { ...now, error })
}

/** Back from "typed into the agent" (or from why it was not) to the offer. */
export function forgetAsked(): void {
  const a = agentNow()
  if (a) set(agent, { ...a, asked: null, error: null })
}
