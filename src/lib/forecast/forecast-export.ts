import ExcelJS from 'exceljs';
import type { ForecastModel } from '@/components/location-analytics/forecastModel';

type Cell = string | number;

interface ExportModel {
  headers: string[];
  rows: Cell[][];
}

/**
 * Wide layout matching the on-screen table: one row per location, a column
 * per month. Each month cell follows the panel's dual-cell precedence —
 * provisional months (hold-out + current-partial) prefer the modeled
 * estimate over the partial actual; strictly-future months use the
 * projection; otherwise the completed actual; blank if none apply.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for API symmetry with the other exporters
export function buildExportModel(model: ForecastModel, metricLabel: string): ExportModel {
  const headers = ['Location', 'Method', 'CMGR %', ...model.allMonths];
  const provisionalSet = new Set(model.provisionalMonths);
  const rows: Cell[][] = model.locations.map((loc) => {
    const cells: Cell[] = model.allMonths.map((m) => {
      if (provisionalSet.has(m)) {
        const v = loc.est[m] ?? loc.actual[m];
        return v === undefined ? '' : v;
      }
      if (m in loc.future) return loc.future[m];
      if (m in loc.actual) return loc.actual[m];
      return '';
    });
    return [loc.label, loc.method, loc.cmgr.toFixed(1), ...cells];
  });
  return { headers, rows };
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

export function exportForecastCsv(model: ForecastModel, metricLabel: string, filename: string): void {
  const { headers, rows } = buildExportModel(model, metricLabel);
  const lines: string[] = [];
  lines.push(headers.map(csvEscape).join(','));
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  const content = '﻿' + lines.join('\r\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `${filename}.csv`);
}

export async function exportForecastXlsx(
  model: ForecastModel,
  metricLabel: string,
  filename: string,
): Promise<void> {
  const { headers, rows } = buildExportModel(model, metricLabel);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MedRock Accounting';
  wb.created = new Date();
  const ws = wb.addWorksheet('Location Forecast', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
  });

  ws.columns = headers.map((h) => ({ header: h, key: h, width: 12 }));
  for (const row of rows) ws.addRow(row);

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle' };

  ws.columns.forEach((col, idx) => {
    const label = headers[idx];
    let max = label.length;
    for (const row of rows) {
      const v = row[idx];
      const len = v == null ? 0 : String(v).length;
      if (len > max) max = len;
    }
    col.width = Math.min(Math.max(max + 2, 8), 40);
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerDownload(blob, `${filename}.xlsx`);
}

export function exportForecastPdf(): void {
  window.print();
}
