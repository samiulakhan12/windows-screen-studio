/**
 * The question before a run (docs/design/smart-tools.md §2.7, §11.5): when the high end of a paid
 * run passes the amount of pref aiConfirm (US$1.00 by default; Always ask: every paid run; Never:
 * none), "This costs up to about US$1.40 with claude-opus-5-5. Run it?"; a cost Flown does not know,
 * once per provider and model in a session (not with Never); on this PC, a run longer than 10 minutes.
 * An alert dialog with Run (or Start) and Cancel, Cancel focused; Esc cancels.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { AiTextRequest, TextChoice } from '../../../shared/api/ai'
import { confirmText, needsConfirm, type CostEstimate } from '../../../shared/ai/cost'
import { CONFIRM_PREFS, DEFAULT_CONFIRM, type ConfirmPref } from '../../../shared/smart/smartPrefs'
import { CostConfirm } from './CostConfirm'
import { estimateFor, readCostData } from './useCost'

/** Providers and models whose unknown cost was asked about and run this session. */
const askedUnknown = new Set<string>()

/** Whether `choice`'s unknown cost was already asked about and run this session. */
export const wasAsked = (choice: Pick<TextChoice, 'id' | 'model'>): boolean => askedUnknown.has(`${choice.id}|${choice.model}`)

/** Forgets what was asked this session (tests). */
export function resetAskedCosts(): void {
  askedUnknown.clear()
}

/** The pref aiConfirm as stored ('1' when absent or malformed). */
export async function confirmPref(): Promise<ConfirmPref> {
  try {
    const v = await window.api.getPref('aiConfirm')
    return CONFIRM_PREFS.includes(v as ConfirmPref) ? (v as ConfirmPref) : DEFAULT_CONFIRM
  } catch {
    return DEFAULT_CONFIRM
  }
}

/** Shows the question and resolves with the answer (true: run). */
export type AskCost = (q: { text: string; action: string }) => Promise<boolean>

/** The dialog, mounted over the page until answered; the focus then goes back where it was. */
export const askInDialog: AskCost = (q) =>
  new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const done = (run: boolean): void => {
      root.unmount()
      host.remove()
      resolve(run)
    }
    root.render(createElement(CostConfirm, { text: q.text, action: q.action, onDone: done }))
  })

/**
 * Whether to go ahead with a run of `estimate` with `choice`: true at once when nothing needs asking,
 * else the user's answer. `ask` shows the question (the alert dialog by default).
 */
export async function confirmCost(estimate: CostEstimate, choice: TextChoice, ask: AskCost = askInDialog): Promise<boolean> {
  const key = `${choice.id}|${choice.model}`
  const pref = await confirmPref()
  if (!needsConfirm(estimate, pref, askedUnknown.has(key))) return true
  const run = await ask(confirmText(estimate, choice.model || choice.place))
  if (run && !estimate.seconds && !estimate.usd) askedUnknown.add(key)
  return run
}

/**
 * The question before a run no cost line's button starts (Make my captions great from its button or
 * the palette, a caption language's Translate again): what `request` costs with `choice`, from the
 * price data once read; true when nothing needs asking, else the answer.
 */
export async function confirmRequest(choice: TextChoice, request: AiTextRequest, ask: AskCost = askInDialog): Promise<boolean> {
  const estimate = estimateFor(choice, request, await readCostData())
  return !estimate || (await confirmCost(estimate, choice, ask))
}
