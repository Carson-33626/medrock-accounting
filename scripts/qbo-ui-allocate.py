"""QBO intercompany allocation of `Allocate - XX`-classed Purchases, driven through the QBO web UI.

WHY A BROWSER: QBO creates the BTS_ALLOCATION JE pair only from the "Allocate" dialog on the expense
form (Intuit Enterprise Suite). The v3 API cannot trigger it (proven 2026-10-27, see
docs/accounting-requests/2026-10-27-may-alloc136.md). A plain UI "Save" does not either (2026-10-28).

HOW TO RUN (Claude Code eval kernel, Python, with the Claude-in-Chrome extension connected):
  1. In Chrome: log in to QBO, switch to the SOURCE company (the one holding the purchases).
     Ask Claude for the MCP tab id (tabs_context_mcp).
  2. Build the work list, read-only, from web/:
       npx tsx scripts/_probe-may-alloc-status.ts list      -> receipt-enrichment/cache/may-alloc/unpaired.json
       npx tsx scripts/_probe-may-alloc-lines.ts            -> cache/may-alloc/lines.json (+ memo-vs-class conflicts)
     Resolve every "memo mentions .. but class targets .." conflict with Carson BEFORE allocating those rows.
  3. In the eval kernel:
       %load "scripts/qbo-ui-allocate.py"          (from web/)
       setup(tab_id=<QBO tab>, tool=tool)
       rows = load_rows(key='FL')                  # skips conflict rows by default
       await run(rows, verify_every=10)            # pilot: await run(rows[:1])
  4. Verify from the API (read-only):
       npx tsx scripts/_probe-may-alloc-status.ts verify --ids=FL:54718,FL:52700
       npx tsx scripts/_probe-may-alloc-status.ts list     -> must drop to 0 / $0.00

PER-PURCHASE STEPS (what the routine clicks):
  open /app/expense?txnId=<id>  -> wait for Payee to load
  footer "Allocate"             -> "Intercompany expense allocation" dialog
  for each category row with an "Allocate" action:
     row "Allocate" -> side panel -> "Select companies to allocate to" = target company
     click the panel's blank area (the pick commits only once the list closes) -> panel "Save"
  every target sub-row needs a category: QBO usually auto-fills the mirror account (same number);
  if empty, type the account's leaf name and take the matching option
  dialog "Save"                 -> expense footer shows "View allocation" = pair created
  (The pair's note = purchase memo + "This allocation was created in <Company> Ref no. Expense #<id>",
   dated the purchase date. The dialog's "Allocation date" shows one day early: timezone display only.)

NOTES / GOTCHAS
  - Escape closes the whole expense form. Never send it.
  - "To edit this expense, delete all allocations first" appears after success; the allocation is reversible
    from "View allocation" -> Delete.
  - Every row is 100 % to a single company here. Split targets would need the percentage fields.
  - Source company must match row['key']; switch the QBO company in the UI between FL and TN batches.
"""
import asyncio
import json
import re
from pathlib import Path

_T = None
_TAB = None
CO = {'TX': 'Medrock TEXAS', 'TN': 'Medrock TENNESSEE', 'FL': 'Medrock FLORIDA'}
LINES_JSON = Path(globals().get('__file__', 'web/scripts/qbo-ui-allocate.py')).resolve().parents[2] / 'receipt-enrichment' / 'cache' / 'may-alloc' / 'lines.json'

