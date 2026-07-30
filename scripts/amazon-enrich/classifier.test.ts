// Guards the correction rules in docs/ramp-recon/item_corrections.json against REAL item descriptions,
// copied verbatim out of the Walmart and Sam's Club preview splits.
//
// Two halves, and the second matters as much as the first:
//   1. consumables that must code — they were landing in Suspense, or somewhere absurd
//   2. regression guards — items the phrase-voting lookup already gets RIGHT, which a sloppy correction
//      regex would hijack. "Paper Mate ... Pens" vs "Paper Towel", and skin creams vs hand soap, are
//      the traps these rules were written around.
import { describe, it, expect } from 'vitest';
import { classify } from './classifier';

const OFFICE_EXP = 'General & Administrative -:Office Expense';
const OFFICE_SUP = 'General & Administrative -:Office Supplies';
const COMPUTER = 'General & Administrative -:Computer Supplies & Equipment';
const COMPOUND = 'Inventory Asset:Compound Ingredient Inventory';
const LAB_INV = 'Inventory Asset:Lab Supplies Inventory';
const SHIPPING = 'Inventory Asset:Shipping Packaging Material Inventory';

// buildSplit books anything under this to Suspense, so a "corrected" line that lands at 0.79 is still
// uncoded. Assert the GL and the threshold together or the test proves nothing.
const THRESHOLD = 0.8;

function expectGl(desc: string, gl: string): void {
  const c = classify(desc);
  expect(`${c.glName} @>=${c.confidence >= THRESHOLD}`).toBe(`${gl} @>=true`);
}

function cases(title: string, rows: [string, string][]): void {
  describe(title, () => {
    for (const [desc, gl] of rows) it(desc.slice(0, 64), () => expectGl(desc, gl));
  });
}

cases('classifier: breakroom + janitorial consumables -> Office Expense', [
  ["Member's Mark Select & Tear 2-Ply Paper Towel 15 rolls, 150 sheets/roll", OFFICE_EXP],
  ['Marathon Multifold 1-Ply White Paper Towels 16 pks., 250 towels/pk', OFFICE_EXP],
  ["Member's Mark Ultra Premium 2-Ply Toilet Paper 45 rolls, 235 sheets/roll", OFFICE_EXP],
  ['Kleenex Lotion Facial Tissues 12 boxes, 120 tissues/box', OFFICE_EXP],
  ["Member's Mark Power Flex 13-Gallon Tall Kitchen Trash Bags, 200 ct.", OFFICE_EXP],
  ["Member's Mark Power Flex 13-Gallon Tall Kitchen Trash Bags, Fresh Scent, 200 ct.", OFFICE_EXP],
  ['Nestle Coffee-Mate Coffee Creamer Liquid Creamer Singles, French Vanilla, 180 ct.', OFFICE_EXP],
  ['Café Bustelo Festival Size Dark Roast Ground Coffee, Espresso 46 oz.', OFFICE_EXP],
  ['Maxwell House House Blend Medium K-Cup Coffee Pods 100 ct.', OFFICE_EXP],
  ["Sweet'N Low Zero-Calorie Sweetener Packets, 1,500 ct.", OFFICE_EXP],
  ['Dawn Professional Heavy Duty Manual Pot and Pan Dish Soap Detergent 1 Gallon', OFFICE_EXP],
  ['Dawn Platinum Plus Powerwash Dish Spray Bottle Set, Fresh Scent, 1 Spray Bottle + 2 Refills, 64.5 fl. oz.', OFFICE_EXP],
  ['Scotch-Brite Heavy Duty Scrub Sponges, Individually Wrapped 24 ct.', OFFICE_EXP],
  ['Febreze Air Mist Air Freshener Spray, Gain Original + Unstopables Fresh, 4ct., 32.4 oz.', OFFICE_EXP],
  ["Member's Mark Aloe Vera Moisturizing Hand Soap, 80 fl. oz.", OFFICE_EXP],
  ["Member's Mark White Plastic Forks, Heavyweight 600 ct.", OFFICE_EXP],
  ["Member's Mark Heavyweight White Plastic Spoons, 600 ct.", OFFICE_EXP],
  ['WinCup Foam Drink Cups 18 Series, White, Multi ct.', OFFICE_EXP],
  ['Hefty Supreme Foam Disposable Snack Plates, 6", 320 ct.', OFFICE_EXP],
  ['Doritos Nacho Cheese Tortilla Chips, 1 oz., 50 pk.', OFFICE_EXP],
  ['Coca-Cola Soft Drink 12 fl. oz., 35 pk.', OFFICE_EXP],
  ['Rice Krispies Treats Squares Snack Bars, Variety Pack, 40 ct.', OFFICE_EXP],
  ['Always Ultra Thin Pads Duo Pack, 74 ct.', OFFICE_EXP],
]);

