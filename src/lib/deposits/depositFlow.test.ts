import { describe, it, expect } from 'vitest';
import { reduceFlow, INITIAL_FLOW, type FlowState } from './depositFlow';

const at = (phase: FlowState['phase'], outcome: FlowState['outcome'] = null): FlowState => ({ phase, outcome });

describe('reduceFlow', () => {
  it('starts idle with no outcome', () => {
    expect(INITIAL_FLOW).toEqual({ phase: 'idle', outcome: null });
  });

  it('idle + CAPTURE -> scanning', () => {
    expect(reduceFlow(at('idle'), { type: 'CAPTURE' })).toEqual(at('scanning'));
  });

  it('scanning + SCAN_DONE -> review', () => {
    expect(reduceFlow(at('scanning'), { type: 'SCAN_DONE' })).toEqual(at('review'));
  });

  it('review + SUBMIT -> submitting', () => {
    expect(reduceFlow(at('review'), { type: 'SUBMIT' })).toEqual(at('submitting'));
  });

  it('review + CAPTURE -> scanning (retake)', () => {
    expect(reduceFlow(at('review'), { type: 'CAPTURE' })).toEqual(at('scanning'));
  });

  it('submitting + SUBMIT_SUCCESS -> result(success)', () => {
    expect(reduceFlow(at('submitting'), { type: 'SUBMIT_SUCCESS' })).toEqual(at('result', 'success'));
  });

  it('submitting + SUBMIT_ERROR -> result(error)', () => {
    expect(reduceFlow(at('submitting'), { type: 'SUBMIT_ERROR' })).toEqual(at('result', 'error'));
  });

  it('result(success) + DISMISS -> idle', () => {
    expect(reduceFlow(at('result', 'success'), { type: 'DISMISS' })).toEqual(at('idle'));
  });

  it('result(error) + DISMISS -> review (keeps photo+edits)', () => {
    expect(reduceFlow(at('result', 'error'), { type: 'DISMISS' })).toEqual(at('review'));
  });

  it('RESET from any phase -> idle', () => {
    for (const p of ['idle', 'scanning', 'review', 'submitting', 'result'] as const) {
      expect(reduceFlow(at(p, p === 'result' ? 'success' : null), { type: 'RESET' })).toEqual(INITIAL_FLOW);
    }
  });

  it('ignores events that do not apply to the current phase (no-op)', () => {
    const s = at('idle');
    expect(reduceFlow(s, { type: 'SCAN_DONE' })).toEqual(s);
    expect(reduceFlow(s, { type: 'SUBMIT' })).toEqual(s);
    expect(reduceFlow(at('scanning'), { type: 'SUBMIT' })).toEqual(at('scanning'));
    expect(reduceFlow(at('review'), { type: 'SCAN_DONE' })).toEqual(at('review'));
    expect(reduceFlow(at('submitting'), { type: 'CAPTURE' })).toEqual(at('submitting'));
  });
});
