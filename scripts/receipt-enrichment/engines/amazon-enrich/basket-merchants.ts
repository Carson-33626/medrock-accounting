// The allowlist of TRUE mixed-SKU basket merchants — the split engine adds value here because one
// receipt maps to MULTIPLE GL codes (like Amazon). Deliberately EXCLUDES food/fuel/travel/SaaS
// (ezCater, Doordash, Shell, Uber, Anthropic, …): those are single-category and belong to the
// whole-transaction coder (Track B), not the splitter. Landscape scan 2026-07-13 picked these as the
// receipt-bearing, high-$ inventory/supply vendors. Amazon stays in the list so the same run covers it.
export interface MerchantGroup {
  key: string;
  label: string;
  test: RegExp;
}

export const BASKET_MERCHANTS: MerchantGroup[] = [
  { key: 'amazon', label: 'Amazon', test: /amazon/i },
  { key: 'walmart', label: 'Walmart', test: /walmart/i },
  { key: 'sams', label: "Sam's Club", test: /sam'?s\s*club/i },
  { key: 'costco', label: 'Costco', test: /costco/i },
  { key: 'uline', label: 'ULINE', test: /\buline\b/i },
  { key: 'usplastic', label: 'US Plastic', test: /u\.?\s?s\.?\s*plastic/i },
  { key: 'makingcosmetics', label: 'MakingCosmetics', test: /making\s*cosmetics/i },
  { key: 'dropperbottles', label: 'DropperBottles', test: /dropper\s*bottles/i },
  { key: 'cosmeticpkg', label: 'Cosmetic Packaging', test: /cosmetic\s*packaging/i },
  { key: 'toprx', label: 'TopRx', test: /\btoprx\b/i },
  { key: 'usplasticcorp', label: 'US Plastic Corp', test: /us\s*plastic\s*corp/i },
];

// Longest-label-first isn't needed (patterns are disjoint), but return the first match deterministically.
export function matchBasketMerchant(name: string | null): MerchantGroup | null {
  const n = name ?? '';
  for (const g of BASKET_MERCHANTS) if (g.test.test(n)) return g;
  return null;
}

export function isBasketMerchant(name: string | null): boolean {
  return matchBasketMerchant(name) !== null;
}
