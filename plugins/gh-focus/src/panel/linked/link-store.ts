// What the Issues and Pull requests tabs offer around the linked items: the hand-offs to Orca's Tasks
// page and Checks tab, and, with nothing linked, a free agent to ask to link one (`../agent/`).
import { atom, plugin, read, set } from 'orca'
import type { OrcaView, PanelError } from '../../shared/protocol'
import { findAgent } from '../agent/agent-store'
import { lists, requestFailed } from '../store'
import type { AnyThread } from '../thread/thread-store'

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

/** Back from a thread; the empty state it may land on offers a free agent, so one is looked for. */
export async function backFrom(t: AnyThread): Promise<void> {
  await t.backToList()
  if (!read(lists[t.kind]).open && t.linkedNow()?.refs?.length === 0) await findAgent()
}
