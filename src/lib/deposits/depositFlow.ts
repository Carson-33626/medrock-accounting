// Explicit state machine for the photo-first deposit flow. Pure and total:
// any (phase, event) pair that has no defined transition returns the input
// state unchanged, so a stray dispatch can never wedge the UI into an
// invalid phase. Kept free of React so it can be unit-tested without a DOM.

export type DepositPhase = 'idle' | 'scanning' | 'review' | 'submitting' | 'result';
export type ResultOutcome = 'success' | 'error';

export interface FlowState {
  phase: DepositPhase;
  // Only meaningful while phase === 'result'; null in every other phase.
  outcome: ResultOutcome | null;
}

export type FlowEvent =
  | { type: 'CAPTURE' }        // a photo was captured/picked -> begin scanning
  | { type: 'SCAN_DONE' }      // OCR finished (success OR soft-fail) -> review
  | { type: 'SUBMIT' }         // user tapped Upload -> submitting
  | { type: 'SUBMIT_SUCCESS' } // upload succeeded -> result(success)
  | { type: 'SUBMIT_ERROR' }   // upload failed -> result(error)
  | { type: 'DISMISS' }        // dismiss the result modal
  | { type: 'RESET' };         // hard reset to idle (auto after success)

export const INITIAL_FLOW: FlowState = { phase: 'idle', outcome: null };

export function reduceFlow(state: FlowState, event: FlowEvent): FlowState {
  // RESET is global — it returns to idle from any phase.
  if (event.type === 'RESET') return INITIAL_FLOW;

  switch (state.phase) {
    case 'idle':
      if (event.type === 'CAPTURE') return { phase: 'scanning', outcome: null };
      return state;
    case 'scanning':
      if (event.type === 'SCAN_DONE') return { phase: 'review', outcome: null };
      return state;
    case 'review':
      if (event.type === 'SUBMIT') return { phase: 'submitting', outcome: null };
      if (event.type === 'CAPTURE') return { phase: 'scanning', outcome: null };
      return state;
    case 'submitting':
      if (event.type === 'SUBMIT_SUCCESS') return { phase: 'result', outcome: 'success' };
      if (event.type === 'SUBMIT_ERROR') return { phase: 'result', outcome: 'error' };
      return state;
    case 'result':
      if (event.type === 'DISMISS') {
        return state.outcome === 'error'
          ? { phase: 'review', outcome: null }
          : { phase: 'idle', outcome: null };
      }
      return state;
    default:
      return state;
  }
}