// Three near-identical Member's Mark paper plates used to land in three different accounts. The point
// of the tableware rule is that they now agree, so assert them as a set.
cases('classifier: near-identical items must land in the SAME account', [
  ["Member's Mark Ultra Lunch Paper Plates, 8.5\", 300 ct.", OFFICE_EXP],
  ["Member's Mark Ultra Dessert/Snack Paper Plates, 6.875\", 330 ct.", OFFICE_EXP],
  ["Member's Mark Ultra Dinner Paper Plates, 10\", 204 ct.", OFFICE_EXP],
  ['Dixie Ultra Heavyweight Dinner Paper Plates, 10", 186 ct.', OFFICE_EXP],
]);

cases('classifier: office paper goods -> Office Supplies', [
  ["Member's Mark Multipurpose Copy Paper, 8.5 x 11”, 92 Bright, 20 lbs., 10 Reams (5,000 sheets)", OFFICE_SUP],
  ['Pen+Gear Copy Paper, 8.5" x 11", 92 Bright White, 20 lb., 10 Ream Case (5,000 Sheets)', OFFICE_SUP],
  ['Pen+Gear No. 1 Size Smooth Paper Clips, Silver, 100 Count', OFFICE_SUP],
  ["Member's Mark Envelope #10, Peel and Seal 500 ct.", OFFICE_SUP],
]);

cases('classifier: batteries -> Computer Supplies & Equipment', [
  ["Member's Mark AA Alkaline Batteries, 48 pk.", COMPUTER],
]);

cases('classifier: regression guards — corrections must NOT hijack these', [
  // "Paper Mate" / "Pen+Gear" must not trip the paper-towel or copy-paper rules.
  ['Paper Mate Profile Retractable Ballpoint Pens, 1.4 mm Bold Point, Black, 8 Count', OFFICE_SUP],
  ['Post-it Tabs and Flags Combo Pack, 1 in Wide Tabs and .47 in Wide Flags, Assorted Colors, 36 Tabs and 100 Flags', OFFICE_SUP],
  ['Alliance Advantage Rubber Bands, Size #32 (3" x 1/8"), Approx. 350 Bands per 8 oz Bag, Natural', OFFICE_SUP],
  // Compounding stock: "Wash", "Cream", "Lotion", "Balm", "Hand and Body" must not read as breakroom.
  ['Cetaphil Moisturizing Lotion Hydrating Lotion for All Skin Types, Sensitive Skin, 4 fl oz', COMPOUND],
  ['Cetaphil Face Wash Hydrating Gentle Skin Cleanser for Dry to Normal Sensitive Skin, 16 fl oz', COMPOUND],
  ['(3 pack) PanOxyl 10% Benzoyl Peroxide Acne Foaming Wash, 5.5 Oz', COMPOUND],
  ['Aquaphor Lip Ointment, Lip Balm with Shea Butter, 0.35 fl oz', COMPOUND],
  ['Equate Beauty Hand and Body Moisturizing Cream with Hyaluronic Acid, 12 oz', COMPOUND],
  ['Taro Hydrocortisone Cream 1% Maximum Strength (1 Fl Oz) Fast-Acting Anti-Itch Relief for Eczema, Psoriasis, Rashes, Hives, Bug Bites & Irritated Skin, Dye Free', COMPOUND],
  // Real lab and shipping consumables stay put.
  ['EQPT Blue Powder-Free Nitrile Gloves, 2 pk., 300 ct.', LAB_INV],
  ['Scotch Heavy Duty Shipping Packaging Tape Dispensers, 1.88" x 27.7 yd, 6 Pack', SHIPPING],
  ['Member’s Mark 6-ft. Surge Protector w/ 8 AC outputs, 1 USB-C + 1 USB-A outputs', COMPUTER],
  // The DYMO corrections that predate this pass must still win.
  ['DYMO LabelWriter 4XL Labels 1744907 4 x 6 Shipping', SHIPPING],
  ['DYMO 30252 Address Labels 1-1/8 x 3-1/2', LAB_INV],
]);
