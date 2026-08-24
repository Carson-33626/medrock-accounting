'use client';

import HelpTip from './HelpTip';
import type { ProductDetailResponse } from '@/types/inventory';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * One product's purchase receipts, oldest first — the bottom of the drill-down
 * and the point where a number stops being a total and becomes a document.
 *
 * Shared by the Inventory Valuation page and the inventory-close category
 * drill-down deliberately: the CPA substantiating a posted entry and the analyst
 * browsing stock must see the same receipts, laid out the same way. Two copies
 * of this table would drift.
 */
export default function FifoQueue({
  detail,
  rowBorder,
  subText,
}: {
  detail: ProductDetailResponse;
  rowBorder: string;
  subText: string;
}) {
  if (detail.receipts.length === 0) {
    return (
      <p className={`text-xs ${subText}`}>
        No purchase receipts for this product{detail.month ? ` as of ${detail.month}` : ''}.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold flex items-center gap-1.5">
        FIFO queue — {detail.product_name ?? detail.product_key}
        {detail.product_name && !detail.product_key.startsWith('name:') ? ` (${detail.product_key})` : ''}
        {detail.month ? <span className={`font-normal ${subText}`}>· as of {detail.month}</span> : null}
        <HelpTip
          label="How the FIFO queue works"
          text="Each row is one purchase receipt, oldest first. Consumption draws from the top of the queue down, so remaining stock always sits in the newest lots. Quantities and values are stated as of the month above — not today. “LF” marks receipts whose remaining quantity is pinned to LifeFile’s lot report rather than simulated."
        />
      </p>
      {detail.locations.map((loc) => {
        const locReceipts = detail.receipts.filter((r) => r.location === loc);
        if (locReceipts.length === 0) return null;
        return (
          <div key={loc}>
            {detail.locations.length > 1 && (
              <p className={`text-xs font-semibold uppercase tracking-wide mb-1 ${subText}`}>
                {loc.replace('MedRock ', '')}
              </p>
            )}
            <table className="w-full text-xs">
              <thead>
                <tr className={subText}>
                  <th className="text-left py-1 pr-3 font-medium">#</th>
                  <th className="text-left py-1 pr-3 font-medium">Received</th>
                  <th className="text-left py-1 pr-3 font-medium">Lot</th>
                  <th className="text-left py-1 pr-3 font-medium">Vendor</th>
                  <th className="text-right py-1 pr-3 font-medium">Qty</th>
                  <th className="text-right py-1 pr-3 font-medium">Unit Cost</th>
                  <th className="text-right py-1 pr-3 font-medium">Consumed</th>
                  <th className="text-right py-1 pr-3 font-medium">Remaining</th>
                  <th className="text-right py-1 pr-3 font-medium">Value</th>
                  <th className="text-left py-1 font-medium">Fully Used</th>
                </tr>
              </thead>
              <tbody>
                {locReceipts.map((r) => (
                  <tr key={r.receipt_id} className={`border-t ${rowBorder}`}>
                    <td className="py-1 pr-3">{r.fifo_position}</td>
                    <td className="py-1 pr-3">
                      {r.is_opening_balance
                        ? `Opening balance${r.ob_as_of_month ? ` (as of ${r.ob_as_of_month})` : ''}`
                        : (r.date_received ?? '—')}
                    </td>
                    <td className="py-1 pr-3">{r.lot_number ?? '—'}</td>
                    <td className="py-1 pr-3">{r.vendor ?? '—'}</td>
                    <td className="py-1 pr-3 text-right">
                      {r.qty_received !== null ? qty.format(r.qty_received) : '—'}
                    </td>
                    <td className="py-1 pr-3 text-right">
                      {r.unit_cost !== null ? usd.format(r.unit_cost) : '—'}
                    </td>
                    <td className="py-1 pr-3 text-right">
                      {qty.format(r.qty_consumed)}
                      {r.lot_anchored && (
                        <span
                          title="Anchored to LifeFile actuals (lot report / balance snapshot) rather than the usage simulation"
                          className="ml-1 text-[9px] align-middle px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 font-semibold uppercase"
                        >
                          LF
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3 text-right">{qty.format(r.qty_remaining)}</td>
                    {/* The column that makes this a substantiation rather than a
                        stock list: these values are what the category line, the
                        location total, and the posted entry are summed from. */}
                    <td className="py-1 pr-3 text-right tabular-nums font-medium">
                      {r.remaining_value !== null ? usd.format(r.remaining_value) : '—'}
                    </td>
                    <td className="py-1">{r.fully_used_month ?? 'open'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
