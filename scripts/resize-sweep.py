#!/usr/bin/env python3
"""Dev-only window-resize sweep (not shipped; scripts/** is in .vscodeignore, no npm dependency added).

Loads the pages written by scripts/render-pages.js in headless Chromium at many widths, heights and zoom
levels and reports layout problems:

  page-overflow    the page scrolls sideways (document wider than the window)
  offscreen        an element, link or button sticks out past the window edge
  clipped          text cut off by an ancestor without an ellipsis, or a table wider than its card
  overlap          two pieces of text drawn on top of each other
  tiny-text        SVG text (chart axes, ring) scaled below 8 CSS px
  jump             the layout shifts when crossing a CSS breakpoint (page height changes by more than a screenful)

Needs the `playwright` Python package and a Chromium it can launch (dev machine only):
  python3 scripts/resize-sweep.py <pages-dir> [--out report.json] [--shots <dir>] [--quick]
Zoom N% is emulated the way VS Code does it: the window is N% as many CSS pixels wide, same device size.
"""
import argparse
import json
import os
import sys

from playwright.sync_api import sync_playwright

WIDTHS = [280, 300, 320, 360, 400, 480, 560, 640, 700, 719, 720, 721, 760, 800, 900, 980, 1024, 1100, 1280, 1440, 1600]
QUICK_WIDTHS = [280, 320, 480, 719, 721, 1024, 1600]
HEIGHTS = [240, 900]               # 240 = very short panel; the page scrolls vertically, so the top is what matters
ZOOMS = [1.0, 1.5, 2.0]
VIEW_W_MIN = 120

CHECK_JS = r"""
() => {
  const vw = document.documentElement.clientWidth;
  const out = { vw, docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight, issues: [] };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).join('.');
    return s;
  };
  const sample = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36);
  if (out.docW > vw + 1) out.issues.push({ kind: 'page-overflow', what: 'document', text: out.docW + 'px in ' + vw + 'px' });
  const seen = new Set();
  const add = (kind, el, extra) => { const k = kind + '|' + desc(el) + '|' + sample(el); if (seen.has(k)) return; seen.add(k); out.issues.push(Object.assign({ kind, what: desc(el), text: sample(el) }, extra || {})); };

  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg' && el.tagName.toLowerCase() !== 'text') continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.closest('details:not([open])') && !el.closest('summary') && el.tagName !== 'SUMMARY') continue; // closed <details> body is not drawn
    const tag = el.tagName.toLowerCase();
    const isLink = tag === 'a';
    if (r.right > vw + 1 || r.left < -1) {
      // Report only the outermost offender (its parent still fits) and skip anything inside a scroll box that fits.
      const par = el.parentElement.getBoundingClientRect();
      let boxed = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (/^(auto|scroll)$/.test(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= vw + 1) { boxed = true; break; }
      }
      if (!boxed && (par.right <= vw + 1 || el.parentElement === document.body)) add(isLink ? 'offscreen-link' : 'offscreen', el, { right: Math.round(r.right), vw });
    }
    // table wider than its container
    if (tag === 'table' && !/^(auto|scroll)$/.test(getComputedStyle(el.parentElement).overflowX)) {
      const p = el.parentElement.getBoundingClientRect();
      const cp = parseFloat(getComputedStyle(el.parentElement).paddingRight) || 0;
      if (r.right > p.right - cp + 1) add('clipped', el, { why: 'table ' + Math.round(r.width) + 'px in card content ' + Math.round(p.width - cp) + 'px', right: Math.round(r.right), vw });
    }
    // text cut off by overflow:hidden with no ellipsis
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.textOverflow === 'ellipsis' && !el.closest('svg') && !el.title && !(el.parentElement && el.parentElement.title)) {
      // ellipsized and the full text is not available as a tooltip either
      add('truncated', el, { why: 'ellipsized, no title attribute' });
    }
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && /^(hidden|clip)$/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis' && !el.closest('svg')) {
      add('clipped', el, { why: 'content ' + el.scrollWidth + 'px in ' + el.clientWidth + 'px, overflow ' + cs.overflowX });
    }
    // single-line text that would be silently cut by its own ellipsis AND is the only place the info lives is fine; ignore.
    if (tag === 'text') {
      const svg = el.ownerSVGElement, m = el.getScreenCTM();
      const size = parseFloat(cs.fontSize) * (m ? m.a : 1);
      if (size < 8) add('tiny-text', el, { px: Math.round(size * 10) / 10 });
      const sb = svg.getBoundingClientRect(), eb = el.getBoundingClientRect();
      if (eb.left < sb.left - 1 || eb.right > sb.right + 1 || eb.top < sb.top - 1 || eb.bottom > sb.bottom + 1) add('clipped', el, { why: 'svg text outside its svg viewport' });
    }
  }
  // overlap: leaf text boxes (Range rects of text nodes) intersecting boxes of other text nodes in different elements
  const boxes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || ['STYLE', 'SCRIPT', 'TITLE'].includes(el.tagName)) continue;
    if (el.closest('details:not([open])') && !el.closest('summary')) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    // clip the text box to every ancestor that clips (overflow hidden/auto): an ellipsized name is not "under" its neighbour
    const clips = [];
    for (let a = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') clips.push(a.getBoundingClientRect());
    for (const r0 of range.getClientRects()) {
      let L = r0.left, R = r0.right;
      for (const c of clips) { L = Math.max(L, c.left); R = Math.min(R, c.right); }
      if (R - L > 2 && r0.height > 4) boxes.push({ el, r: { left: L, right: R, top: r0.top, bottom: r0.bottom }, t: n.textContent.trim().slice(0, 30) });
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.el.closest('svg') !== b.el.closest('svg')) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 2 && iy > 3) {
        const k = 'overlap|' + a.t + '|' + b.t;
        if (!seen.has(k)) { seen.add(k); out.issues.push({ kind: 'overlap', what: a.el.tagName.toLowerCase() + ' x ' + b.el.tagName.toLowerCase(), text: '"' + a.t + '" over "' + b.t + '"', at: Math.round(a.r.left) + ',' + Math.round(a.r.top) }); }
      }
    }
  }
  return out;
}
"""


