// What the Issues and Pull requests tabs offer around the linked items: the hand-offs to Orca's Tasks
// page and Checks tab, and, with nothing linked, a free agent to ask to link one.
import { atom, plugin, read, set } from 'orca'
import type { BusyAgent, FreeAgent, LinkedKind, OrcaView, PanelError } from '../../shared/protocol'
import { lists, requestFailed } from '../store'
import { focusKey, type AnyThread } from '../thread/thread-store'

/** Why the last hand-off to Orca did not happen; null when it did. */
export const handOffError = atom<PanelError | null>(null)

/** Hands off to Orca's Tasks page or Checks tab; when Orca will not (not the desktop app, say),
 *  the tab says why and Open on GitHub stays. */
export async function handOff(view: OrcaView): Promise<void> {
  set(handOffError, null)
  const answer = await plugin.request('orca.show', { view }).catch(requestFailed)
  if (!answer.ok) set(handOffError, answer.error)
}
export const dismissHandOff = () => set(handOffError, null)

/** The free agent of the workspace on screen (`where`); `agent` null when none is free, and then
 *  `busy` the one at work or waiting on a question, if any. `asked` is the kind it was asked to link
 *  (with the name it answered as), `asking` while the prompt is on its way. */
export type AgentState = { where: string; agent: FreeAgent | null; busy: BusyAgent | null; asking: boolean; asked: LinkedKind | null; error: PanelError | null }
export const agent = atom<AgentState | null>(null)

/** The agent state for the workspace on screen, once found. */
export function agentNow(): AgentState | null {
  const a = read(agent)
  return a && a.where === focusKey() ? a : null
}

/** Looks for a free agent when the empty state shows for a workspace (or on Refresh, or when an agent
 *  there changes state): a failure, such as Orca not allowing it, is no agent. */
export async function findAgent(again = false): Promise<void> {
  const where = focusKey()
  if (!again && read(agent)?.where === where) return
  const answer = await plugin.request('agent.find').catch(requestFailed)
  if (focusKey() !== where) return
  set(agent, { where, agent: answer.ok ? answer.agent : null, busy: answer.ok ? answer.busy : null, asking: false, asked: null, error: null })
}

/** Whether an agent changing state is looked for again: not while it is being asked or once it was
 *  asked (Enter on the prompt sets it working, and the callout stays until Refresh). */
export function mayRefindAgent(): boolean {
  const a = agentNow()
  return !a?.asking && !a?.asked
}

/** Types the link prompt into the free agent's terminal; the person presses Enter there. */
export async function askAgent(kind: LinkedKind): Promise<void> {
  const a = agentNow()
  if (!a?.agent || a.asking) return
  const { where, agent: offered } = a
  set(agent, { ...a, asking: true, error: null })
  const answer = await plugin.request('agent.ask', { kind, terminalId: offered.terminalId }).catch(requestFailed)
  if (focusKey() !== where) return
  if (answer.ok) return set(agent, { ...a, agent: { ...offered, name: answer.agent }, asking: false, asked: kind, error: null })
  if (answer.error.code !== 'no_agent') return set(agent, { ...a, asking: false, error: answer.error })
  // No agent free any more: it says why, and asks again what the agent is doing now.
  await findAgent(true)
  const now = agentNow()
  if (now) set(agent, { ...now, error: answer.error })
}

/** Back from a thread; the empty state it may land on offers a free agent, so one is looked for. */
export async function backFrom(t: AnyThread): Promise<void> {
  await t.backToList()
  if (!read(lists[t.kind]).open && t.linkedNow()?.refs?.length === 0) await findAgent()
}

/** Back from "typed into the agent" to the command and the button. */
export function showCommand(): void {
  const a = agentNow()
  if (a) set(agent, { ...a, asked: null, error: null })
}
