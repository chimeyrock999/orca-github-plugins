// What the workspace's agent is asked about a failed run: one line (a newline would send it), with
// the gh command that reads the failed log, so no log text is typed.
import { GhError } from '../gh'
import type { RepoRef } from '../lists'
import type { RunDetail } from '../../shared/protocol'

/** The failed jobs the prompt names; the rest are counted. */
export const PROMPT_JOBS = 3

/** A name from GitHub on one line: control characters (C0, DEL, C1) and the Unicode line and
 *  paragraph separators become spaces. */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()

/** The prompt asking the agent to fix a finished run that failed; any other run is refused. */
export function fixRunPrompt(repo: RepoRef, run: RunDetail): string {
  if (!run.done || run.state !== 'failure') {
    throw new GhError('not_failed', `${oneLine(run.workflow)} #${run.runNumber} has not failed, so there is nothing to fix.`)
  }
  const failed = run.jobs.filter((j) => j.state === 'failure').map((j) => oneLine(j.name))
  const more = failed.length - PROMPT_JOBS
  const jobs = failed.length ? `; failed jobs: ${failed.slice(0, PROMPT_JOBS).join(', ')}${more > 0 ? `, +${more} more` : ''}` : ''
  return (
    `Fix the failed GitHub Actions run ${run.url} (${oneLine(run.workflow)} #${run.runNumber}${jobs}). ` +
    `Read its failed log with: gh run view ${run.id} --log-failed -R ${repo.nameWithOwner}`
  )
}