PAYEE = r"""(()=>{const i=document.querySelector('input[placeholder="Who did you pay?"]');return i&&i.value?i.value:false})()"""
ALREADY = r"""(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='View allocation');return b?'VIEW_ALLOCATION':false})()"""
CLICK_FOOTER_ALLOC = r"""(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Allocate'&&!(x.closest('[role=dialog]')||{innerText:''}).innerText.includes('Intercompany'));if(!b)return false;b.click();return 'clicked'})()"""
DLG = r"""(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/Intercompany expense allocation/.test(x.innerText));return d?'open':false})()"""
DLG_STATE = r"""(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/Intercompany expense allocation/.test(x.innerText));if(!d)return JSON.stringify({nodialog:true});const al=[...d.querySelectorAll('button')].filter(b=>b.innerText.trim()==='Allocate').length;return JSON.stringify({allocateButtons:al,err:/Required info/.test(d.innerText)})})()"""
ROW_ALLOC = r"""(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/Intercompany expense allocation/.test(x.innerText));const b=[...d.querySelectorAll('button')].find(b=>b.innerText.trim()==='Allocate');if(!b)return false;b.click();return 'clicked'})()"""
PANEL = r"""(()=>{const i=document.querySelector('input[aria-label="Select companies to allocate to"]');return i?'panel':false})()"""
PANEL_SAVE = r"""(()=>{const ds=[...document.querySelectorAll('[role=dialog]')];const p=ds[ds.length-1];const i=document.querySelector('input[aria-label="Select companies to allocate to"]');const val=i?i.value:'?';const s=[...p.querySelectorAll('button')].find(b=>b.innerText.trim()==='Save');if(!s)return 'nosave';s.click();return 'saved:'+val})()"""
CAT_VALS = r"""JSON.stringify([...document.querySelectorAll('[role=dialog] input[aria-label="Select an item category"]')].map(i=>i.value))"""
FOCUS_EMPTY_CAT = r"""(()=>{const i=[...document.querySelectorAll('[role=dialog] input[aria-label="Select an item category"]')].find(x=>!x.value);if(!i)return false;i.scrollIntoView();i.focus();i.click();return 'focused'})()"""
OPTIONS = r"""JSON.stringify([...document.querySelectorAll('[role=option]')].map(e=>e.innerText.replace(/\s+/g,' ').trim().slice(0,90)))"""
DISMISS = r"""(()=>{let n=0;for(const b of document.querySelectorAll('button')){const t=(b.getAttribute('aria-label')||'');const pop=b.closest('[role=dialog],[role=tooltip],[class*=popover],[class*=Popover]');if(/close/i.test(t)&&pop&&/Allocate by|Customize dimensions/.test(pop.innerText)){b.click();n++}}return 'closed '+n})()"""
DLG_SAVE = r"""(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/Intercompany expense allocation/.test(x.innerText));const s=[...d.querySelectorAll('button')].filter(b=>b.innerText.trim()==='Save').pop();if(!s)return 'nosave';s.click();return 'dialog-save'})()"""
DONE = r"""(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='View allocation');const err=[...document.querySelectorAll('[role=dialog]')].find(x=>/Required info is missing/.test(x.innerText));return b?'VIEW_ALLOCATION':(err?'ERR':false)})()"""


def setup(tab_id, tool):
    global _T, _TAB
    _T, _TAB = tool, tab_id


def load_rows(key, include_conflicts=False):
    rows = json.loads(LINES_JSON.read_text(encoding='utf-8'))
    return [r for r in rows if r['key'] == key and (include_conflicts or 'mentions' not in r['conflict'])]


async def acts(a):
    return await _T.mcp__claude_in_chrome_browser_batch({"actions": a})


async def js(code):
    r = await acts([{"name": "javascript_tool", "input": {"tabId": _TAB, "action": "javascript_exec", "text": code}}])
    m = re.findall(r'javascript_exec\] (.*)', r['text'])
    return m[0] if m else r['text'][:200]


async def poll(cond_js, timeout=40, every=2):
    for _ in range(int(timeout / every)):
        try:
            v = await js(cond_js)
            if v and v not in ('false', 'null', 'undefined', '{}', ''):
                return v
        except Exception:
            pass
        await asyncio.sleep(every)
    return None


async def click_xy(x, y, wait=2):
    await acts([{"name": "computer", "input": {"tabId": _TAB, "action": "left_click", "coordinate": [x, y]}},
                {"name": "computer", "input": {"tabId": _TAB, "action": "wait", "duration": wait}}])


async def select_company(company):
    """Open the panel's company list, tick `company`, close the list by a click on the panel body, Save.
    Stepwise on purpose: a Promise-returning javascript_exec comes back as '{}' from the extension."""
    opened = await js(r"""(()=>{const i=document.querySelector('input[aria-label="Select companies to allocate to"]');if(!i)return false;i.focus();i.click();return 'opened'})()""")
    if opened != 'opened':
        return 'no-input'
    await asyncio.sleep(1.5)
    ticked = await js(r"""((co)=>{const o=[...document.querySelectorAll('[role=option]')].find(e=>e.innerText&&e.innerText.trim()===co);if(!o)return 'no-option';o.click();return 'ticked'})""" + f"({json.dumps(company)})")
    if ticked != 'ticked':
        return ticked
    await asyncio.sleep(0.8)
    await click_xy(1390, 580)  # blank panel area (right-side panel); commits the pick
    return await js(PANEL_SAVE)