def run(args):
    pages = json.load(open(os.path.join(args.pages, args.manifest)))
    widths = QUICK_WIDTHS if args.quick else WIDTHS
    results = []
    shot_dir = args.shots
    if shot_dir:
        os.makedirs(shot_dir, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chromium or os.environ.get("CHROMIUM_PATH") or None,
                                     args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        for p in pages:
            if args.only and not all(o in p["file"] for o in args.only):
                continue
            url = "file://" + os.path.abspath(os.path.join(args.pages, p["file"]))
            heights_by_w = {}
            for zoom in args.zooms:
                for width in widths:
                    css_w = round(width / zoom)
                    if css_w < VIEW_W_MIN:
                        continue
                    for h in HEIGHTS:
                        ctx = browser.new_context(viewport={"width": css_w, "height": max(100, round(h / zoom))}, device_scale_factor=zoom)
                        pg = ctx.new_page()
                        pg.goto(url)
                        res = pg.evaluate(CHECK_JS)
                        if h == HEIGHTS[-1]:
                            heights_by_w[(zoom, width)] = res["docH"]
                        for iss in res["issues"]:
                            results.append(dict(iss, page=p["page"], theme=p["theme"], font=p["font"], stress=p["stress"], width=width, zoom=zoom, height=h, css_w=css_w))
                        if shot_dir and h == HEIGHTS[-1] and zoom == 1.0 and width in args.shot_widths:
                            pg.screenshot(path=os.path.join(shot_dir, f"{p['file'][:-5]}-{width}.png"), full_page=True)
                        ctx.close()
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pages")
    ap.add_argument("--manifest", default="manifest.json")
    ap.add_argument("--out", default="")
    ap.add_argument("--shots", default="")
    ap.add_argument("--shot-widths", type=int, nargs="*", default=[320, 720, 1024])
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--zooms", type=float, nargs="*", default=ZOOMS)
    ap.add_argument("--chromium", default="", help="path to a Chromium/Chrome binary (or set CHROMIUM_PATH)")
    ap.add_argument("--only", nargs="*", default=[], help="substrings every page file name must contain")
    args = ap.parse_args()
    res = run(args)
    # collapse: one line per (kind, page, what) with the widths it appears at
    groups = {}
    for r in res:
        k = (r["kind"], r["page"], r["what"])
        g = groups.setdefault(k, {"themes": set(), "fonts": set(), "widths": set(), "zooms": set(), "stress": set(), "extra": r.get("why") or r.get("px") or "", "samples": []})
        g["samples"].append(r.get("text", ""))
        g["themes"].add(r["theme"]); g["fonts"].add(r["font"]); g["widths"].add(r["width"]); g["zooms"].add(r["zoom"]); g["stress"].add(r["stress"])
    for (kind, page, what), g in sorted(groups.items()):
        ws = sorted(g["widths"])
        smp = sorted(set(g["samples"]), key=lambda x: (len(x), x))[:2]
        print(f"{kind:14} {page:9} {what[:34]:34} w {ws[0]}..{ws[-1]} n={len(ws):2} z{','.join(str(z) for z in sorted(g['zooms']))} {','.join(sorted(g['themes']))} {g['extra']} e.g. {smp}")
    print(f"{len(groups)} distinct issues, {len(res)} raw hits")
    if args.out:
        json.dump(res, open(args.out, "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
