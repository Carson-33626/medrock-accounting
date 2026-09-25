/**
 * Standard cost per packaging unit — the price half of
 * `packaging COGS = units_consumed × price_per_unit`.
 *
 * The units half is the loader's business: `src/transforms/fifo/devices.ts`
 * classifies every compound fill into a `(device, sku)` with a units-per-fill.
 * This module only says what one of those units is worth.
 *
 * WHY STANDARD COST AND NOT FIFO. Packaging is bought and consumed inside the
 * same month — modelled consumption came to 111% of actual 2026 QuickBooks
 * packaging spend, and within 8–25% in each entity independently
 * (`ds-device-standard-cost-2026-09-03.md` §4). An account that only ever
 * receives purchases and is never relieved is not accumulating stock, it is
 * accumulating unrecognised expense. There are no meaningful packaging lots to
 * draw down, so a lot ledger is the wrong instrument and a price table is the
 * right one.
 *
 * EVERY PRICE IS SOURCED. `provenance` is not decoration: a price with no
 * invoice behind it flows straight into a posted journal entry, so each row
 * records the vendor, the document and the arithmetic. `confidence` is the
 * honest reading of that source, and `null` means deliberately unpriced — see
 * `UNPRICED` below. Read `docs/fifo-monthly-close/device-pricing-filled-2026-09-03.csv`
 * for the long-form evidence behind each row.
 *
 * Pinned by `device-prices.test.ts` so a silent edit cannot change what posts,
 * the same way `ACCRUAL_PARAMETERS` is pinned.
 */

/** How much to trust the price, and therefore how loudly to caveat the line. */
export type PriceConfidence = 'high' | 'medium' | 'low';

/** One priced packaging unit. */
export interface DevicePrice {
  /** Device name exactly as the loader's `resolveDevice` emits it. */
  readonly device: string;
  /** SKU exactly as `resolveDevice` emits it — `''` for devices with one size. */
  readonly sku: string;
  /** Dollars per ONE unit, i.e. per unit the classifier counts, not per case. */
  readonly pricePerUnit: number;
  readonly confidence: PriceConfidence;
  /** Vendor, document and the arithmetic that produced `pricePerUnit`. */
  readonly provenance: string;
}

/**
 * The price table.
 *
 * CASE PRICING IS THE RECURRING TRAP. Half the corrections made on 2026-09-04
 * were a case price read as a unit price: Tret Pump at $189.64 was a case, the
 * eye pads are bought by the bag, the vials by the box of 190, the V-Line masks
 * by the case of 25. Where a row divides a case, the division is written out in
 * `provenance` so the next reader can check it rather than re-derive it.
 *
 * DEVICE NAMES FOLLOW THE ONE RULING SHEET (Carson, 2026-09-25: every system
 * converges on MRPBI `docs/device-usage/DEVICE-RULINGS.md` §1). Retired names:
 * Rosacea Pump -> Rosacea Pump (Frosted), Amber Drop Bottle -> Solution Bottle,
 * Nail Brush Bottle -> Nail Bottle, Foam Pump -> Foam Bottle, Roller Bottle ->
 * Sweatless Roller, Lip Gloss Tube -> Wart Pen, V-Line Mask Pack -> Neck Wrap Pack,
 * Perioral Lip Ointment -> Perioral Lip Ointment Jar. Single-size devices are keyed
 * on sku '' so whatever size label the loader emits ('55mL', '10g') falls back to it.
 */
