/**
 * Whether main's answer to a job says it was cancelled (docs/design/output-and-languages.md §9.6):
 * main throws or rejects a cancel with the cancel code (CANCELLED_ERROR, longJobs.ts), and the
 * renderer decides by that code, never by the words of the message, which are in the UI language.
 */
import { isCancelled } from '../../../shared/jobs/longJobs'

export const isCancel = (err: unknown): boolean => isCancelled(err)
