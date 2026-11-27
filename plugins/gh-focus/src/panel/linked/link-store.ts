// What the Issues and Pull requests tabs offer around the linked items: the hand-offs to Orca's Tasks
// page and Checks tab, and the workspace's agent: asked to link one when nothing is linked, or about
// an open issue or one of its comments.
import { atom, plugin, read, set } from 'orca'
import type { AgentAsk, AskableAgent, BlockedAgent, LinkedKind, OrcaView, PanelError } from '../../shared/protocol'
import { lists, repo, requestFailed } from '../store'
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

/** The agent to ask in the workspace on screen (`where`); `agent` null when none can take a prompt,
 *  and then `blocked` the one waiting on a question, if any. `asked` is the kind it was asked to link
 *  (with the name it answered as), `asking` while that prompt is on its way. `askingAbout` is the
 *  post (its node id) whose prompt is on its way, `aboutError` why the last one was not typed. */
export type AgentState = {
  where: string
  agent: AskableAgent | null
  blocked: BlockedAgent | null
  asking: boolean
  asked: LinkedKind | null
  error: PanelError | null
  askingAbout: string | null
  aboutError: { at: string; error: PanelError } | null
}
export const agent = atom<AgentState | null>(null)

/** The agent state for the workspace on screen, once found. */
export function agentNow(): AgentState | null {
  const a = read(agent)
  return a && a.where === focusKey() ? a : null
}

/** Looks for the agent to ask when the empty state or an issue shows for a workspace (or on Refresh,
 *  or when an agent there changes state): a failure, such as Orca not allowing it, is no agent.
 *  `keep` (an agent's change) keeps what was asked and why it failed, and draws nothing when the
 *  answer is the same. */
let finding = 0
// The workspace a look is on its way for: the empty state and an issue landing ask at once.
const lookingFor = atom<string | null>(null)
export async function findAgent(again = false, keep = false): Promise<void> {
  const where = focusKey()
  if (!again && (read(agent)?.where === where || read(lookingFor) === where)) return
  // Agent events come quickly: only the latest look answers.
  const mine = ++finding
  set(lookingFor, where)
  const answer = await plugin.request('agent.find').catch(requestFailed)
  if (mine !== finding) return
  set(lookingFor, null)
  if (focusKey() !== where) return
  const before = read(agent)
  const kept = keep && before?.where === where ? before : null
  const next: AgentState = {
    where,
    agent: answer.ok ? answer.agent : null,
    blocked: answer.ok ? answer.blocked : null,
    asking: kept?.asking ?? false,
    asked: kept?.asked ?? null,
    error: kept?.error ?? null,
    askingAbout: kept?.askingAbout ?? null,
    aboutError: kept?.aboutError ?? null
  }
  if (JSON.stringify(next) !== JSON.stringify(before)) set(agent, next)
}

/** Whether an agent changing state is looked for again: only when Orca names its workspace and that is
 *  the panel's (`workspaceListId`; only the panel's agents are offered, and Orca names none for a pane
 *  tied to no workspace), and not while a prompt is on its way. A look then keeps what was asked
 *  (`findAgent`'s `keep`), so "Typed into" stays until Refresh. */
export function mayRefindAgent(workspaceListId?: string): boolean {
  const r = read(repo)
  if (!workspaceListId || (r?.ok && r.workspaceId !== workspaceListId)) return false
  const a = agentNow()
  return !a?.asking && !a?.askingAbout
}

/** Types the link prompt into the agent's terminal; the person presses Enter there. */
export async function askAgent(kind: LinkedKind): Promise<void> {
  const a = agentNow()
  if (!a?.agent || a.asking) return
  const { where, agent: offered } = a
  set(agent, { ...a, asking: true, error: null })
  const answer = await plugin.request('agent.ask', { terminalId: offered.terminalId, ask: { link: kind } }).catch(requestFailed)
  if (focusKey() !== where) return
  if (answer.ok) return set(agent, { ...a, agent: { ...offered, name: answer.agent }, asking: false, asked: kind, error: null })
  if (answer.error.code !== 'no_agent') return set(agent, { ...a, asking: false, error: answer.error })
  // No agent free any more: it says why, and asks again what the agent is doing now.
  await findAgent(true)
  const now = agentNow()
  if (now) set(agent, { ...now, error: answer.error })
}

/** Types a prompt about an issue or one of its comments (`at`: the post's node id) into the agent's
 *  terminal; the person reads it and presses Enter there, so nothing else shows once it is typed. */
export async function askAbout(at: string, ask: AgentAsk): Promise<void> {
  const a = agentNow()
  if (!a?.agent || a.askingAbout) return
  const offered = a.agent
  set(agent, { ...a, askingAbout: at, aboutError: null })
  const answer = await plugin.request('agent.ask', { terminalId: offered.terminalId, ask }).catch(requestFailed)
  // agentNow() is null once the panel shows another workspace.
  const now = agentNow()
  if (!now) return
  if (answer.ok || answer.error.code !== 'no_agent') return set(agent, { ...now, askingAbout: null, aboutError: answer.ok ? null : { at, error: answer.error } })
  // That agent cannot take it any more: the post says why, and the panel asks what agent there is now.
  await findAgent(true)
  const found = agentNow()
  if (found) set(agent, { ...found, aboutError: { at, error: answer.error } })
}

export function dismissAboutError(): void {
  const a = agentNow()
  if (a) set(agent, { ...a, aboutError: null })
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