export const DEVICE_UNIT_PRICES: readonly DevicePrice[] = [
  /* ── airless pumps: the bulk of the model, ~78% of modelled units ──
   *
   * PRICED BY BOX CODE, one row per size. The lab's 2026-09-25 packaging reference
   * (MRPBI docs/Packaging references updated 2026/packaging-reference-2026-09-25.md)
   * names the Cosmetic Packaging Now box for every pump size, which settles two
   * things the 09-04 table had to guess:
   *
   *  - Frosted (= Rosacea) and Melasma are DIFFERENT boxes at different prices —
   *    Frosted is the Luxe *FS line, Melasma the Luxe *WS line. They were priced as
   *    one "silver" class before, and the Rosacea 45g row was in fact Melasma's box.
   *  - AK size -> box is now STATED, not inferred from size order.
   *
   * Every row is the quantity-weighted net across the 15 distinct CPN invoices in
   * `receipt-enrichment/cache/cosmeticpackaging/*.ocr.txt` (33378..34918, Jan-Apr
   * 2026; duplicates cached from several emails counted once), landed at +15.24% —
   * CPN shipping as a share of goods, measured over 19 invoices in
   * `ds-device-standard-cost-2026-09-03.md` §14.5 (this pull's 15 give 15.15%).
   * Bottlemate also sells 15/30 ml airless (landed 1.463 / 2.167) but is ~8% of pump
   * spend and not a box the lab names, so it corroborates rather than sets a row.
   *
   * No Frosted or Melasma box exists above 45g, so a larger silver fill is counted
   * by the loader as N x the 30g box (Carson, 2026-09-25) and prices at the 30g row.
   * If one of the unsheeted CPN codes turns out to be a real 60g pump, that becomes
   * its own size line here and in the loader together.
   */
  {
    device: 'Rosacea Pump (Frosted)', sku: '15g', pricePerUnit: 1.84, confidence: 'high',
    provenance:
      'Lab box 01LUX15FS (Luxe 15 ML Matte Silver / Frosted). CPN invoices: 1,250 units for ' +
      '$1,997.50 = 1.5980 net (1.52-1.65); x 1.1524 landed = 1.8415.',
  },
  {
    // Blends in the Glossy Black backup box: Carson 2026-09-25, "these were ordered as
    // backup because the silver got backordered, so treat these as backup to the
    // mainline stock." Same body and size, different collar — and in 2026 the backup
    // outsold the mainline, so leaving it out would understate what a unit costs.
    device: 'Rosacea Pump (Frosted)', sku: '30g', pricePerUnit: 2.00, confidence: 'high',
    provenance:
      'Lab box 02LUX30FS (Luxe 30 ML Matte Silver / Frosted): 5,320 units for $9,116.20, plus ' +
      'backup 05-LUX-30FB (Glossy Black / Frosted): 6,460 units for $11,369.60 = 11,780 for ' +
      '$20,485.80 = 1.7390 net; x 1.1524 landed = 2.0040.',
  },
  {
    device: 'Rosacea Pump (Frosted)', sku: '45g', pricePerUnit: 2.12, confidence: 'high',
    provenance:
      'Lab box 03LUX50FS (Luxe 50 ML Matte Silver / Frosted). CPN 33662/34114: 420 units at ' +
      '1.84 net; x 1.1524 landed = 2.1204. The 09-04 row (1.84) was 15-LUX-50WS — the Melasma box.',
  },
  {
    device: 'Melasma Pump', sku: '15g', pricePerUnit: 1.76, confidence: 'high',
    provenance:
      'Lab box 13LUX15WS (Luxe 15 ML Matte Silver / White): 1,000 units at 1.53, plus backup ' +
      '16-LUX-15WB (Glossy Black / White, Carson 2026-09-25: backorder substitute): 2,750 units ' +
      'at 1.53 = 1.53 net either way; x 1.1524 landed = 1.7632.',
  },
  {
    device: 'Melasma Pump', sku: '30g', pricePerUnit: 1.66, confidence: 'high',
    provenance:
      'Lab box 14LUX30WS (Luxe 30 ML Matte Silver / White): 10,640 units at 1.43, plus backup ' +
      '17-LUX-30WB (Glossy Black / White, Carson 2026-09-25: backorder substitute): 380 units at ' +
      '1.62 = 11,020 for $15,830.80 = 1.4365 net; x 1.1524 landed = 1.6554.',
  },
  {
    device: 'Melasma Pump', sku: '45g', pricePerUnit: 2.09, confidence: 'high',
    provenance:
      'Lab box 15LUX50WS (Luxe 50 ML Matte Silver / White). CPN invoices: 1,400 units at 1.81 ' +
      'net; x 1.1524 landed = 2.0858.',
  },
  {
    // The lab sheet gives 58PUR30WF for BOTH 15g and 30g, and Carson confirmed it
    // 2026-09-25 (ruling sheet v1.3): a 15g AK fill goes in the 30 mL body. The
    // 57-PUR-15WF billed once on 34575 is not the AK 15g box.
    device: 'AK Pump', sku: '15g', pricePerUnit: 0.96, confidence: 'high',
    provenance:
      'Lab box 58PUR30WF, the same body as 30g (confirmed, ruling sheet v1.3). CPN invoices: ' +
      '11,712 units for $9,713.28 = 0.8293 net (0.79-0.83); x 1.1524 landed = 0.9557.',
  },
  {
    device: 'AK Pump', sku: '30g', pricePerUnit: 0.96, confidence: 'high',
    provenance:
      'Lab box 58PUR30WF (Pure 30 ML White PP / Frosted cap). CPN invoices: 11,712 units for ' +
      '$9,713.28 = 0.8293 net (0.79-0.83); x 1.1524 landed = 0.9557.',
  },
  {
    device: 'AK Pump', sku: '45g', pricePerUnit: 1.62, confidence: 'high',
    provenance:
      'Lab box 59PUR50WF (Pure 50 ML White PP). CPN invoices: 2,880 units for $4,043.52 = ' +
      '1.4040 net (1.38-1.41); x 1.1524 landed = 1.6180.',
  },
  {
    device: 'AK Pump', sku: '60g', pricePerUnit: 1.87, confidence: 'high',
    provenance:
      'Lab box 72PUR75WF (Pure 75 ML White PP). CPN invoices: 1,200 units for $1,944.00 = ' +
      '1.6200 net (1.53-1.65); x 1.1524 landed = 1.8669. The 09-04 row (1.86) used the 100 ML ' +
      'box 60-PUR-100WF, which is now its own 100g size below.',
  },
  {
    device: 'AK Pump', sku: '100g', pricePerUnit: 1.99, confidence: 'high',
    provenance:
      'Box 60PUR100WF (Pure 100 ML White PP), added as the AK 100g size by ruling sheet v1.3 ' +
      '(Carson 2026-09-25) for 61-100g fills. CPN invoices: 2,176 units for $3,764.48 = 1.7300 ' +
      'net, the same on every invoice; x 1.1524 landed = 1.9937.',
  },
  {
    // THE TRET PUMP IS CPN'S ECHO AIRLESS JAR. The lab sheet gives it no box code;
    // the bills do. TN's LifeFile receiving logged lot `24ECH50CW` (Echo 50 ML) under
    // the product "Tret Pump (45g)", and 2026 Echo buying (~3,200 jars across all
    // three entities, FL/TN/TX, QuickBooks 1220.15) matches the ~3,000 Tret Pumps
    // modelled. Echo 30 ML -> 20g, Echo 50 ML -> 45g. Shiny (23/24-ECH-..CW) and
    // matte (53/54-ECH-..CW-M) collars are the same body at the same price.
    //
    // Carson, 2026-09-25, approved re-pricing off these bills. They replace the $2.28
    // midpoint of 2022-23 invoices, which was the best evidence before the Echo
    // connection was made.
    device: 'Tret Pump', sku: '20g', pricePerUnit: 2.17, confidence: 'high',
    provenance:
      'CPN Echo 30 ML Airless Jar (23-ECH-30CW shiny / 53-ECH-30CW-M matte), 2026 QB bills with ' +
      'stated quantity or unit price: 33587, 33684, 33736, 34757, 34876, 34918, 35226, 35475, ' +
      '35955 = 2,016 units for $3,798.48 = 1.8842 net (1.83-1.93); x 1.1524 landed = 2.1714. ' +
      'docs/tech-spend-recon/qb-lines.csv.',
  },
  {
    device: 'Tret Pump', sku: '45g', pricePerUnit: 2.14, confidence: 'high',
    provenance:
      'CPN Echo 50 ML Airless Jar (24-ECH-50CW shiny / 54-ECH-50CW-M matte) — the LifeFile ' +
      'Tret Pump (45g) lot 24ECH50CW. 2026 QB bills 33684, 33736, 34757, 35473 = 720 units at ' +
      '1.86 net on every one; x 1.1524 landed = 2.1435.',
  },
  {
    device: 'Foam Bottle', sku: '', pricePerUnit: 1.40, confidence: 'high',
    provenance:
      'U.S. Plastic Corp 7886277/7901857 item 62484 "50 ML PET BOTTLE / PP FOAMER CLEAR-WHITE" ' +
      'at 1.4060 discounted, 1.4800 list.',
  },

  /* ── bottles, jars and vials ── */
  {
    device: 'Solution Bottle', sku: '1oz dropper', pricePerUnit: 0.68, confidence: 'high',
    provenance:
      'ULINE S-24309A across 35 invoices: 33,792 units bought in 2026 for $23,078.40 = 0.6830 ' +
      'invoice price, freight excluded (~5%). Largest single dollar correction in the sheet — ' +
      'the prior 0.49 anchor was 28% low across 71,072 units.',
  },
  {
    device: 'Ointment Jar', sku: '2oz', pricePerUnit: 0.43, confidence: 'high',
    provenance:
      'ULINE S-14505 across 21 invoices: 5,376 units in 2026 for $2,315.52 = 0.4307, freight excluded.',
  },
  {
    device: 'Ointment Jar', sku: '4oz', pricePerUnit: 0.48, confidence: 'high',
    provenance:
      'ULINE S-14506 across 29 invoices: 5,724 units in 2026 for $2,766.96 = 0.4834. The prior ' +
      '0.84 anchor was 74% high and made the 4 oz dearer than the 10 oz, which cannot be right.',
  },
  {
    device: 'Ointment Jar', sku: '10oz', pricePerUnit: 0.92, confidence: 'high',
    provenance:
      'ULINE S-17039 across 25 invoices: 5,712 units in 2026 for $5,267.04 = 0.9221.',
  },
  {
    device: 'Vial (30DR)', sku: '30DR', pricePerUnit: 0.27, confidence: 'high',
    provenance:
      'The Vial Store order #38711 — CASE PRICING: "30 Dram Reversible Cap Vials Blue ' +
      '(190 Units/Box)" at $43.99/box, 3 boxes = 570 vials. $131.97 + $20.00 shipping = ' +
      '$151.97 / 570 = 0.2666. Only 570 vials bought in 2026 against 2,876 modelled, so a ' +
      'second vial source probably exists.',
  },
  {
    device: 'Suspension Bottle', sku: '', pricePerUnit: 0.90, confidence: 'medium',
    provenance:
      'U.S. Plastic Corp "LIQUID OVAL BOTTLE W/ CR CAP 24MM BLUE" blended across sizes: ' +
      '2 oz item 82205 at 0.77 (45 units), 3 oz 82206 at 1.07-1.08 (110), 4 oz 82207 at 0.81 ' +
      '(150) = 305 units for $274.45 = 0.8998. NOT included: item 82231 dosing adapter at 0.67 ' +
      '(120 units on the same orders) — add it if every suspension ships with one.',
  },
  {
    device: 'Sweatless Roller', sku: '', pricePerUnit: 1.19, confidence: 'medium',
    provenance:
      'Amazon (Mirrline) — CASE PRICING: $14.24 per 12-piece pack = 1.1867/bottle, the same ' +
      'price on three independent 2026 orders (Ramp 0b54790a / 493bd884 / c21953ac).',
  },
  {
    // The Kiss Me Goodnight container. The inventory app's device code 32ORB30CW is
    // CPN's Orbit 30 ML Acrylic Double Wall Jar. The old 'White & Silver Jar' row was
    // priced off the Echo airless jar, which turned out to be the Tret Pump.
    // Bought only twice: TN 2025-08-11 (#31490, $740.00) and FL 2026-07-20 (#36007).
    device: 'Orbit Jar', sku: '', pricePerUnit: 1.69, confidence: 'high',
    provenance:
      'CPN #36007 (QB FL bill 2026-07-20) "Orbit 30 ML Acrylic Double Wall Jar" x 250 for ' +
      '$367.50 = 1.47 net; x 1.1524 landed = 1.6940. CPN lists it at $2.20, $1.47 at volume.',
  },
  {
    device: 'Nail Bottle', sku: '', pricePerUnit: 0.64, confidence: 'high',
    provenance:
      'A SUMMED ASSEMBLY, not an average of two alternatives — one dispensed nail-brush bottle ' +
      'is one brush cap SCREWED ONTO one amber glass bottle, so the components ADD. U.S. Plastic ' +
      'item 62750/62752 brush cap 6,440 units for $2,775.28 = 0.4310, plus item 67567 1/2 oz ' +
      'amber Boston round 2,300 units for $482.40 = 0.2097. Both appear on the SAME invoices in ' +
      'matching quantities (7851279: 300+300; 7917435: 800+800; 7958320: 800+800). Do not ' +
      '"correct" this down to either component alone.',
  },
  /* ── the pen ──
   * Carson 2026-09-25 (ruling sheet v1.5): NO pen/tube split. Wart medications
   * including the bio-adhesives go out in 10g pens only, emitted as sku '10g' and
   * priced here via the '' fallback. The retired 'Lip Gloss Tube' row is gone.
   */
  {
    device: 'Wart Pen', sku: '', pricePerUnit: 1.23, confidence: 'high',
    provenance:
      'InterestPACK CI26051903 via CBP Form 7501 entry 8GX-8028910-1, HTS 3923.90.0080 "PLASTIC ' +
      'TWIST PEN": 50,250 pieces, entered value $44,002.50 = 0.8757 FOB. New Marine NYC-OI040104 ' +
      'adds duty $16,928.57 + bond $726.04 + ISF $85.00. Landed $61,742.11 / 50,250 = 1.2287. ' +
      'Ocean freight is on NEITHER document, so this is a FLOOR, not a ceiling.',
  },

  /* ── companion items: counted per fill alongside a primary device ── */
  {
    // CARSON, 2026-09-04: "Scar sheets are rolls, they are 1.6 x 120 and they break
    // off 4 squares for the 15gm and 8 for the 30gm."
    //
    // The 4/8 matches the companion the loader already carries, so only the PRICE
    // was missing. The unit is one broken-off square, not a roll and not a "pack":
    // a 1.6in-wide roll broken into 1.6in squares yields 120/1.6 = 75 squares.
    device: 'Scar Sheet Pack', sku: '', pricePerUnit: 0.17, confidence: 'medium',
    provenance:
      'Amazon silicone scar sheet ROLLS 1.6in x 120in (Ramp 1a8c1c55 / 39e43b2f / 8fafdc9d / ' +
      'e38c0ab4): 6 rolls for $74.87 twice, plus one at $17.08 = 13 rolls for $166.82 = ' +
      '$12.83/roll. Carson 2026-09-04: squares are broken off the roll, 4 per 15g fill and 8 ' +
      'per 30g. A 1.6in-wide roll gives 120/1.6 = 75 squares, so 12.83/75 = 0.1711. The ' +
      'SQUARE side length is the one inferred step — the roll width is stated, the cut is not.',
  },
  {
    device: 'Eye Pad Pack', sku: '', pricePerUnit: 0.18, confidence: 'medium',
    provenance:
      'Amazon CHMI under-eye patches — CASE PRICING by the bag: 100-pair at $17.09, 50-pair at ' +
      '$9.21-9.49. 2026 spend $1,047.54 across CHMI/NIYET/Grace & Stella = ~5,190 pairs, so ' +
      '0.18 is PER PAD. Reading the 4/8 companion as pads gives 4,586 modelled against ~5,190 ' +
      'bought (88%), which reconciles; reading it as pairs gives 177%, which does not.',
  },
  {
    // CARSON, 2026-09-04: "V-line mask pack is 25 per case, an order will get 2 of
    // those for 15, 4 for 30gm." The 2/4 is a UNITS correction owned by the loader
    // (the companion currently reads 4/8, i.e. double). This row is only the price.
    device: 'Neck Wrap Pack', sku: '', pricePerUnit: 1.56, confidence: 'medium',
    provenance:
      'Amazon (Ramp 04979907) "V Shaped Contouring Face Mask Line Shaping Lifting Belt" at ' +
      '$38.99 — CASE PRICING: Carson 2026-09-04 states 25 per case, so 38.99/25 = 1.5596. The ' +
      'listing itself does not state the pack count; the 25 is his.',
  },
];

