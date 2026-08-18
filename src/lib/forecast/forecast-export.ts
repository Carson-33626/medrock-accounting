import ExcelJS from 'exceljs';
import type { ForecastModel } from '@/components/location-analytics/forecastModel';
import { totalCell, computeTotalCmgr } from './forecast-cells';
import type { VarianceGroup, VarianceStatus } from './manual-forecast-variance';

type Cell = string | number;

interface ExportModel {
  title: string;
  headers: string[];
  rows: Cell[][];
  totalRow: Cell[];
}

/** Variance payload the panel passes through when a manual overlay is selected. */
export interface VarianceExport {
  overlayName: string;
  groups: VarianceGroup[];
}

interface VarianceExportModel {
  title: string;
  headers: string[];
  rows: Cell[][];
}

/**
 * Wide layout matching the on-screen table: one row per location, a column
 * per month. Each month cell follows the panel's dual-cell precedence —
 * provisional months (hold-out + current-partial) prefer the modeled
 * estimate over the partial actual; strictly-future months use the
 * projection; otherwise the completed actual; blank if none apply.
 * The Total row mirrors the UI's Total column (`totalCell` /
 * `computeTotalCmgr` from forecast-cells — the same functions the table uses).
 */
export function buildExportModel(model: ForecastModel, metricLabel: string): ExportModel {
  const headers = ['Location', 'Method', 'CMGR %', ...model.allMonths];
  const provisionalSet = new Set(model.provisionalMonths);
  const rows: Cell[][] = model.locations.map((loc) => {
    const cells: Cell[] = model.allMonths.map((m) => {
      if (provisionalSet.has(m)) {
        // Deliberately differs from computeVariance (which uses `actual` for
        // completed hold-out months): this export column mirrors the model
        // estimate, while the variance table compares against known actuals.
        const v = loc.est[m] ?? loc.actual[m];
        return v === undefined ? '' : v;
      }
      if (m in loc.future) return loc.future[m];
      if (m in loc.actual) return loc.actual[m];
      return '';
    });
    return [loc.label, loc.method, loc.cmgr.toFixed(1), ...cells];
  });
  const totalRow: Cell[] = [
    'Total',
    '',
    computeTotalCmgr(model).toFixed(1),
    ...model.allMonths.map((m): Cell => {
      const t = totalCell(model, m);
      if (t.kind === 'empty') return '';
      // Provisional months keep the est-over-actual precedence of the
      // per-location cells above, so the Total row stays a column sum.
      if (t.kind === 'dual') return t.estValue ?? t.value;
      return t.value;
    }),
  ];
  return { title: `${metricLabel} — actuals & forecast by month`, headers, rows, totalRow };
}

function statusLabel(status: VarianceStatus): string {
  switch (status) {
    case 'close':
      return 'Close';
    case 'over':
      return 'Over';
    case 'under':
      return 'Under';
    default:
      return '—';
  }
}

/**
 * Manual-vs-system variance, flattened from the grouped `computeVariance`
 * output the on-screen VarianceTable renders: one row per (location, month)
 * plus a Subtotal row per location. Months without a system counterpart
 * export blank Δ cells, matching the UI's em-dashes.
 */
export function buildVarianceExportModel(variance: VarianceExport, metricLabel: string): VarianceExportModel {
  const headers = ['Location', 'Month', 'Manual', 'System', 'System kind', 'Δ', 'Δ %', 'Status'];
  const rows: Cell[][] = [];
  for (const group of variance.groups) {
    for (const r of group.rows) {
      rows.push([
        group.label,
        r.label,
        r.manual,
        r.system ?? '',
        r.systemKind ?? '',
        r.delta ?? '',
        r.deltaPct === null ? '' : r.deltaPct.toFixed(1),
        statusLabel(r.status),
      ]);
    }
    const s = group.subtotal;
    rows.push([
      group.label,
      'Subtotal',
      s.manual,
      s.system ?? '',
      '',
      s.delta ?? '',
      s.deltaPct === null ? '' : s.deltaPct.toFixed(1),
      statusLabel(s.status),
    ]);
  }
  return {
    title: `${metricLabel} — manual vs. system variance (overlay: ${variance.overlayName})`,
    headers,
    rows,
  };
}

function csvEscape(value: Cell): string {
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportForecastCsv(
  model: ForecastModel,
  metricLabel: string,
  filename: string,
  variance?: VarianceExport,
): void {
  const { title, headers, rows, totalRow } = buildExportModel(model, metricLabel);
  const lines: string[] = [];
  lines.push(csvEscape(title));
  lines.push(headers.map(csvEscape).join(','));
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  lines.push(totalRow.map(csvEscape).join(','));
  if (variance) {
    const v = buildVarianceExportModel(variance, metricLabel);
    lines.push('');
    lines.push(csvEscape(v.title));
    lines.push(v.headers.map(csvEscape).join(','));
    for (const row of v.rows) lines.push(row.map(csvEscape).join(','));
  }
  const content = '﻿' + lines.join('\r\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `${filename}.csv`);
}

/** Shared sheet layout: bold title row, bold header row, data, auto-fit widths. */
function fillSheet(
  ws: ExcelJS.Worksheet,
  title: string,
  headers: string[],
  rows: Cell[][],
): void {
  ws.addRow([title]).font = { bold: true };
  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle' };
  for (const row of rows) ws.addRow(row);

  headers.forEach((label, idx) => {
    let max = label.length;
    for (const row of rows) {
      const v = row[idx];
      const len = v == null ? 0 : String(v).length;
      if (len > max) max = len;
    }
    ws.getColumn(idx + 1).width = Math.min(Math.max(max + 2, 8), 40);
  });
}

export async function exportForecastXlsx(
  model: ForecastModel,
  metricLabel: string,
  filename: string,
  variance?: VarianceExport,
): Promise<void> {
  const { title, headers, rows, totalRow } = buildExportModel(model, metricLabel);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MedRock Accounting';
  wb.created = new Date();
  const ws = wb.addWorksheet('Location Forecast', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
  });
  fillSheet(ws, title, headers, [...rows, totalRow]);
  // Title + header + data rows precede it, so the Total row is the last one.
  ws.getRow(rows.length + 3).font = { bold: true };

  if (variance) {
    const v = buildVarianceExportModel(variance, metricLabel);
    const vws = wb.addWorksheet('Manual vs System Variance', {
      views: [{ state: 'frozen', ySplit: 2 }],
    });
    fillSheet(vws, v.title, v.headers, v.rows);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(blob, `${filename}.xlsx`);
}

export function exportForecastPdf(): void {
  window.print();
}
