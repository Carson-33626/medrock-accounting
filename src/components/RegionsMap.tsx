'use client';

import { useMemo, useState } from 'react';
import { METRO_POINTS, US_MAP_VIEWBOX, US_STATE_PATHS } from '@/lib/us-map-paths';
import { REGION_GEO } from '@/lib/region-geo';

export type MapFilter = { kind: 'state'; code: string } | { kind: 'region'; id: string } | null;

export interface MapRegion {
  id: string;
  region: string;
  holder: string | null;
}

interface RegionsMapProps {
  regions: MapRegion[];
  filter: MapFilter;
  onFilter: (next: MapFilter) => void;
  darkMode: boolean;
}

interface MetroDot {
  id: string;
  region: string;
  holder: string | null;
  x: number;
  y: number;
}

export default function RegionsMap({ regions, filter, onFilter, darkMode }: RegionsMapProps) {
  const [hoverState, setHoverState] = useState<string | null>(null);

  // State code → regions touching it (for shading + tooltips).
  const byState = useMemo(() => {
    const m = new Map<string, MapRegion[]>();
    for (const r of regions) {
      for (const code of REGION_GEO[r.region]?.states ?? []) {
        const list = m.get(code) ?? [];
        list.push(r);
        m.set(code, list);
      }
    }
    return m;
  }, [regions]);

  const dots = useMemo(() => {
    const out: MetroDot[] = [];
    for (const r of regions) {
      const metro = REGION_GEO[r.region]?.metro;
      const p = metro ? METRO_POINTS[metro] : undefined;
      if (p) out.push({ id: r.id, region: r.region, holder: r.holder, x: p.x, y: p.y });
    }
    return out;
  }, [regions]);

  // States lit by the current filter: the picked state, or every state the picked region covers.
  const activeStates = useMemo(() => {
    if (!filter) return new Set<string>();
    if (filter.kind === 'state') return new Set([filter.code]);
    const r = regions.find((x) => x.id === filter.id);
    return new Set(r ? REGION_GEO[r.region]?.states ?? [] : []);
  }, [filter, regions]);

  const fill = (code: string): string => {
    const covered = byState.has(code);
    if (activeStates.has(code)) return '#5e3b8d';
    if (!covered) return darkMode ? '#1e293b' : '#e5e7eb';
    if (hoverState === code) return darkMode ? '#7c5bb0' : '#b9a2dc';
    return darkMode ? '#4c3575' : '#d8cbee';
  };

  const stroke = darkMode ? '#0f172a' : '#ffffff';

  return (
    <svg viewBox={US_MAP_VIEWBOX} className="w-full h-auto" role="img" aria-label="Map of marketer regions">
      {Object.entries(US_STATE_PATHS).map(([code, s]) => {
        const here = byState.get(code);
        const clickable = here !== undefined;
        return (
          <path
            key={code}
            d={s.d}
            fill={fill(code)}
            stroke={stroke}
            strokeWidth={1}
            className={clickable ? 'cursor-pointer transition-colors' : undefined}
            onMouseEnter={clickable ? () => setHoverState(code) : undefined}
            onMouseLeave={clickable ? () => setHoverState(null) : undefined}
            onClick={
              clickable
                ? () =>
                    onFilter(filter?.kind === 'state' && filter.code === code ? null : { kind: 'state', code })
                : undefined
            }
          >
            <title>{here ? `${s.name} — ${here.map((r) => r.region).join(', ')}` : s.name}</title>
          </path>
        );
      })}
      {dots.map((d) => {
        const selected = filter?.kind === 'region' && filter.id === d.id;
        return (
          <circle
            key={d.id}
            cx={d.x}
            cy={d.y}
            r={selected ? 10 : 7}
            fill={selected ? '#f59e0b' : '#2e1065'}
            stroke={darkMode ? '#e2e8f0' : '#ffffff'}
            strokeWidth={2}
            className="cursor-pointer"
            onClick={() => onFilter(selected ? null : { kind: 'region', id: d.id })}
          >
            <title>{`${d.region}${d.holder ? ` — ${d.holder}` : ' — open'}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}
