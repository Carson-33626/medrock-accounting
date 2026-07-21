'use client';
import { rankMethods, accuracyPct } from '@/lib/forecast/scores';
import type { EntityMethodScore, ForecastMethod } from '@/lib/forecast/types';

export function MethodAccuracyStrip({
  scores, selectedMethod, onPick, subText, cardBg,
}: {
  scores: EntityMethodScore[];
  selectedMethod: string;
  onPick: (m: ForecastMethod) => void;
  subText: string;
  cardBg: string;
}) {
  const ranked = rankMethods(scores, new Set());
  const anyScored = ranked.some((r) => r.wape !== null);
  return (
    <div className={`rounded-xl shadow-sm p-4 ${cardBg}`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs uppercase tracking-wide ${subText}`}>Backtest accuracy</span>
      </div>
      {!anyScored ? (
        <p className={`text-xs ${subText}`}>Move &ldquo;Forecast start&rdquo; back to grade each method against known actuals.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ranked.filter((r) => r.wape !== null).map((r) => {
            const selected = r.method === selectedMethod;
            return (
              <button
                key={r.method}
                onClick={() => onPick(r.method)}
                className={`px-3 py-1.5 text-xs rounded-lg border${r.recommended && !selected ? ' ring-1 ring-emerald-500' : ''}`}
                style={selected ? { backgroundColor: '#5e3b8d', color: 'white' } : undefined}
              >
                <span className="font-medium">{r.method}</span>{' '}
                {accuracyPct(r.wape as number).toFixed(1)}%{r.recommended ? ' ✓' : ''}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