SCROLL_EMPTY_CAT = r"""(()=>{const i=[...document.querySelectorAll('[role=dialog] input[aria-label="Select an item category"]')].find(x=>!x.value);if(!i)return false;i.scrollIntoView({block:'center'});return 'ok'})()"""
RECT_EMPTY_CAT = r"""(()=>{const i=[...document.querySelectorAll('[role=dialog] input[aria-label="Select an item category"]')].find(x=>!x.value);if(!i)return false;const r=i.getBoundingClientRect();return JSON.stringify([r.x+r.width/2,r.y+r.height/2,window.innerWidth,window.innerHeight])})()"""


async def screenshot_scale():
    """Screenshot coordinates are scaled from the CSS viewport; derive the factor once per run."""
    r = await acts([{"name": "computer", "input": {"tabId": _TAB, "action": "screenshot"}}])
    m = re.search(r'\((\d+)x(\d+)', r['text'])
    w, h = (int(m.group(1)), int(m.group(2))) if m else (1568, 698)
    vw, vh = json.loads(await js("JSON.stringify([window.innerWidth, window.innerHeight])"))
    return w / vw, h / vh

async def jsj(code, default, tries=3):
    """js() + json.loads; the extension occasionally answers with an error/timeout string, so retry."""
    for _ in range(tries):
        v = await js(code)
        try:
            return json.loads(v)
        except (json.JSONDecodeError, TypeError):
            await asyncio.sleep(2)
    return default



GROUP_OF_EMPTY_CAT = r"""(()=>{const i=[...document.querySelectorAll('[role=dialog] input[aria-label="Select an item category"]')].find(x=>!x.value);if(!i)return false;let r=i.closest('[role=row]');while(r&&(r=r.previousElementSibling)){if(r.getAttribute('role')==='row'&&!r.querySelector('input[aria-label="Select an item category"]'))return r.innerText.replace(/\s+/g,' ').trim().slice(0,120)}return '?'})()"""


ROWCHECK = r"""(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/Intercompany expense allocation/.test(x.innerText));const rows=[...d.querySelectorAll('[role=row]')];const out=[];let hdr='';for(const r of rows){const i=r.querySelector('input[aria-label="Select an item category"]');if(i){const amt=(r.innerText.match(/\$[\d,]+\.\d\d/)||[''])[0];out.push([hdr.slice(0,80),i.value.slice(0,60),amt])}else{hdr=r.innerText.replace(/\s+/g,' ').trim()}}return JSON.stringify(out)})()"""