/**
 * Deliberately UNPRICED devices, and why. Kept as data rather than as absence so
 * the JE can say "this device consumed units we did not value" instead of
 * silently valuing them at zero — a blank that reads as $0.00 is the same
 * mistake as a guess, just quieter.
 */
export interface UnpricedDevice {
  readonly device: string;
  readonly reason: string;
}

export const UNPRICED: readonly UnpricedDevice[] = [
  {
    device: 'Lip Balm',
    reason:
      "NEW DEVICE in the lab's 2026-09-25 reference (all lip balms). No purchase priced yet — " +
      'find the tube in the Ramp receipt OCR cache before guessing.',
  },
  {
    device: 'Perioral Lip Ointment Jar',
    reason:
      "NEW DEVICE in the lab's 2026-09-25 reference: a small clear jar of its own, no longer the " +
      'ULINE ointment jar. Vendor and price not yet found.',
  },
  {
    // CARSON, 2026-09-04: "Topiclick was for hormones that we no longer use so
    // that can be written off."
    device: 'Topi-Click',
    reason:
      'RETIRED — the hormone line it dispensed is discontinued (Carson 2026-09-04), so its ' +
      'balance is a write-off rather than a priced consumption. 1,104 units still modelled in ' +
      '2026 though, so the discontinuation date has to be established before the retirement ' +
      'posts; the loader is measuring rule 8/10 fills by month.',
  },
  {
    device: 'Syringes',
    reason:
      'NOT VERIFIED. The 3.01 anchor for a 10 mL AIRLESS syringe applicator has no 2026 invoice ' +
      'behind it. Do NOT substitute the plain luer syringes the lab buys on Amazon (~$0.076 each, ' +
      '40x lower) — those are the in-lab wetting-agent consumable, a different item from the ' +
      'dispenser that goes out with the compound.',
  },
  {
    device: 'Unmapped',
    reason: 'The classifier reached no rule. Nothing to price; the units are the finding.',
  },
];

/** Every priced device keyed `device||sku`, built once. */
const BY_KEY: ReadonlyMap<string, DevicePrice> = new Map(
  DEVICE_UNIT_PRICES.map((p): readonly [string, DevicePrice] => [`${p.device}||${p.sku}`, p]),
);

const UNPRICED_BY_DEVICE: ReadonlyMap<string, UnpricedDevice> = new Map(
  UNPRICED.map((u): readonly [string, UnpricedDevice] => [u.device, u]),
);

/**
 * The price for one classified unit, or `null` when the device is unpriced.
 *
 * Falls back to the device's single-SKU row when the exact `(device, sku)` pair
 * is absent, so a loader-side SKU band that splits later does not silently drop
 * to zero — it keeps the device's price until someone prices the new band.
 */
export function priceFor(device: string, sku: string): DevicePrice | null {
  return BY_KEY.get(`${device}||${sku}`) ?? BY_KEY.get(`${device}||`) ?? null;
}

/** Why a device carries no price, or `null` if it is priced or simply unknown. */
export function unpricedReason(device: string): string | null {
  return UNPRICED_BY_DEVICE.get(device)?.reason ?? null;
}
