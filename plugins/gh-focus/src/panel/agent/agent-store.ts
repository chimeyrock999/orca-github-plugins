// The workspace's free agent, which the panel types a prompt into: the Issues and Pull requests tabs
// ask it to link one, a failed run asks it to fix the run. One agent state for the workspace on
// screen, shared by both.
import { atom, plugin, read, set } from 'orca'
import type { AskAbout, BusyAgent, FreeAgent, LinkedKind, PanelError } from '../../shared/protocol'
import { repo, requestFailed } from '../store'
import { focusKey } from '../thread/thread-store'

/** The free agent of the workspace on screen (`where`); `agent` null when none is free, and then
 *  `busy` the one at work or waiting on a question, if any. `asked` is what it was asked about (with
 *  the name it answered as), `asking` while the prompt is on its way. */
export type AgentState = { where: string; agent: FreeAgent | null; busy: BusyAgent | null; asking: boolean; asked: AskAbout | null; error: PanelError | null }
export const agent = atom<AgentState | null>(null)

/** The agent state for the workspace on screen, once found. */
export function agentNow(): AgentState | null {
  const a = read(agent)
  return a && a.where === focusKey() ? a : null
}

/** Whether the agent was asked about this, last. */
export function wasAsked(a: AgentState | null, about: AskAbout): boolean {
  const asked = a?.asked
  if (!asked) return false
  return 'run' in about ? 'run' in asked && asked.run === about.run : 'link' in asked && asked.link === about.link
}

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
  set(agent, { where, agent: answer.ok ? answer.agent : null, busy: answer.ok ? answer.busy : null, asking: false, asked: null, error: null })
}

/** Whether an agent changing state is looked for again: only when Orca names its workspace and that is
 *  the panel's (`workspaceListId`; only the panel's agents are offered, and Orca names none for a pane
 *  tied to no workspace), and not while it is being asked or once it was asked (Enter on the prompt
 *  sets it working, and the callout stays until the agent asked to link one stops, see
 *  `askedStopped`, or until Dismiss or Refresh). */
export function mayRefindAgent(workspaceListId?: string): boolean {
  const r = read(repo)
  if (!workspaceListId || (r?.ok && r.workspaceId !== workspaceListId)) return false
  const a = agentNow()
  return !a?.asking && !a?.asked
}

/** The kind to ask Orca about again when an agent changes state: the one the agent on screen was
 *  asked to link, once that agent (its terminal) stops (`waiting` or `done`), since it may have
 *  linked one by then; null for any other agent or state, while it works or asks a question, or
 *  when it was asked to fix a run. */
export function askedStopped(e: { terminalId?: string; state: string }): LinkedKind | null {
  const a = agentNow()
  const asked = a?.asked
  if (!asked || !('link' in asked) || !e.terminalId || e.terminalId !== a.agent?.terminalId) return null
  return e.state === 'waiting' || e.state === 'done' ? asked.link : null
}

/** Types the prompt about this into the free agent's terminal; the person presses Enter there. */
export async function askAgent(about: AskAbout): Promise<void> {
  const a = agentNow()
  if (!a?.agent || a.asking) return
  const { where, agent: offered } = a
  set(agent, { ...a, asking: true, error: null })
  const answer = await plugin.request('agent.ask', { about, terminalId: offered.terminalId }).catch(requestFailed)
  if (focusKey() !== where) return
  if (answer.ok) return set(agent, { ...a, agent: { ...offered, name: answer.agent }, asking: false, asked: about, error: null })
  if (answer.error.code !== 'no_agent') return set(agent, { ...a, asking: false, error: answer.error })
  // No agent free any more: it says why, and asks again what the agent is doing now.
  await findAgent(true)
  const now = agentNow()
  if (now) set(agent, { ...now, error: answer.error })
}

/** Back from "typed into the agent" (or from why it was not) to the offer. */
export function forgetAsked(): void {
  const a = agentNow()
  if (a) set(agent, { ...a, asked: null, error: null })
}