async def fill_categories(lines, scale):
    """Ensure each target sub-row has a category. QBO groups the purchase lines BY ACCOUNT (one dialog row per
    distinct account, sorted by name), so for each empty input read its group header, map the account name
    to the number from lines.json, real-click the input (JS focus does not open the combobox), type the
    NUMBER (the picker searches numbers, not names), take the option that starts with it."""
    vals = await jsj(CAT_VALS, [])
    if vals and all(vals):
        return vals
    by_name = {}
    for l in lines:
        if l['cls'].startswith('Allocate - '):
            by_name[l['account'].split(':')[-1].strip()] = l['acctNum']
    if not all(by_name.values()):
        return ['NO-ACCTNUM in lines.json (re-run _probe-may-alloc-lines.ts)']
    sx, sy = scale
    # "empty" = no committed category; a half-typed value with no selection must count as empty too.
    rect_js = r"""(()=>{const i=[...document.querySelectorAll('[role=dialog] input[aria-label="Select an item category"]')].find(x=>!/^\d{4}\.\d{2} /.test(x.value));if(!i)return false;const r=i.getBoundingClientRect();return JSON.stringify([r.x+r.width/2,r.y+r.height/2,i.value])})()"""
    scroll_js = r"""(()=>{const i=[...document.querySelectorAll('[role=dialog] input[aria-label="Select an item category"]')].find(x=>!/^\d{4}\.\d{2} /.test(x.value));if(!i)return false;i.scrollIntoView({block:'center'});return 'ok'})()"""
    for _ in range(16):  # one pass per empty category input (one dialog row per purchase line)
        if await js(DISMISS) != 'closed 0':
            await asyncio.sleep(2)  # let the popover finish closing before any click
        if await js(scroll_js) != 'ok':
            break
        header = await js(GROUP_OF_EMPTY_CAT)
        num = next((n for leaf, n in by_name.items() if leaf and leaf in str(header)), None)
        if not num:
            return [f'NO-ACCTNUM for group "{header}"']
        picked = 'no-option'
        for attempt in range(5):  # the first click after a panel save can land while the table re-renders
            await asyncio.sleep(1.5)
            rect = await js(rect_js)
            if not rect or rect == 'false':
                break
            x, y, current = json.loads(rect)
            await click_xy(round(x * sx), round(y * sy), 2)
            focused = await js(r"""(()=>{const a=document.activeElement;return a&&a.getAttribute('aria-label')==='Select an item category'&&!/^\d{4}\.\d{2} /.test(a.value)?'focused':'not-focused'})()""")
            if focused != 'focused':
                continue
            keys = ([{"name": "computer", "input": {"tabId": _TAB, "action": "key", "text": "ctrl+a"}},
                     {"name": "computer", "input": {"tabId": _TAB, "action": "key", "text": "Delete"}}] if current else [])
            await acts(keys + [{"name": "computer", "input": {"tabId": _TAB, "action": "type", "text": num}},
                               {"name": "computer", "input": {"tabId": _TAB, "action": "wait", "duration": 3}}])
            picked = await js(r"""((num)=>{const o=[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.replace(/\s+/g,' ').trim().startsWith(num+' ')&&!/Add new/.test(e.innerText));if(!o)return 'no-option';o.click();return 'picked'})""" + f"({json.dumps(num)})")
            if picked == 'picked':
                break
        if picked != 'picked':
            return [f'NO-OPTION for {num}']
        await asyncio.sleep(1)
    return await jsj(CAT_VALS, [])


async def allocate_one(row, scale=(1568 / 1920, 698 / 855)):
    """Returns a status string; 'OK' when the expense shows 'View allocation' afterwards."""
    id_, company = row['id'], CO[row['target']]
    await acts([{"name": "navigate", "input": {"tabId": _TAB, "url": f"https://qbo.intuit.com/app/expense?txnId={id_}"}}])
    if not await poll(PAYEE, 60):
        return 'LOAD-TIMEOUT'
    await asyncio.sleep(3)
    if await js(ALREADY) == 'VIEW_ALLOCATION':
        return 'ALREADY-ALLOCATED'
    if await js(CLICK_FOOTER_ALLOC) != 'clicked':
        return 'NO-ALLOCATE-BUTTON'
    if not await poll(DLG, 30):
        return 'NO-DIALOG'
    await asyncio.sleep(2)
    for _ in range(12):  # one pass per category row
        st = await jsj(DLG_STATE, {'allocateButtons': -1})
        if st.get('allocateButtons', -1) == -1:
            return 'DIALOG-STATE-UNREADABLE'
        if st['allocateButtons'] == 0:
            break
        if await js(ROW_ALLOC) != 'clicked':
            return 'ROW-ALLOCATE-FAILED'
        if not await poll(PANEL, 20):
            return 'NO-PANEL'
        await asyncio.sleep(1)
        v = await select_company(company)
        if not str(v).startswith('saved:' + company):
            return f'COMPANY-PICK-FAILED:{v}'
        await asyncio.sleep(2)
    cats = await fill_categories(row['lines'], scale)
    if not cats or not all(cats) or any(str(c).startswith('NO-') for c in cats):
        return f'CATEGORY-FAILED:{cats}'
    # guard: each target sub-row's category must be the account of ITS OWN group header (same number),
    # and the multiset of numbers must equal the source lines' numbers.
    by_name = {l['account'].split(':')[-1].strip(): l['acctNum'] for l in row['lines'] if l['cls'].startswith('Allocate - ')}
    rowcheck = await jsj(ROWCHECK, [])
    if len(rowcheck) != len(cats):
        return f'CATEGORY-ROWCHECK-FAILED:{rowcheck}'
    for header, value, _amt in rowcheck:
        want = next((n for leaf, n in by_name.items() if leaf and leaf in header), None)
        if not want or not str(value).startswith(want + ' '):
            return f'CATEGORY-MISMATCH: row "{header[:50]}" has "{value}" want {want}'
    if sorted(str(c)[:7] for c in cats) != sorted(l['acctNum'] for l in row['lines'] if l['cls'].startswith('Allocate - ')):
        return f'CATEGORY-MULTISET-MISMATCH:{cats}'
    await js(DISMISS)
    for attempt in range(2):  # QBO sometimes answers "Hmm, something went wrong. Try saving the allocation again."
        if await js(DLG_SAVE) != 'dialog-save':
            return 'NO-DIALOG-SAVE'
        v = await poll(DONE, 150)  # a save can sit on "Processing... You can continue while we save this entry"
        if v == 'VIEW_ALLOCATION':
            return 'OK'
        if await js(r"""(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='Back to Expenses');if(!b)return false;b.click();return 'back'})()""") == 'back':
            return 'OK-PROCESSING'  # verified by the API batch check; expense list shown instead of the form
        if not await js(r"""(()=>{const d=[...document.querySelectorAll('[role=dialog]')].find(x=>/something went wrong/i.test(x.innerText));return d?'retry':false})()""") == 'retry':
            return f'SAVE-RESULT:{v}'
    return 'SAVE-RESULT:retry-failed'


