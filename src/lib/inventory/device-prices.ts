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
 */
export const DEVICE_UNIT_PRICES: readonly DevicePrice[] = [
  /* ── airless pumps: the bulk of the model, ~78% of modelled units ── */
  {
    device: 'Rosacea Pump', sku: '30g', pricePerUnit: 2.04, confidence: 'high',
    provenance:
      'Bottlemate 53734/53758/53859 + Cosmetic Packaging Now 33587/34918. 30ml airless ' +
      'assembly (bottle+pump+overcap) 1,620 units at 1.21-1.30 goods; landed with tariff, ' +
      'freight and pallet = 2.167. CPN Luxe 30ML nets 1.43-1.63 before shipping. 2.04 sits mid-band.',
  },
  {
    device: 'Rosacea Pump', sku: '15g', pricePerUnit: 1.51, confidence: 'high',
    provenance:
      'Bottlemate 53741/53860 + CPN 34918 (01-LUX-15FS). 15ml airless 2,940 units at ' +
      '0.95-0.97 goods; landed with 40% China tariff + freight = 1.463. CPN Luxe 15ML nets 1.52-1.53.',
  },
  {
    device: 'Rosacea Pump', sku: '45g', pricePerUnit: 1.84, confidence: 'high',
    provenance: 'CPN 33587/34918, SKU 15-LUX-50WS nets 1.81 on BOTH invoices; 1.84 with shipping.',
  },
  // Melasma is the same physical airless line as Rosacea — same sizes, same anchors.
  {
    device: 'Melasma Pump', sku: '30g', pricePerUnit: 2.04, confidence: 'high',
    provenance: 'Same 30ml airless class as Rosacea Pump 30g — see that row.',
  },
  {
    device: 'Melasma Pump', sku: '15g', pricePerUnit: 1.51, confidence: 'high',
    provenance: 'Same 15ml airless class as Rosacea Pump 15g — see that row.',
  },
  {
    device: 'Melasma Pump', sku: '45g', pricePerUnit: 1.84, confidence: 'high',
    provenance: 'Same 50ML Luxe SKU as Rosacea Pump 45g — see that row.',
  },
  {
    device: 'AK Pump', sku: '15G', pricePerUnit: 0.79, confidence: 'medium',
    provenance:
      'CPN Pure white-PP airless 58-PUR-30WF nets exactly 0.79 on invoice 34918 and 0.83 on 33587. ' +
      'Which CPN SKU maps to which AK size is INFERRED from size order, not stated on the invoice.',
  },
  {
    device: 'AK Pump', sku: '30/45G', pricePerUnit: 1.51, confidence: 'medium',
    provenance:
      'CPN 33587/34918 Pure PP airless line (58/59/72-PUR): 0.79 (30ML) / 1.38 (50ML) / ' +
      '1.53 (75ML) / 1.73 (100ML) before shipping. 1.51 sits in band. SKU-to-size mapping inferred.',
  },
  {
    device: 'AK Pump', sku: '60G', pricePerUnit: 1.86, confidence: 'medium',
    provenance: 'CPN Pure 100 ML (60-PUR-100WF) nets 1.73 before shipping, 1.86 with. SKU-to-size mapping inferred.',
  },
  {
    // CARSON, 2026-09-04, on the $1.90-vs-measured question: "Screenshot for the
    // website listing. Otherwise go from the agent's invoice ruling."
    //
    // So: the measured invoices win. $1.90 was NEVER an invoice — it was $189.64
    // divided by an ASSUMED 100-count case, and the assumption was the whole basis.
    // Cosmetic Packaging receipts that state their quantities give 2.42/2.47 (2022,
    // 250 units each) and 2.26/2.30 (2023). Most recent pair is 2026's best evidence.
    //
    // The screenshot corroborates the line rather than this exact SKU. Tret Pump 45g
    // carries LifeFile lot `24ECH50CW` — CPN's ECHO 50 ML — and the listing Carson
    // sent prices ECHO 15 ML at $2.69 (low as $1.80) and ECHO 30 ML at $2.73 (low as
    // $1.83). Two things follow. The Echo line is priced almost FLAT across sizes
    // (4c between 15 and 30 ML), which is why 20g and 45g take the same number here
    // instead of a size ladder. And $2.28 sits between the volume tier and list,
    // which is where a real invoice should sit.
    device: 'Tret Pump', sku: '20g', pricePerUnit: 2.28, confidence: 'medium',
    provenance:
      'Cosmetic Packaging invoices with STATED quantities: 2.26/2.30 (2023) and 2.42/2.47 ' +
      '(2022, 250 units each); 2.28 is the midpoint of the most recent pair. Corroborated by ' +
      'the CPN listing for the same ECHO line (15 ML $2.69 list / $1.80 volume, 30 ML $2.73 / ' +
      '$1.83) and by the LifeFile sibling median of $2.77 for lot 24ECH50CW. REPLACES the ' +
      '$1.90 assumed-100-count-case figure, which was never an invoice price.',
  },
  {
    device: 'Tret Pump', sku: '45g', pricePerUnit: 2.28, confidence: 'medium',
    provenance:
      'Same ECHO line as Tret Pump 20g and priced flat across sizes — see that row. LifeFile ' +
      'lot 24ECH50CW (ECHO 50 ML) sibling median $2.77; price-outliers row 11 corrects the ' +
      'keyed $156.31 to $2.77 on the same evidence.',
  },
  {
    device: 'Foam Pump', sku: '', pricePerUnit: 1.40, confidence: 'high',
    provenance:
      'U.S. Plastic Corp 7886277/7901857 item 62484 "50 ML PET BOTTLE / PP FOAMER CLEAR-WHITE" ' +
      'at 1.4060 discounted, 1.4800 list.',
  },

  /* ── bottles, jars and vials ── */
  {
    device: 'Amber Drop Bottle', sku: '1oz dropper', pricePerUnit: 0.68, confidence: 'high',
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
    device: 'Roller Bottle', sku: '', pricePerUnit: 1.19, confidence: 'medium',
    provenance:
      'Amazon (Mirrline) — CASE PRICING: $14.24 per 12-piece pack = 1.1867/bottle, the same ' +
      'price on three independent 2026 orders (Ramp 0b54790a / 493bd884 / c21953ac).',
  },
  {
    device: 'White & Silver Jar', sku: '', pricePerUnit: 1.87, confidence: 'medium',
    provenance:
      'CPN 23-ECH-30CW "Echo 30 ML Airless Jar with Shiny Silver Collar": 168 units at 1.93 ' +
      '(33587) + 252 at 1.83 (34918) = 420 for $785.40 = 1.8700; ~2.13 with shipping allocated. ' +
      "Carson's 2026-09-04 listing screenshot prices this exact item at $2.73 list / $1.83 at " +
      'volume, so our invoice sits at the volume tier. Name match to the dispensed product is inferred.',
  },
  {
    device: 'Nail Brush Bottle', sku: '', pricePerUnit: 0.64, confidence: 'high',
    provenance:
      'A SUMMED ASSEMBLY, not an average of two alternatives — one dispensed nail-brush bottle ' +
      'is one brush cap SCREWED ONTO one amber glass bottle, so the components ADD. U.S. Plastic ' +
      'item 62750/62752 brush cap 6,440 units for $2,775.28 = 0.4310, plus item 67567 1/2 oz ' +
      'amber Boston round 2,300 units for $482.40 = 0.2097. Both appear on the SAME invoices in ' +
      'matching quantities (7851279: 300+300; 7917435: 800+800; 7958320: 800+800). Do not ' +
      '"correct" this down to either component alone.',
  },
  {
    device: 'Lip Gloss Tube', sku: '', pricePerUnit: 1.13, confidence: 'high',
    provenance:
      'U.S. Plastic item 68167 "11ML LIP GLOSS TUBE W/BLK APLCTR": 4,350 units in 2026 for ' +
      '$4,608.28 = 1.0594 (list 1.23-1.25 less 15%). 1.13 = invoice + ~7% freight.',
  },

  /* ── the pen ── */
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
    device: 'V-Line Mask Pack', sku: '', pricePerUnit: 1.56, confidence: 'medium',
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