def verify_api(rows):
    """Read-only API check via _probe-may-alloc-status.ts verify: each purchase must show a source JE and a
    target JE dated the purchase date, with Due From/To = the directed amount. Returns list of problems."""
    import subprocess
    ids = ','.join(f"{r['key']}:{r['id']}" for r in rows)
    p = subprocess.run(['npx', 'tsx', 'scripts/_probe-may-alloc-status.ts', 'verify', f'--ids={ids}'],
                       cwd=str(LINES_JSON.parents[3] / 'web'), capture_output=True, text=True, shell=True)
    out = p.stdout
    problems = []
    for r in rows:
        m = re.search(rf"^{r['key']} Purchase {r['id']} .*?(?=^\w\w Purchase |\Z)", out, re.S | re.M)
        block = m.group(0) if m else ''
        if 'NO BTS PAIR' in block or not block:
            problems.append(f"{r['key']}:{r['id']} no pair"); continue
        src = re.search(rf"^   {r['key']} JE (\d+) date (\S+) .*? due ([\d.]+)", block, re.M)
        tgt = re.search(rf"^   {r['target']} JE (\d+) date (\S+) .*? due ([\d.]+)", block, re.M)
        for name, je in (('source', src), ('target', tgt)):
            if not je:
                problems.append(f"{r['key']}:{r['id']} missing {name} JE"); continue
            if je.group(2) != r['date']:
                problems.append(f"{r['key']}:{r['id']} {name} JE {je.group(1)} dated {je.group(2)} != {r['date']}")
            if abs(float(je.group(3)) - r['amt']) > 0.005:
                problems.append(f"{r['key']}:{r['id']} {name} JE {je.group(1)} due {je.group(3)} != {r['amt']:.2f}")
        leaves = {l['account'].split(':')[-1].strip() for l in r['lines'] if l['cls'].startswith('Allocate - ')}
        for leaf in leaves:
            if block.count(leaf) < 2:
                problems.append(f"{r['key']}:{r['id']} account '{leaf}' not mirrored on both JEs")
    return problems


async def run(rows, verify_every=10, log=print):
    """Allocate each row in order; stop on the first UI failure; every `verify_every` rows (and at the end)
    verify the batch from the API and stop on any mismatch."""
    done, batch = [], []
    scale = await screenshot_scale()
    for i, r in enumerate(rows, 1):
        st = await allocate_one(r, scale)
        log(f"{i}/{len(rows)} {r['key']} {r['id']} {r['date']} {r['amt']:.2f} {r['payee'][:24]} -> {r['target']}: {st}")
        if st not in ('OK', 'OK-PROCESSING', 'ALREADY-ALLOCATED'):
            log('STOPPED. Inspect the browser, then resume with run(rows[i-1:]).')
            break
        done.append(r['id']); batch.append(r)
        if len(batch) >= verify_every:
            problems = verify_api(batch)
            log(f"API verify {len(batch)} rows: {'OK' if not problems else problems}")
            if problems:
                return done
            batch = []
    if batch:
        problems = verify_api(batch)
        log(f"API verify {len(batch)} rows: {'OK' if not problems else problems}")
    return done
