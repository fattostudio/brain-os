/* ribbonEngine.js — generative ribbon-weave typography engine.
 *
 * Ported verbatim from the original standalone prototype. The drawing /
 * placement / animation logic is UNCHANGED; only the wiring to the DOM has
 * been parameterised so it can be mounted by a React component.
 *
 * Usage:
 *   import { createRibbonEngine } from './ribbonEngine';
 *   const engine = createRibbonEngine(svgElement, { word: 'fatto' });
 *   engine.start();              // queue letters + auto-play
 *   engine.handleResize();       // on container resize
 *   engine.destroy();            // stop timers, clean up
 *
 * The svgElement must contain three <g> groups with ids/refs that the engine
 * fills: ribbons, letterRibbons, markers. createRibbonEngine injects them.
 */
export function createRibbonEngine(svgEl, options) {
  options = options || {};
  const INITIAL_WORD = options.word || 'fatto';

  // ---- Build the internal SVG group structure the engine expects ----
  const svgNS = "http://www.w3.org/2000/svg";
  function ensureGroup(id) {
    let g = svgEl.querySelector('#' + id);
    if (!g) { g = document.createElementNS(svgNS, 'g'); g.setAttribute('id', id); svgEl.appendChild(g); }
    return g;
  }
  const ribbonsGroup = ensureGroup('ribbons');
  ensureGroup('letterRibbons');
  const markersGroup = ensureGroup('markers');

  // ---- Stat sinks ----
  // The engine writes ribbon count / attempts / status / errors by setting
  // `.textContent` on these. Instead of a control panel, we expose the values
  // through an onStats callback so a React sidebar (or nothing) can read them.
  const _stats = { count: '0', attempts: '0', status: 'ready', error: '' };
  let _statsTimer = null, _statsDirty = false;
  const _emitStats = () => {
    if (typeof options.onStats !== 'function') return;
    _statsDirty = true;
    if (_statsTimer) return;
    // coalesce bursts (the play loop touches stats many times per second)
    _statsTimer = setTimeout(() => {
      _statsTimer = null;
      if (_statsDirty) { _statsDirty = false; options.onStats({ ..._stats }); }
    }, 90);
  };
  function makeStatSink(key) {
    return {
      get textContent() { return _stats[key]; },
      set textContent(v) { _stats[key] = String(v); _emitStats(); },
      disabled: false,
    };
  }
  const countEl = makeStatSink('count');
  const attemptsEl = makeStatSink('attempts');
  const statusEl = makeStatSink('status');
  const errorEl = makeStatSink('error');

  // ---- timer handle exposed for teardown ----
  let _playIntervalRef = null;


// ---- Viewport / canvas sizing ----
// Reads the actual rendered SVG dimensions and updates the logical canvas
// size (CANVAS_W/H), the SVG viewBox, the TARGET_ELLIPSE (centered, scaled
// to fit), and ZONE_MAX (canvas bounds with a small margin). Called once
// at startup and again on every window resize.
function setViewport() {
  const rect = svgEl.getBoundingClientRect();
  const pxW = Math.max(1, rect.width || 1000);
  const pxH = Math.max(1, rect.height || 1000);
  const aspect = pxH / pxW;

  // IMPORTANT (mobile fix): the woven (non-letter) ribbons use FIXED widths in
  // canvas units (~17-21), while letters scale with CANVAS_W. If we let
  // CANVAS_W shrink to a phone's ~390px, the letters scale down but the ribbons
  // don't — so the ribbons look twice as thick as the letters. To keep the
  // letter:ribbon proportion identical at every screen size, we anchor the
  // logical canvas WIDTH to a constant and derive height from the real aspect
  // ratio. preserveAspectRatio (set on the <svg>) then zooms the whole weave to
  // fit the screen, scaling letters and ribbons together.
  const LOGICAL_W = 1000;
  CANVAS_W = LOGICAL_W;
  CANVAS_H = Math.max(400, Math.round(LOGICAL_W * aspect));

  // Update the SVG viewBox to the logical canvas. With preserveAspectRatio
  // the browser scales these coords to the real pixel box.
  svgEl.setAttribute('viewBox', '0 0 ' + CANVAS_W + ' ' + CANVAS_H);

  // Target ellipse centered on the canvas. Sized to a comfortable text
  // area — narrower than the canvas, so growth has room around the letters.
  TARGET_ELLIPSE = {
    cx: CANVAS_W / 2,
    cy: CANVAS_H / 2,
    rx: CANVAS_W * 0.36,
    ry: CANVAS_H * 0.24,
  };

  // Zone-expansion bounds: pretty much the whole canvas, with a small
  // edge margin so ribbons aren't clipped right at the edge.
  const MARGIN = 30;
  ZONE_MAX = {
    minX: MARGIN,
    minY: MARGIN,
    maxX: CANVAS_W - MARGIN,
    maxY: CANVAS_H - MARGIN,
  };
}

// ---- Math ----
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function qbPoint(t, a, c, b) {
  const mt = 1 - t;
  return { x: mt*mt*a.x + 2*mt*t*c.x + t*t*b.x, y: mt*mt*a.y + 2*mt*t*c.y + t*t*b.y };
}
function qbTangent(t, a, c, b) {
  const mt = 1 - t;
  return { x: 2*mt*(c.x - a.x) + 2*t*(b.x - c.x), y: 2*mt*(c.y - a.y) + 2*t*(b.y - c.y) };
}
function normalize(v) {
  const L = Math.hypot(v.x, v.y) || 1;
  return { x: v.x/L, y: v.y/L };
}

// ---- Ribbon construction ----
function makeRibbon(cx, cy, angle, length, bend, width) {
  const w = width / 2;
  const half = length / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const toWorld = p => ({
    x: cx + p.x * cos - p.y * sin,
    y: cy + p.x * sin + p.y * cos,
  });
  const A = toWorld({ x: -half, y: 0 });
  const B = toWorld({ x:  half, y: 0 });
  const C = toWorld({ x: 0, y: 2 * bend });

  // Sample the quadratic bezier at a few interior anchor positions, then
  // perpendicularly displace each by a small random offset (like the letters'
  // multi-anchor wiggle). Endpoints stay anchored.
  // Build the SAMPLES centerline by Catmull-Rom interpolation through the
  // wiggled anchors, then derive edges from the wiggled centerline.
  const NUM_INTERIOR_ANCHORS = 3;     // 3 interior anchors + A and B = 5 total
  const ANCHOR_OFFSET_MAX = Math.min(width * 0.22, length * 0.05, 3);
  const anchors = [{ x: A.x, y: A.y }];
  for (let i = 1; i <= NUM_INTERIOR_ANCHORS; i++) {
    const t = i / (NUM_INTERIOR_ANCHORS + 1);
    const P = qbPoint(t, A, C, B);
    const T = normalize(qbTangent(t, A, C, B));
    const N = { x: -T.y, y: T.x };
    const r = (typeof rand === 'function' ? rand() : Math.random());
    const offset = (r - 0.5) * 2 * ANCHOR_OFFSET_MAX;
    anchors.push({ x: P.x + N.x * offset, y: P.y + N.y * offset });
  }
  anchors.push({ x: B.x, y: B.y });

  // Catmull-Rom segment evaluation through the anchors (same math as
  // makeMultiRibbon). Sample to produce a smooth centerline.
  const SAMPLES = 20;
  const centerline = crSampleClosed(anchors, SAMPLES);

  // Compute edges from the centerline using central differences for the tangent.
  const topEdge = [];
  const botEdge = [];
  for (let i = 0; i < centerline.length; i++) {
    let T;
    if (i === 0) {
      const dx = centerline[1].x - centerline[0].x;
      const dy = centerline[1].y - centerline[0].y;
      T = normalize({ x: dx, y: dy });
    } else if (i === centerline.length - 1) {
      const dx = centerline[i].x - centerline[i - 1].x;
      const dy = centerline[i].y - centerline[i - 1].y;
      T = normalize({ x: dx, y: dy });
    } else {
      const dx = centerline[i + 1].x - centerline[i - 1].x;
      const dy = centerline[i + 1].y - centerline[i - 1].y;
      T = normalize({ x: dx, y: dy });
    }
    const N = { x: -T.y, y: T.x };
    const P = centerline[i];
    topEdge.push({ x: P.x + N.x * w, y: P.y + N.y * w });
    botEdge.push({ x: P.x - N.x * w, y: P.y - N.y * w });
  }

  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const p of topEdge) {
    if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
    if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
  }
  for (const p of botEdge) {
    if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
    if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
  }
  return { A, B, centerline, topEdge, botEdge, w, width,
           bbox:{minX,minY,maxX,maxY} };
}

// Catmull-Rom sampling helper used by both makeRibbon and makeTrimmedRibbon
// to interpolate through scattered anchors. Returns SAMPLES+1 evenly-spaced
// points along the curve through `pts`.
function crSampleClosed(pts, samplesTotal) {
  if (pts.length < 2) return pts.slice();
  if (pts.length === 2) {
    // Just a straight line — cheap path
    const out = [];
    for (let i = 0; i <= samplesTotal; i++) {
      const t = i / samplesTotal;
      out.push({
        x: pts[0].x + (pts[1].x - pts[0].x) * t,
        y: pts[0].y + (pts[1].y - pts[0].y) * t,
      });
    }
    return out;
  }
  function crPt(t, p0, p1, p2, p3) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  }
  const segs = pts.length - 1;
  const samplesPerSeg = Math.max(2, Math.ceil(samplesTotal / segs));
  const out = [];
  for (let i = 0; i < segs; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const isLast = (i === segs - 1);
    const samplesThis = isLast ? samplesPerSeg + 1 : samplesPerSeg;
    for (let s = 0; s < samplesThis; s++) {
      const tt = s / samplesPerSeg;
      out.push(crPt(tt, p0, p1, p2, p3));
    }
  }
  return out;
}

// Build a ribbon that follows a smooth curve through a sequence of anchor
// points (multi-bend). Returns the SAME object shape as makeRibbon so all
// downstream code (rendering, trimming, constraints) works unchanged.
//
// Uses centripetal Catmull-Rom interpolation between consecutive anchors,
// which passes through every anchor point (unlike plain quadratic bezier
// where the control point is off-curve).
//
// `points` is an array of [x, y] arrays — at least 2 required.
// `width` is the ribbon width in canvas units.
function makeMultiRibbon(points, width) {
  if (points.length < 2) {
    throw new Error('makeMultiRibbon needs at least 2 points');
  }
  const w = width / 2;
  const pts = points.map(p => ({ x: p[0], y: p[1] }));

  // Catmull-Rom segment evaluation (tension = 0.5)
  function crPoint(t, p0, p1, p2, p3) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  }
  function crTangent(t, p0, p1, p2, p3) {
    const t2 = t * t;
    return {
      x: 0.5 * ((-p0.x + p2.x) +
                2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t +
                3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t2),
      y: 0.5 * ((-p0.y + p2.y) +
                2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t +
                3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t2),
    };
  }

  const SAMPLES_PER_SEG = 22;
  const centerline = [];
  const topEdge = [];
  const botEdge = [];

  const N = pts.length;
  for (let i = 0; i < N - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(N - 1, i + 2)];

    // For all but the last segment, skip the t=1 sample to avoid duplicating
    // the next segment's t=0 sample.
    const isLast = (i === N - 2);
    const samplesThis = isLast ? SAMPLES_PER_SEG + 1 : SAMPLES_PER_SEG;

    for (let s = 0; s < samplesThis; s++) {
      const t = s / SAMPLES_PER_SEG;
      const P = crPoint(t, p0, p1, p2, p3);
      const T = normalize(crTangent(t, p0, p1, p2, p3));
      const Nv = { x: -T.y, y: T.x };
      centerline.push(P);
      topEdge.push({ x: P.x + Nv.x * w, y: P.y + Nv.y * w });
      botEdge.push({ x: P.x - Nv.x * w, y: P.y - Nv.y * w });
    }
  }

  const A = centerline[0];
  const B = centerline[centerline.length - 1];

  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const p of topEdge) {
    if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
    if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
  }
  for (const p of botEdge) {
    if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
    if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
  }

  return { A, B, centerline, topEdge, botEdge, w, width,
           bbox:{minX,minY,maxX,maxY},
           multiRibbon: true };
}

// Build SVG path: two parallel edges drawn separately, no closing caps.
// This gives clean "cut off" ends when ribbons are trimmed at crossings,
// and the round corners from stroke-linecap="round" soften them slightly.
// We draw the ribbon as TWO shapes: a filled paper region between the edges,
// plus the two edge strokes. The filled region is the interior of the
// ribbon (the "paper showing through"), and the edges are the black lines.
function ribbonToPaths(r) {
  const { topEdge, botEdge } = r;
  // 1) The fill path: top edge forward, bot edge reverse, closed without caps
  const fillParts = [];
  fillParts.push('M ' + topEdge[0].x.toFixed(2) + ' ' + topEdge[0].y.toFixed(2));
  for (let i = 1; i < topEdge.length; i++) {
    fillParts.push('L ' + topEdge[i].x.toFixed(2) + ' ' + topEdge[i].y.toFixed(2));
  }
  for (let i = botEdge.length - 1; i >= 0; i--) {
    fillParts.push('L ' + botEdge[i].x.toFixed(2) + ' ' + botEdge[i].y.toFixed(2));
  }
  fillParts.push('Z');
  const fill = fillParts.join(' ');

  // 2) The top edge stroke only (no fill)
  const topParts = [];
  topParts.push('M ' + topEdge[0].x.toFixed(2) + ' ' + topEdge[0].y.toFixed(2));
  for (let i = 1; i < topEdge.length; i++) {
    topParts.push('L ' + topEdge[i].x.toFixed(2) + ' ' + topEdge[i].y.toFixed(2));
  }
  // 3) The bottom edge stroke only
  const botParts = [];
  botParts.push('M ' + botEdge[0].x.toFixed(2) + ' ' + botEdge[0].y.toFixed(2));
  for (let i = 1; i < botEdge.length; i++) {
    botParts.push('L ' + botEdge[i].x.toFixed(2) + ' ' + botEdge[i].y.toFixed(2));
  }

  return {
    fill: fill,
    top: topParts.join(' '),
    bot: botParts.join(' '),
  };
}

// Is point inside ribbon body (within w of centerline)?
function pointInsideRibbon(point, ribbon) {
  const t2 = ribbon.w * ribbon.w;
  const cl = ribbon.centerline;
  for (let i = 0; i < cl.length; i++) {
    const dx = cl[i].x - point.x;
    const dy = cl[i].y - point.y;
    if (dx*dx + dy*dy < t2) return true;
  }
  return false;
}

// Is point inside the MIDDLE 70% of the ribbon (not near its ends)?
function pointInsideRibbonMiddle(point, ribbon) {
  const cl = ribbon.centerline;
  const N = cl.length;
  const pad = 0.15;
  const iStart = Math.floor(N * pad);
  const iEnd = N - iStart;
  const t2 = ribbon.w * ribbon.w;
  for (let i = iStart; i < iEnd; i++) {
    const dx = cl[i].x - point.x;
    const dy = cl[i].y - point.y;
    if (dx*dx + dy*dy < t2) return true;
  }
  return false;
}

// Segment-segment intersection
function segIntersect(p1, p2, p3, p4) {
  const s1x = p2.x - p1.x, s1y = p2.y - p1.y;
  const s2x = p4.x - p3.x, s2y = p4.y - p3.y;
  const denom = -s2x * s1y + s1x * s2y;
  if (Math.abs(denom) < 1e-9) return null;
  const s = (-s1y * (p1.x - p3.x) + s1x * (p1.y - p3.y)) / denom;
  const t = ( s2x * (p1.y - p3.y) - s2y * (p1.x - p3.x)) / denom;
  if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
    return { x: p1.x + t * s1x, y: p1.y + t * s1y };
  }
  return null;
}

function countCrossings(rA, rB) {
  if (rA.bbox.maxX < rB.bbox.minX || rB.bbox.maxX < rA.bbox.minX ||
      rA.bbox.maxY < rB.bbox.minY || rB.bbox.maxY < rA.bbox.minY) return 0;
  const clA = rA.centerline, clB = rB.centerline;
  const hits = [];
  for (let i = 0; i < clA.length - 1; i++) {
    for (let j = 0; j < clB.length - 1; j++) {
      const hit = segIntersect(clA[i], clA[i+1], clB[j], clB[j+1]);
      if (hit) hits.push(hit);
    }
  }
  // Dedup near-duplicate hits
  const uniq = [];
  for (const h of hits) {
    let dup = false;
    for (const u of uniq) {
      if (Math.hypot(h.x - u.x, h.y - u.y) < 8) { dup = true; break; }
    }
    if (!dup) uniq.push(h);
  }
  return uniq.length;
}

function overlapSamples(candidate, other) {
  let inside = 0;
  const cl = candidate.centerline;
  const threshold = other.w + candidate.w * 0.3;
  const t2 = threshold * threshold;
  const clO = other.centerline;
  for (let i = 0; i < cl.length; i++) {
    for (let j = 0; j < clO.length; j++) {
      const dx = clO[j].x - cl[i].x;
      const dy = clO[j].y - cl[i].y;
      if (dx*dx + dy*dy < t2) { inside++; break; }
    }
  }
  return inside;
}

// Measure how much of a candidate's centerline runs CLOSE to another ribbon
// IN ONE CONTINUOUS STRETCH, without crossing it. Returns the LONGEST
// consecutive run of close samples.
//
// Why longest-run, not total count:
//   - Crossing one ribbon produces ~1 close sample. Run = 1.
//   - Burying an end in a ribbon produces ~2-3 close samples clustered at
//     one end of the candidate. Run = 2-3.
//   - Running parallel produces 6+ samples in an unbroken stretch. Run = 6+.
//   A bridge with a crossing AND two end-burials has total ~5-7 close
//   samples but three separate runs of 1-3 each. Measured by LONGEST run,
//   it reads as 3 (end-burial). Measured by total, it reads as 7 (parallel-like).
//   Longest-run is the right invariant.
function parallelRun(candidate, other, closeDist) {
  const crosses = countCrossings(candidate, other);
  if (crosses > 0) return 0;   // they actually cross; not parallel
  const t2 = closeDist * closeDist;
  const cl = candidate.centerline;
  const clO = other.centerline;
  let longest = 0;
  let current = 0;
  for (let i = 0; i < cl.length; i++) {
    let close = false;
    for (let j = 0; j < clO.length; j++) {
      const dx = clO[j].x - cl[i].x;
      const dy = clO[j].y - cl[i].y;
      if (dx*dx + dy*dy < t2) { close = true; break; }
    }
    if (close) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

// Same idea for pile-up: measure the LONGEST consecutive run of samples
// that sit deep inside another ribbon's body. Individual crossings have
// run=1-2. Two ribbons actually overlapping ("pile-up") have a long
// continuous run of deep-inside samples.
function pileUpRun(candidate, other) {
  const t2 = (other.w + candidate.w * 0.3) * (other.w + candidate.w * 0.3);
  const cl = candidate.centerline;
  const clO = other.centerline;
  let longest = 0;
  let current = 0;
  for (let i = 0; i < cl.length; i++) {
    let inside = false;
    for (let j = 0; j < clO.length; j++) {
      const dx = clO[j].x - cl[i].x;
      const dy = clO[j].y - cl[i].y;
      if (dx*dx + dy*dy < t2) { inside = true; break; }
    }
    if (inside) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}




// -----------------------------------------------------------------------------
// TYPOGRAPHY ENGINE — letters as the seed of the weave
// -----------------------------------------------------------------------------
// Each letter's stencil is a list of stroke targets (line segments) in
// letter-box coordinates. We turn each target directly into a real ribbon
// via makeRibbon(), flagged as letterFill: true so it renders black.
//
// These letter ribbons are placed FIRST in the ribbons array. The generative
// algorithm then runs, with letter ribbon endpoints as open-cap targets.
// White ribbons grow out from the letters and tuck into them — same way the
// normal algorithm grows from a seed.
//
// Render order = placement order, so letter ribbons appear at the bottom.
// White ribbons drawn later can pass over them, partially hiding parts of
// the letters — exactly the woven feel of the user's hand drawing.

const LETTER_BOX_W = 100;
const LETTER_BOX_H = 140;
const LETTER_RIBBON_WIDTH = 22;   // standard width inside letter shapes

// Stencils: each letter is a list of STROKES.
// Each stroke is an array of [x, y] anchor points in letter-box coords.
// A stroke with 2 points is a straight ribbon; 3+ points is a smooth curve
// passing through all of them. This lets letters be expressive with few
// strokes (max 5 per letter, 3 for lowercase).
const LETTER_STENCILS = {
  // ============================================================
  //  UPPERCASE — simple geometric strokes (mostly 2-3 anchors)
  //  Letter-box: 100×140; top y≈8, mid y≈70, baseline y≈132
  // ============================================================
  'A': [
    [[12, 132], [50, 8]],
    [[50, 8],   [88, 132]],
    [[26, 90],  [74, 90]],
  ],
  'B': [
    [[18, 8],   [18, 132]],                                    // stem
    [[18, 14],  [56, 18],  [78, 38],  [76, 60],  [56, 70], [18, 72]],   // top bowl
    [[18, 70],  [60, 74],  [82, 96],  [80, 118], [56, 128], [18, 130]], // bottom bowl
  ],
  'C': [
    [[88, 30],  [60, 12],  [30, 18],  [14, 50],  [12, 90],  [28, 122], [60, 130], [88, 112]],
  ],
  'D': [
    [[18, 8],   [18, 132]],
    [[18, 14],  [60, 18],  [86, 70],  [60, 124], [18, 130]],
  ],
  'E': [
    [[18, 8],   [18, 132]],            // stem
    [[18, 14],  [86, 14]],             // top bar
    [[18, 70],  [70, 70]],             // mid bar
    [[18, 130], [86, 130]],            // bottom bar
  ],
  'F': [
    [[18, 8],   [18, 132]],
    [[18, 14],  [84, 14]],
    [[18, 70],  [68, 70]],
  ],
  'G': [
    [[88, 30],  [60, 12],  [30, 18],  [14, 50],  [12, 90],  [28, 122], [60, 130], [86, 116]],
    [[86, 116], [86, 80],  [60, 80]],   // hook with horizontal
  ],
  'H': [
    [[18, 8],   [18, 132]],
    [[82, 8],   [82, 132]],
    [[18, 70],  [82, 70]],
  ],
  'I': [
    [[50, 8],   [50, 132]],
  ],
  'J': [
    [[70, 8],   [70, 110], [60, 128], [40, 132], [22, 122]],
  ],
  'K': [
    [[18, 8],   [18, 132]],            // stem
    [[18, 70],  [82, 8]],              // upper diagonal
    [[18, 70],  [82, 132]],            // lower diagonal
  ],
  'L': [
    [[18, 8],   [18, 132]],
    [[18, 130], [86, 130]],
  ],
  'M': [
    [[14, 132], [14, 8]],              // left stem
    [[14, 8],   [50, 90]],              // left diagonal down
    [[50, 90],  [86, 8]],              // right diagonal up
    [[86, 8],   [86, 132]],            // right stem
  ],
  'N': [
    [[18, 132], [18, 8]],
    [[18, 8],   [82, 132]],
    [[82, 132], [82, 8]],
  ],
  'O': [
    [[10, 70],  [50, 12],  [90, 70]],
    [[90, 70],  [50, 128], [10, 70]],
  ],
  'P': [
    [[18, 8],   [18, 132]],
    [[18, 14],  [56, 18],  [78, 38],  [76, 60],  [56, 70], [18, 72]],
  ],
  'Q': [
    [[10, 70],  [50, 12],  [90, 70]],
    [[90, 70],  [50, 128], [10, 70]],
    [[60, 100], [92, 138]],            // tail
  ],
  'R': [
    [[18, 8],   [18, 132]],
    [[18, 14],  [56, 18],  [78, 38],  [76, 60],  [56, 70], [18, 72]],   // bowl
    [[42, 72],  [86, 132]],            // leg
  ],
  'S': [
    [[85, 30],  [50, 14],  [18, 38]],
    [[25, 60],  [50, 70],  [78, 86]],
    [[82, 110], [50, 128], [18, 110]],
  ],
  'T': [
    [[10, 14],  [90, 14]],
    [[50, 14],  [50, 132]],
  ],
  'U': [
    [[12, 14],  [12, 90],  [50, 128], [88, 90], [88, 14]],
  ],
  'V': [
    [[10, 8],   [50, 132]],
    [[50, 132], [90, 8]],
  ],
  'W': [
    [[8, 8],    [25, 132]],
    [[25, 132], [50, 50]],
    [[50, 50],  [75, 132]],
    [[75, 132], [92, 8]],
  ],
  'X': [
    [[12, 8],   [88, 132]],
    [[88, 8],   [12, 132]],
  ],
  'Y': [
    [[12, 8],   [50, 70]],
    [[88, 8],   [50, 70]],
    [[50, 70],  [50, 132]],
  ],
  'Z': [
    [[14, 14],  [86, 14]],
    [[86, 14],  [14, 130]],
    [[14, 130], [86, 130]],
  ],
  ' ': [],

  // ============================================================
  //  LOWERCASE — flowing multi-anchor designs with curls/tails
  //  Vertical zones in letter-box:
  //    ascender top:  y ≈ 8
  //    x-height top:  y ≈ 60
  //    baseline:      y ≈ 132
  //    descender bot: y ≈ 158
  // ============================================================
  'a': [
    [[78, 80],  [60, 68],  [35, 72],  [20, 92],  [22, 116], [40, 130], [65, 128], [78, 116]],
    [[58, 32],  [72, 38],  [80, 60],  [78, 116], [82, 132], [96, 142], [110, 144]],
  ],
  'b': [
    // ascender stem flowing into bowl, with left-curl serif at the bottom
    [[20, 8],   [20, 70],  [20, 132], [18, 140], [10, 144], [4, 138]],
    // bowl: starts from upper stem, curls around right, comes back to lower stem
    [[20, 70],  [50, 64],  [78, 80],  [82, 100], [70, 124], [42, 132], [20, 128]],
  ],
  'c': [
    [[80, 76],  [56, 64],  [30, 72],  [16, 96],  [22, 122], [48, 134], [78, 124]],
  ],
  'd': [
    // bowl: closed shape on the left
    [[78, 70],  [56, 64],  [32, 72],  [18, 92],  [22, 118], [42, 132], [68, 128]],
    // ascender stem on right with right-curl serif at the bottom
    [[78, 8],   [78, 80],  [78, 132], [80, 140], [88, 144], [94, 138]],
  ],
  'e': [
    // horizontal mid-bar opens up into the bowl curve
    [[18, 96],  [80, 96]],
    [[80, 96],  [82, 76],  [62, 64],  [38, 66],  [20, 84],  [16, 110], [32, 130], [62, 132], [82, 116]],
  ],
  'f': [
    [[68, 18],  [50, 6],   [30, 12],  [22, 32],  [30, 60],  [40, 100], [40, 140], [32, 156], [12, 154], [4, 142]],
    [[8, 60],   [40, 66],  [82, 60]],
  ],
  'g': [
    // bowl
    [[78, 70],  [56, 64],  [32, 72],  [18, 92],  [22, 118], [42, 130], [68, 126]],
    // descender flowing down, curling left, terminating in a chunky blob
    [[78, 64],  [78, 132], [76, 150], [56, 158], [32, 154], [18, 144], [16, 138]],
  ],
  'h': [
    // ascender stem with left-curl serif
    [[20, 8],   [20, 132], [18, 140], [10, 144], [4, 138]],
    // arch + right stem (no serif on right stem to match the asymmetric look)
    [[20, 78],  [42, 64],  [68, 66],  [80, 84],  [80, 132]],
  ],
  'i': [
    // x-height stem with left-curl serif at the bottom
    [[50, 70],  [50, 132], [48, 140], [40, 144], [34, 138]],
    [[48, 38],  [52, 38],  [52, 50],  [48, 50],  [48, 38]],   // dot
  ],
  'j': [
    // descender curling left, ending in chunky blob
    [[58, 70],  [58, 132], [56, 152], [38, 158], [18, 150], [12, 142]],
    [[56, 38],  [60, 38],  [60, 50],  [56, 50],  [56, 38]],   // dot
  ],
  'k': [
    // stem with left-curl serif
    [[20, 8],   [20, 132], [18, 140], [10, 144], [4, 138]],
    [[20, 100], [78, 64]],              // upper diagonal
    [[40, 88],  [80, 132]],            // lower diagonal
  ],
  'l': [
    // ascender with left-curl serif (was a tiny flick — now full serif)
    [[50, 8],   [50, 132], [48, 140], [40, 144], [34, 138]],
  ],
  'm': [
    // first stem with TOP-LEFT curl serif coming up out of the stem top
    [[14, 132], [14, 70],  [12, 60],  [4, 56],   [0, 64]],
    [[14, 78],  [30, 64],  [44, 70],  [46, 132]],     // first arch
    [[46, 78],  [62, 64],  [76, 70],  [78, 132]],     // second arch
  ],
  'n': [
    // left stem with TOP-LEFT curl serif
    [[20, 132], [20, 70],  [18, 60],  [10, 56],  [4, 64]],
    [[20, 78],  [38, 64],  [62, 66],  [78, 82],  [78, 132]],
  ],
  'o': [
    [[40, 60],  [56, 80],  [82, 80],  [96, 60]],
    [[26, 80],  [12, 100], [22, 124], [50, 134], [76, 128], [90, 108], [86, 96]],
  ],
  'p': [
    // descender stem with left-curl blob at the bottom
    [[18, 70],  [18, 132], [18, 158], [12, 162], [4, 158]],
    [[18, 70],  [50, 64],  [78, 78],  [82, 98],  [70, 122], [42, 132], [18, 128]],
  ],
  'q': [
    [[78, 70],  [56, 64],  [32, 72],  [18, 92],  [22, 118], [42, 130], [68, 126]],   // bowl
    // right descender with right-curl blob
    [[78, 64],  [78, 132], [82, 152], [92, 158], [98, 152]],
  ],
  'r': [
    // stem with TOP-LEFT curl serif (stem starts at x-height like m/n)
    [[20, 132], [20, 70],  [18, 60],  [10, 56],  [4, 64]],
    [[20, 80],  [38, 66],  [60, 64],  [80, 74]],   // small arch top
  ],
  's': [
    [[78, 78],  [50, 64],  [22, 78],  [40, 96],  [62, 108], [80, 122], [56, 134], [22, 124]],
  ],
  't': [
    [[50, 22],  [50, 60],  [50, 105], [56, 128], [72, 132], [86, 122]],
    [[14, 60],  [50, 66],  [86, 60]],
  ],
  'u': [
    [[18, 64],  [18, 110], [32, 130], [56, 132], [76, 122]],   // U curve
    // right stem with no serif — the U curve already has natural left-flow
    [[78, 64],  [78, 132]],
  ],
  'v': [
    [[12, 64],  [50, 132]],
    [[50, 132], [88, 64]],
  ],
  'w': [
    [[8, 64],   [22, 132]],
    [[22, 132], [42, 80]],
    [[42, 80],  [58, 132]],
    [[58, 132], [78, 64]],
  ],
  'x': [
    [[14, 64],  [86, 132]],
    [[86, 64],  [14, 132]],
  ],
  'y': [
    [[14, 64],  [44, 110]],
    // right diagonal continues into long descender curling left, blob terminal
    [[86, 64],  [44, 110], [30, 150], [14, 156], [6, 150]],
  ],
  'z': [
    [[16, 64],  [84, 64]],
    [[84, 64],  [16, 132]],
    [[16, 132], [84, 132]],
  ],

  // ============================================================
  //  DIGITS — top y≈8, baseline y≈132 (uppercase scale)
  // ============================================================
  '0': [
    [[10, 70],  [50, 12],  [90, 70]],
    [[90, 70],  [50, 128], [10, 70]],
  ],
  '1': [
    [[30, 28],  [50, 14]],              // serif/flick at the top
    [[50, 14],  [50, 132]],
    [[28, 132], [72, 132]],            // base line
  ],
  '2': [
    [[16, 30],  [40, 14],  [70, 16],  [82, 38],  [76, 62],  [40, 96],  [16, 122], [16, 132]],
    [[16, 132], [86, 132]],
  ],
  '3': [
    [[16, 28],  [40, 14],  [70, 18],  [80, 38],  [70, 60],  [44, 70]],
    [[44, 70],  [70, 80],  [82, 100], [72, 124], [44, 132], [16, 122]],
  ],
  '4': [
    [[68, 8],   [12, 96],  [88, 96]],
    [[68, 8],   [68, 132]],
  ],
  '5': [
    [[80, 14],  [22, 14]],
    [[22, 14],  [22, 64]],
    [[22, 64],  [50, 60],  [76, 70],  [84, 96],  [76, 122], [44, 132], [16, 122]],
  ],
  '6': [
    [[78, 24],  [50, 14],  [28, 30],  [16, 60],  [14, 96],  [22, 122], [50, 132], [76, 124], [84, 100], [76, 78], [50, 70], [22, 80]],
  ],
  '7': [
    [[14, 14],  [86, 14]],
    [[86, 14],  [40, 132]],
  ],
  '8': [
    // top loop
    [[50, 14],  [76, 22],  [76, 50],  [50, 64],  [24, 50],  [24, 22],  [50, 14]],
    // bottom loop
    [[50, 64],  [80, 80],  [82, 110], [56, 132], [24, 124], [16, 100], [22, 78], [50, 64]],
  ],
  '9': [
    [[80, 50],  [70, 22],  [42, 14],  [22, 28],  [16, 50],  [26, 70],  [54, 72],  [80, 60]],
    [[80, 50],  [80, 100], [70, 124], [44, 132], [22, 124]],
  ],

  // ============================================================
  //  PUNCTUATION
  // ============================================================
  '.': [
    [[48, 126], [52, 126], [52, 132], [48, 132], [48, 126]],
  ],
  ',': [
    [[48, 122], [52, 122], [52, 132], [48, 142], [40, 148]],
  ],
  '!': [
    [[50, 8],   [50, 100]],
    [[48, 122], [52, 122], [52, 132], [48, 132], [48, 122]],
  ],
  '?': [
    [[16, 30],  [40, 14],  [70, 16],  [82, 38],  [76, 60],  [50, 76],  [50, 100]],
    [[48, 122], [52, 122], [52, 132], [48, 132], [48, 122]],
  ],
  '-': [
    [[20, 70],  [80, 70]],
  ],
};

let currentText = '';

function measureTextWidth(text, letterSpacing) {
  if (text.length === 0) return 0;
  return text.length * LETTER_BOX_W + (text.length - 1) * letterSpacing;
}

// Convert a stroke target (line segment) into ribbon construction parameters.
// Returns { cx, cy, angle, length, bend, width } ready to feed into makeRibbon.
//
// If explicitBend is provided (in letter-box coords, positive or negative),
// it's used directly (scaled by scale). Otherwise we apply a tiny random
// bend to keep letter ribbons looking organic but mostly straight.
function strokeTargetToRibbonParams(ax, ay, bx, by, scale, explicitBend) {
  const dx = bx - ax, dy = by - ay;
  const length = Math.hypot(dx, dy);
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const angle = Math.atan2(dy, dx);
  let bend;
  if (explicitBend !== undefined && explicitBend !== null) {
    bend = explicitBend * scale;
  } else {
    bend = (length * 0.06) * (Math.random() < 0.5 ? -1 : 1);
  }
  const width = LETTER_RIBBON_WIDTH * scale;
  return { cx, cy, angle, length, bend, width };
}

// Place letter ribbons into the ribbons array. Each is a real ribbon flagged
// letterFill: true so render() draws it black. Endpoints are added to
// openCaps so the generative algorithm grows from them.
// Queue of letter ribbons waiting to be placed during play. Each entry is
// { ribbon, openCapsToAdd }. When play runs, we pop one per tick and push
// it into the ribbons array — same animation as white ribbons.
let pendingLetterRibbons = [];

// Bounding box around the letters, inflated with padding. While the play
// phase is 'zone', new ribbons must fit entirely inside this box. After
// the algorithm saturates inside it, the zone gradually expands outward
// (each plateau grows it by EXPAND_STEP on each side) producing a softly
// oval-shaped composition that hugs the canvas.
let letterZone = null;

// How much to grow the zone outward each time fill plateaus (in pixels per side).
const EXPAND_STEP = 150;

// Hard outer limit for zone expansion (canvas bounds, with a small margin
// so ribbons aren't clipped at the very edge).
// Hard outer limit for zone expansion (canvas bounds, with a small margin
// so ribbons aren't clipped at the very edge). Updated by setViewport()
// whenever the window resizes.
let ZONE_MAX = { minX: 30, minY: 30, maxX: 970, maxY: 970 };

// Counter for fill-phase plateau detection. After enough consecutive ticks
// where fill operations add little or nothing, we expand the zone.
let fillPlateauTicks = 0;
const FILL_PLATEAU_THRESHOLD = 6;

// Hard cap on TOTAL ticks in fill phase, regardless of whether placements
// are still being found. Without this, the algorithm can grind interior
// gaps indefinitely (fillGaps + coverOpenCaps keep finding marginal spots,
// resetting the plateau counter forever). Once this cap is hit, force
// expansion to outward territory.
let fillTotalTicks = 0;
const MAX_FILL_TICKS = 25;

// Throttle for fillStubbornGaps in final cleanup — it does an expensive
// global grid scan, so we only run it once per STUBBORN_COOLDOWN_MAX ticks
// of pure plateau. After STUBBORN_FAILURE_THRESHOLD consecutive failed
// attempts, we declare the composition complete.
let stubbornCooldown = 0;
let stubbornFailures = 0;
const STUBBORN_COOLDOWN_MAX = 10;
const STUBBORN_FAILURE_THRESHOLD = 3;

// Track previous zone size after each expansion — if expanding produces
// no new placements, we know we're truly done.
let lastExpandRibbonCount = 0;

// Track number of times the zone has been expanded. After the first few
// careful fill cycles, we switch to a faster mode: zone-saturation triggers
// expansion immediately, skipping the interior fill plateau dance. This
// makes the algorithm charge outward quickly once the central area looks
// good.
let expansionCycles = 0;
const FILL_BEFORE_EXPAND_CYCLES = 1;     // first N cycles: thorough fill before expand

// Counter inside zone phase — every N additions, we slip in a fill-gaps tick
// to densify (mirrors the manual "add 10 → fill gaps" workflow).
let zoneAddsSinceFill = 0;
const ZONE_ADDS_PER_FILL = 6;

// Play phase state machine. Drives the play loop's behavior:
//   'idle'    — not playing
//   'letters' — draining pendingLetterRibbons (animating each letter ribbon)
//   'zone'    — addRibbon restricted to letterZone; runs until N consecutive
//               failures (saturation)
//   'fill'    — fill-gaps + cover-open-caps passes inside letter zone
//               to densify
//   'free'    — constraint released; addRibbon can grow anywhere
//   'done'    — play has ended (no more placements possible)
let playPhase = 'idle';
let consecutiveZoneFailures = 0;
const ZONE_SATURATION_THRESHOLD = 4;    // consecutive fails before phase change

// Returns true if the candidate is rejected by the active letter-zone
// constraint (i.e., extends outside the zone). Active during 'zone',
// 'fill', and 'expand' phases — the same rectangular zone is shared
// across these phases (it just grows during expand).
function violatesLetterZone(cand) {
  if (!letterZone) return false;
  if (playPhase !== 'zone' && playPhase !== 'fill' && playPhase !== 'expand') return false;
  return (
    cand.bbox.minX < letterZone.minX || cand.bbox.maxX > letterZone.maxX ||
    cand.bbox.minY < letterZone.minY || cand.bbox.maxY > letterZone.maxY
  );
}

// Combined zone check used by all candidate-validation sites.
function violatesActiveZone(cand) {
  return violatesLetterZone(cand);
}

// Expand the rectangular zone outward by EXPAND_STEP on each side, capped
// at the canvas-edge limits. Returns true if the zone actually grew, false
// if it was already at the limit on all sides.
function expandLetterZone() {
  if (!letterZone) return false;
  const before = { ...letterZone };
  letterZone = {
    minX: Math.max(ZONE_MAX.minX, letterZone.minX - EXPAND_STEP),
    minY: Math.max(ZONE_MAX.minY, letterZone.minY - EXPAND_STEP),
    maxX: Math.min(ZONE_MAX.maxX, letterZone.maxX + EXPAND_STEP),
    maxY: Math.min(ZONE_MAX.maxY, letterZone.maxY + EXPAND_STEP),
  };
  return (
    letterZone.minX !== before.minX ||
    letterZone.minY !== before.minY ||
    letterZone.maxX !== before.maxX ||
    letterZone.maxY !== before.maxY
  );
}

// Compute the bounding box around all letter ribbons, padded outward.
// Returns null if there are no letter ribbons (so no zone is enforced).
function computeLetterZone(padding) {
  padding = padding === undefined ? 100 : padding;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  // Include both already-placed letter ribbons and pending ones
  function consume(r) {
    if (!r.letterFill) return;
    if (r.bbox.minX < minX) minX = r.bbox.minX;
    if (r.bbox.minY < minY) minY = r.bbox.minY;
    if (r.bbox.maxX > maxX) maxX = r.bbox.maxX;
    if (r.bbox.maxY > maxY) maxY = r.bbox.maxY;
    any = true;
  }
  for (const r of ribbons) consume(r);
  for (const r of pendingLetterRibbons) consume(r);
  if (!any) return null;
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

function placeLetterRibbons() {
  if (!currentText || currentText.trim().length === 0) return;

  const text = currentText.trim();
  const LETTER_SPACING = 18;
  // Target the text width to most of the canvas width (with margin)
  const TARGET_WIDTH = Math.min(CANVAS_W * 0.78, 1400);

  const unscaledW = measureTextWidth(text, LETTER_SPACING);
  const scale = Math.min(2.0, TARGET_WIDTH / unscaledW);
  const wordWidth = unscaledW * scale;
  const startX = TARGET_ELLIPSE.cx - wordWidth / 2;
  const startY = TARGET_ELLIPSE.cy - (LETTER_BOX_H * scale) / 2;

  let cursorX = startX;
  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci];
    const stencil = LETTER_STENCILS[ch];
    if (!stencil) {
      cursorX += (LETTER_BOX_W + LETTER_SPACING) * scale;
      continue;
    }

    // PER-LETTER RANDOMNESS — small variations per letter so the word looks
    // hand-drawn instead of mechanically centered.
    //   - Horizontal jitter: slightly tighter or looser spacing
    //   - Vertical jitter: letter sits a bit higher or lower
    //   - Rotation: letter tilts slightly left or right
    //   - Scale: letter is slightly bigger or smaller
    // PER-LETTER RANDOMNESS — bigger variations so each generation looks
    // genuinely different, not just nudged from the same template.
    const xJitter = (rand() - 0.5) * 50 * scale;          // ±25 px
    const yJitter = (rand() - 0.5) * 40 * scale;          // ±20 px
    const letterRotation = (rand() - 0.5) * 0.5;          // ±14°
    // Independent X and Y scales so letters can be wider/narrower or
    // taller/shorter, not just bigger/smaller as a unit.
    const letterScaleX = scale * (0.78 + rand() * 0.40);  // 78%-118%
    const letterScaleY = scale * (0.82 + rand() * 0.36);  // 82%-118%
    // Width-ratio scale (used for ribbon width — we want ribbon thickness
    // tied to the smaller of the two so they don't get too thin or fat).
    const letterScale = Math.min(letterScaleX, letterScaleY);

    // Letter center — used as rotation pivot
    const letterCx = cursorX + (LETTER_BOX_W * scale) / 2 + xJitter;
    const letterCy = startY + (LETTER_BOX_H * scale) / 2 + yJitter;
    const cosR = Math.cos(letterRotation);
    const sinR = Math.sin(letterRotation);

    // Helper: transform a letter-box point (x, y) to canvas coords with
    // the per-letter randomness applied (independent x/y scales).
    function transformPt(lx, ly) {
      // 1) Convert to letter-local coords centered on letter center
      const localX = (lx - LETTER_BOX_W / 2) * letterScaleX;
      const localY = (ly - LETTER_BOX_H / 2) * letterScaleY;
      // 2) Rotate
      const rx = localX * cosR - localY * sinR;
      const ry = localX * sinR + localY * cosR;
      // 3) Translate to canvas center
      return { x: letterCx + rx, y: letterCy + ry };
    }

    for (const stroke of stencil) {
      // Per-anchor jitter — small enough that strokes stay smooth (each
      // ribbon still reads as a clean curve, not a snake), but large enough
      // that each generation produces a noticeably different letter shape.
      const STROKE_POS_JITTER = 3;     // letter-box units
      const transformedPts = stroke.map(([sx, sy]) => {
        const jx = sx + (rand() - 0.5) * STROKE_POS_JITTER;
        const jy = sy + (rand() - 0.5) * STROKE_POS_JITTER;
        const pt = transformPt(jx, jy);
        return [pt.x, pt.y];
      });

      const ribbonWidth = LETTER_RIBBON_WIDTH * letterScale;
      const fullRibbon = makeMultiRibbon(transformedPts, ribbonWidth);

      // Trim/cap detection: check both the existing ribbons array AND the
      // pending queue (since prior letter ribbons of the same word are queued
      // but not yet in ribbons[]). This way endpoints can detect they're
      // inside earlier letter ribbons of the same word.
      let startInside = false;
      for (const rr of ribbons) {
        if (pointInsideRibbon(fullRibbon.centerline[0], rr)) { startInside = true; break; }
      }
      if (!startInside) {
        for (const rr of pendingLetterRibbons) {
          if (pointInsideRibbon(fullRibbon.centerline[0], rr)) { startInside = true; break; }
        }
      }
      let endInside = false;
      const lastPt = fullRibbon.centerline[fullRibbon.centerline.length - 1];
      for (const rr of ribbons) {
        if (pointInsideRibbon(lastPt, rr)) { endInside = true; break; }
      }
      if (!endInside) {
        for (const rr of pendingLetterRibbons) {
          if (pointInsideRibbon(lastPt, rr)) { endInside = true; break; }
        }
      }

      // For multi-ribbons we don't have makeTrimmedRibbon — instead we can
      // simply skip trimming and accept the full ribbon. The white-stroke
      // styling on letter ribbons handles overlapping seams cleanly enough.
      const finalRibbon = fullRibbon;
      finalRibbon.letterFill = true;
      finalRibbon.letterIdx = ci;

      // Stash the cap-side flags so we can register caps WHEN the ribbon
      // is actually pushed into ribbons[] (during play, one at a time).
      finalRibbon._capA = !startInside;
      finalRibbon._capB = !endInside;

      pendingLetterRibbons.push(finalRibbon);
    }

    // Variable per-letter spacing (some letters sit closer/wider than others).
    // Use letterScaleX so a wider letter naturally consumes more horizontal space.
    const spacingJitter = (rand() - 0.5) * 24;         // ±12 letter-box units
    cursorX += LETTER_BOX_W * letterScaleX + (LETTER_SPACING + spacingJitter) * scale;
  }
}

// -----------------------------------------------------------------------------
// END TYPOGRAPHY ENGINE
// -----------------------------------------------------------------------------

// Per-letter crossing limit: max 1 white (non-letter) ribbon may cross any
// given letter. Returns true if the candidate is allowed under this rule.
//
// We define "crosses a letter" as: the candidate has at least one true
// crossing (countCrossings > 0) with any ribbon belonging to that letter.
// If a candidate would cross a letter that already has >=1 white ribbon
// crossing it, reject.
// Returns true if the candidate's body OVERLAPS the letter ribbon's body
// — either by crossing centerlines OR by one's body lying on top of the
// other without crossing (a ribbon ending on top of a letter, etc.).
// We use point-in-ribbon checks on each ribbon's centerline samples.
function ribbonsOverlap(rA, rB) {
  if (countCrossings(rA, rB) > 0) return true;
  // Sample a handful of centerline points and check if any sit inside
  // the other ribbon's body.
  const samplesA = rA.centerline;
  const samplesB = rB.centerline;
  // Step every few points to keep it cheap
  const STEP = 3;
  for (let i = 0; i < samplesA.length; i += STEP) {
    if (pointInsideRibbon(samplesA[i], rB)) return true;
  }
  for (let i = 0; i < samplesB.length; i += STEP) {
    if (pointInsideRibbon(samplesB[i], rA)) return true;
  }
  return false;
}

// Cache for per-letter overlap state. Stores a Set of letterIdx values
// that already have AT LEAST ONE overlapping white ribbon. We rebuild this
// cache lazily — invalidate when ribbons change, recompute on first read.
let _saturatedLettersCache = null;

// Cache for branch counts (number of other ribbons each ribbon crosses).
// O(N²) to build, used by addRibbon to score targets — caching avoids
// rebuilding it for every addRibbon call when ribbons haven't changed.
let _branchCountsCache = null;

function invalidateSaturatedLettersCache() {
  _saturatedLettersCache = null;
  _branchCountsCache = null;
}

function getBranchCounts() {
  if (_branchCountsCache !== null) return _branchCountsCache;
  const counts = new Array(ribbons.length).fill(0);
  for (let i = 0; i < ribbons.length; i++) {
    for (let j = i + 1; j < ribbons.length; j++) {
      if (countCrossings(ribbons[i], ribbons[j]) > 0) {
        counts[i]++;
        counts[j]++;
      }
    }
  }
  _branchCountsCache = counts;
  return counts;
}

function getSaturatedLetters() {
  if (_saturatedLettersCache !== null) return _saturatedLettersCache;
  const saturated = new Set();
  // First, collect letter ribbons by letterIdx for fast iteration
  const letterRibbonsByIdx = new Map();
  for (let lj = 0; lj < ribbons.length; lj++) {
    const lr = ribbons[lj];
    if (!lr.letterFill) continue;
    if (!letterRibbonsByIdx.has(lr.letterIdx)) letterRibbonsByIdx.set(lr.letterIdx, []);
    letterRibbonsByIdx.get(lr.letterIdx).push(lr);
  }
  // Now check each white ribbon against each letter group
  for (let ri = 0; ri < ribbons.length; ri++) {
    const r = ribbons[ri];
    if (r.letterFill) continue;
    for (const [letterIdx, lrs] of letterRibbonsByIdx) {
      if (saturated.has(letterIdx)) continue;     // already saturated
      for (const lr of lrs) {
        if (ribbonsOverlap(r, lr)) {
          saturated.add(letterIdx);
          break;
        }
      }
    }
  }
  _saturatedLettersCache = saturated;
  return saturated;
}

function passesLetterCrossingRule(cand) {
  const saturated = getSaturatedLetters();
  if (saturated.size === 0) return true;          // no letter is saturated yet
  // Check the candidate: would it overlap any currently-saturated letter?
  for (let lj = 0; lj < ribbons.length; lj++) {
    const lr = ribbons[lj];
    if (!lr.letterFill) continue;
    if (!saturated.has(lr.letterIdx)) continue;   // letter not at limit yet
    if (ribbonsOverlap(cand, lr)) return false;
  }
  return true;
}


// ---- State ----
const CENTER = { x: 500, y: 500 };
const R_FIELD = 400;

let ribbons = [];
let openCaps = [];       // { ribbonIdx, which, pt }
let seed = Math.floor(Math.random() * 100000);
let rand = mulberry32(seed);
let totalAttempts = 0;
let playInterval = null;
let showMarkers = false;

// ---- Render ----
// Draw order: oldest first (bottom), newest last (top). When a new ribbon is
// placed to cross over an existing open cap, the new ribbon paints ON TOP
// of that cap, covering it visually.
// Compute an approximate "length" for a polyline given as an array of points.
// Used to set stroke-dasharray/stroke-dashoffset for the draw-in animation.
function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
  }
  return total;
}

// Draw a single ribbon into the given SVG group. forceFill overrides the
// ribbon's letterFill flag (so we can render letter ribbons separately
// from the normal weave with consistent fill color).
// Build an SVG path 'd' string from a polyline of points.
function polylineToPathD(pts) {
  if (pts.length === 0) return '';
  const parts = ['M ' + pts[0].x.toFixed(2) + ' ' + pts[0].y.toFixed(2)];
  for (let i = 1; i < pts.length; i++) {
    parts.push('L ' + pts[i].x.toFixed(2) + ' ' + pts[i].y.toFixed(2));
  }
  return parts.join(' ');
}

function drawRibbonInto(group, ribbon, forceFill, shouldAnimate) {
  const paths = ribbonToPaths(ribbon);
  const isLetter = ribbon.letterFill === true;
  const strokeColor = isLetter ? 'var(--paper)' : 'var(--ink)';

  // Letter ribbons: always render the fill as a CENTERLINE STROKE (a wide
  // stroke along the centerline, same width as the ribbon, with rounded
  // caps). This keeps the visual consistent — letter ribbons have rounded
  // ends both during animation (dasharray draw-in) and after.
  // Non-letter ribbons keep the polygon fill.
  if (isLetter) {
    const centerPath = document.createElementNS(svgNS, 'path');
    centerPath.setAttribute('d', polylineToPathD(ribbon.centerline));
    centerPath.setAttribute('fill', 'none');
    centerPath.setAttribute('stroke', forceFill);
    centerPath.setAttribute('stroke-width', String(ribbon.width));
    centerPath.setAttribute('stroke-linecap', 'butt');     // square ends, no rounding
    centerPath.setAttribute('stroke-linejoin', 'round');
    if (shouldAnimate) {
      const cLen = polylineLength(ribbon.centerline);
      centerPath.setAttribute('class', 'ribbon-stroke-draw');
      centerPath.style.setProperty('--dash-len', cLen);
    }
    group.appendChild(centerPath);
  } else {
    const fillPath = document.createElementNS(svgNS, 'path');
    fillPath.setAttribute('d', paths.fill);
    fillPath.setAttribute('fill', forceFill);
    fillPath.setAttribute('stroke', 'none');
    if (shouldAnimate) {
      fillPath.setAttribute('class', 'ribbon-fill-fade');
    }
    group.appendChild(fillPath);
  }

  const topPath = document.createElementNS(svgNS, 'path');
  topPath.setAttribute('d', paths.top);
  topPath.setAttribute('fill', 'none');
  topPath.setAttribute('stroke', strokeColor);
  topPath.setAttribute('stroke-width', '2.4');
  topPath.setAttribute('stroke-linecap', 'round');
  topPath.setAttribute('stroke-linejoin', 'round');
  if (shouldAnimate) {
    const len = polylineLength(ribbon.topEdge);
    topPath.setAttribute('class', 'ribbon-stroke-draw');
    topPath.style.setProperty('--dash-len', len);
  }
  group.appendChild(topPath);

  const botPath = document.createElementNS(svgNS, 'path');
  botPath.setAttribute('d', paths.bot);
  botPath.setAttribute('fill', 'none');
  botPath.setAttribute('stroke', strokeColor);
  botPath.setAttribute('stroke-width', '2.4');
  botPath.setAttribute('stroke-linecap', 'round');
  botPath.setAttribute('stroke-linejoin', 'round');
  if (shouldAnimate) {
    const len = polylineLength(ribbon.botEdge);
    botPath.setAttribute('class', 'ribbon-stroke-draw');
    botPath.style.setProperty('--dash-len', len);
  }
  group.appendChild(botPath);
}

function render(opts) {
  opts = opts || {};
  const animateNewest = !!opts.animateNewest;
  const letterRibbonsGroup = document.getElementById('letterRibbons');
  ribbonsGroup.innerHTML = '';
  letterRibbonsGroup.innerHTML = '';
  markersGroup.innerHTML = '';

  // Walk ribbons in placement order. Letter ribbons (placed first) render
  // first/lowest; subsequent white ribbons can pass over them — exactly the
  // woven feel of the user's hand drawing.
  for (let i = 0; i < ribbons.length; i++) {
    const ribbon = ribbons[i];
    const isNewest = i === ribbons.length - 1;
    const shouldAnimate = animateNewest && isNewest;
    const fill = ribbon.letterFill ? 'var(--ink)' : 'var(--paper)';
    drawRibbonInto(ribbonsGroup, ribbon, fill, shouldAnimate);
  }

  // TYPOGRAPHY PREVIEW: ghost render of letter ribbons that are queued but
  // not yet placed. Shows the user what word will appear when they hit play.
  // Once each ribbon gets placed for real, its ghost disappears.
  // We render just the centerline stroke at full ribbon width — same shape
  // as the actual ribbon, but in preview color (no separate edges).
  for (const pending of pendingLetterRibbons) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', polylineToPathD(pending.centerline));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--preview)');
    path.setAttribute('stroke-width', String(pending.width));
    path.setAttribute('stroke-linecap', 'butt');
    path.setAttribute('stroke-linejoin', 'round');
    letterRibbonsGroup.appendChild(path);
  }

  if (showMarkers) {
    for (const cap of openCaps) {
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', cap.pt.x);
      dot.setAttribute('cy', cap.pt.y);
      dot.setAttribute('r', '5');
      dot.setAttribute('fill', '#d14');
      dot.setAttribute('opacity', '0.85');
      markersGroup.appendChild(dot);
    }
  }
  countEl.textContent = ribbons.length;
  attemptsEl.textContent = totalAttempts;
  const undoBtn = document.getElementById('undo');
  if (undoBtn) undoBtn.disabled = ribbons.length === 0;
}

// ---- Placement ----
// Build a TRIMMED ribbon: geometry from parameter t=tA to t=tB along the
// same quadratic Bezier the original ribbon was built from.
function makeTrimmedRibbon(cx, cy, angle, length, bend, width, tA, tB) {
  const w = width / 2;
  const half = length / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const toWorld = p => ({
    x: cx + p.x * cos - p.y * sin,
    y: cy + p.x * sin + p.y * cos,
  });
  const origA = toWorld({ x: -half, y: 0 });
  const origB = toWorld({ x:  half, y: 0 });
  const origC = toWorld({ x: 0, y: 2 * bend });

  // Build anchors along the trimmed arc with random perpendicular offsets,
  // then interpolate through them via Catmull-Rom — same approach as makeRibbon.
  const NUM_INTERIOR_ANCHORS = 3;
  const ANCHOR_OFFSET_MAX = Math.min(width * 0.22, length * 0.05, 3);
  const startPt = qbPoint(tA, origA, origC, origB);
  const endPt = qbPoint(tB, origA, origC, origB);
  const anchors = [{ x: startPt.x, y: startPt.y }];
  for (let i = 1; i <= NUM_INTERIOR_ANCHORS; i++) {
    const tLocal = i / (NUM_INTERIOR_ANCHORS + 1);
    const tGlobal = tA + (tB - tA) * tLocal;
    const P = qbPoint(tGlobal, origA, origC, origB);
    const T = normalize(qbTangent(tGlobal, origA, origC, origB));
    const N = { x: -T.y, y: T.x };
    const r = (typeof rand === 'function' ? rand() : Math.random());
    const offset = (r - 0.5) * 2 * ANCHOR_OFFSET_MAX;
    anchors.push({ x: P.x + N.x * offset, y: P.y + N.y * offset });
  }
  anchors.push({ x: endPt.x, y: endPt.y });

  const SAMPLES = 20;
  const centerline = crSampleClosed(anchors, SAMPLES);

  // Compute edges from the centerline using central differences for the tangent.
  const topEdge = [];
  const botEdge = [];
  for (let i = 0; i < centerline.length; i++) {
    let T;
    if (i === 0) {
      const dx = centerline[1].x - centerline[0].x;
      const dy = centerline[1].y - centerline[0].y;
      T = normalize({ x: dx, y: dy });
    } else if (i === centerline.length - 1) {
      const dx = centerline[i].x - centerline[i - 1].x;
      const dy = centerline[i].y - centerline[i - 1].y;
      T = normalize({ x: dx, y: dy });
    } else {
      const dx = centerline[i + 1].x - centerline[i - 1].x;
      const dy = centerline[i + 1].y - centerline[i - 1].y;
      T = normalize({ x: dx, y: dy });
    }
    const N = { x: -T.y, y: T.x };
    const P = centerline[i];
    topEdge.push({ x: P.x + N.x * w, y: P.y + N.y * w });
    botEdge.push({ x: P.x - N.x * w, y: P.y - N.y * w });
  }

  const A = { x: centerline[0].x, y: centerline[0].y };
  const B = { x: centerline[centerline.length - 1].x, y: centerline[centerline.length - 1].y };

  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const p of topEdge) {
    if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
    if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
  }
  for (const p of botEdge) {
    if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
    if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
  }

  return { A, B, centerline, topEdge, botEdge, w, width,
           bbox:{minX,minY,maxX,maxY} };
}

// For a candidate ribbon and a list of existing ribbons, find the parameters
// (along the candidate's centerline) at which the candidate's centerline
// ENTERS and EXITS the body of any existing ribbon. Returns a list of
// { t, kind: 'enter'|'exit', ribbon } events, sorted by t.
function findBodyBoundaries(candidate, existing) {
  const events = [];
  const cl = candidate.centerline;
  const N = cl.length;

  for (const r of existing) {
    // Sample the candidate's centerline; determine at each sample whether
    // it's inside r. Whenever we transition inside/outside, record the
    // event with its parameter t (index / (N-1)).
    const t2 = r.w * r.w;
    let prevInside = false;
    for (let i = 0; i < N; i++) {
      // Quick: is cl[i] within r.w of any centerline sample of r?
      let inside = false;
      const clR = r.centerline;
      for (let j = 0; j < clR.length; j++) {
        const dx = clR[j].x - cl[i].x;
        const dy = clR[j].y - cl[i].y;
        if (dx*dx + dy*dy < t2) { inside = true; break; }
      }
      if (i > 0 && inside !== prevInside) {
        // Transition at parameter ≈ (i - 0.5) / (N-1)
        const t = (i - 0.5) / (N - 1);
        events.push({ t, kind: inside ? 'enter' : 'exit', ribbon: r });
      }
      prevInside = inside;
    }
    // If the first sample was inside, the candidate "enters" at t=0
    // (strictly it's already inside). Record this so trim logic sees it.
    // Actually we only need transitions; the start state is handled below.
  }

  events.sort((a, b) => a.t - b.t);
  return events;
}

// Direction of a ribbon at a given open cap (A or B). Returns a unit vector
// pointing outward from the cap (away from the ribbon body).
function capOutwardDir(cap, ribbon) {
  const cl = ribbon.centerline;
  if (cap.which === 'A') {
    // Tangent at t=0 points from A toward B. Outward is -tangent.
    const t = { x: cl[1].x - cl[0].x, y: cl[1].y - cl[0].y };
    const n = normalize(t);
    return { x: -n.x, y: -n.y };
  } else {
    const last = cl.length - 1;
    const t = { x: cl[last].x - cl[last-1].x, y: cl[last].y - cl[last-1].y };
    return normalize(t);
  }
}

function placeFirstRibbon() {
  const angle = rand() * Math.PI * 2;
  const length = 90 + rand() * 40;
  const width = 17 + rand() * 4;
  const bendFrac = 0.35 + rand() * 0.25;
  const bendSign = rand() < 0.5 ? -1 : 1;
  const bend = (length / 2) * bendFrac * bendSign;
  const r = makeRibbon(CENTER.x, CENTER.y, angle, length, bend, width);
  ribbons.push(r);

  invalidateSaturatedLettersCache();
  openCaps.push({ ribbonIdx: 0, which: 'A', pt: { x: r.A.x, y: r.A.y } });
  openCaps.push({ ribbonIdx: 0, which: 'B', pt: { x: r.B.x, y: r.B.y } });
  totalAttempts += 1;
}

// (tryPlaceOverCap has been replaced by tryPlaceOverTarget, see below)

// Compute a "density score" around a point — how many ribbon centerline
// samples fall within a radius. Used to find sparse regions for placement.
function densityAt(pt, radius) {
  const r2 = radius * radius;
  let count = 0;
  for (const rr of ribbons) {
    // quick bbox reject
    if (pt.x < rr.bbox.minX - radius || pt.x > rr.bbox.maxX + radius ||
        pt.y < rr.bbox.minY - radius || pt.y > rr.bbox.maxY + radius) continue;
    for (const p of rr.centerline) {
      const dx = p.x - pt.x, dy = p.y - pt.y;
      if (dx*dx + dy*dy < r2) count++;
    }
  }
  return count;
}

// The target shape we want the tangle to fill: a horizontal ellipse.
// Points inside the ellipse are valued; points outside get penalized.
// Target ellipse — the central "good zone" where letters and initial
// growth happen. Updated by setViewport() to scale with the viewport.
let TARGET_ELLIPSE = {
  cx: 500, cy: 500,
  rx: 360, ry: 240,
};

// Logical canvas dimensions — match the SVG viewBox. Updated by setViewport().
let CANVAS_W = 1000;
let CANVAS_H = 1000;

// Ellipse signed-distance-ish score: positive inside, negative outside.
// Returns 1 at center, 0 at boundary, negative outside.
function ellipseScore(pt) {
  const dx = (pt.x - TARGET_ELLIPSE.cx) / TARGET_ELLIPSE.rx;
  const dy = (pt.y - TARGET_ELLIPSE.cy) / TARGET_ELLIPSE.ry;
  return 1 - Math.sqrt(dx*dx + dy*dy);
}

// Generate candidate "target points" to place new ribbons over. Includes:
//   - all open caps
//   - densely-sampled points along every ribbon's centerline (so new ribbons
//     can cross middles of existing ribbons, not just ends)
function collectTargetPoints() {
  const targets = [];
  // Open caps — we'll add these but keep them a MINORITY of targets
  for (const cap of openCaps) {
    const owner = ribbons[cap.ribbonIdx];
    const cl = owner.centerline;
    let tangent;
    if (cap.which === 'A') {
      tangent = normalize({ x: cl[1].x - cl[0].x, y: cl[1].y - cl[0].y });
    } else {
      const last = cl.length - 1;
      tangent = normalize({ x: cl[last].x - cl[last-1].x, y: cl[last].y - cl[last-1].y });
    }
    targets.push({
      pt: { x: cap.pt.x, y: cap.pt.y },
      tangent,
      sourceRibbonIdx: cap.ribbonIdx,
      isOpenCap: true,
      isHole: false,
    });
  }
  // Densely-sampled body points. Every single interior centerline sample
  // from every ribbon becomes a candidate target, making body-midpoints
  // vastly more numerous than caps.
  for (let ri = 0; ri < ribbons.length; ri++) {
    const r = ribbons[ri];
    const cl = r.centerline;
    const iStart = Math.floor(cl.length * 0.15);
    const iEnd = Math.floor(cl.length * 0.85);
    for (let i = iStart; i <= iEnd; i++) {
      const tangent = normalize({
        x: cl[Math.min(i+1, cl.length-1)].x - cl[Math.max(i-1, 0)].x,
        y: cl[Math.min(i+1, cl.length-1)].y - cl[Math.max(i-1, 0)].y,
      });
      targets.push({
        pt: { x: cl[i].x, y: cl[i].y },
        tangent,
        sourceRibbonIdx: ri,
        isOpenCap: false,
        isHole: false,
      });
    }
  }

  // HOLE DETECTION: sample a grid of points inside the ellipse. A "hole"
  // is a point with LOW local density (empty right here) but HIGH surround
  // density in a larger neighborhood (ribbons around it). These get added
  // as synthetic targets that point toward the nearest existing ribbon's
  // surface — driving the algorithm to place ribbons that pass THROUGH
  // the hole.
  if (ribbons.length >= 3) {
    const STEP = 18;  // finer grid catches smaller holes
    const sz = getActiveScanZone();
    for (let gx = sz.minX; gx <= sz.maxX; gx += STEP) {
      for (let gy = sz.minY; gy <= sz.maxY; gy += STEP) {
        const pt = { x: gx, y: gy };
        if (!inActiveScanZone(pt)) continue;
        const localD = densityAt(pt, 28);     // tight: is this spot empty/nearly-empty?
        const surroundD = densityAt(pt, 70);  // wider: is it surrounded by ribbons?
        // Hole criterion: nearly empty here, but plenty around. Loosened
        // from strict localD===0 to localD<=2 to catch holes right next to
        // ribbon edges, and lower surround threshold for smaller holes.
        if (localD <= 2 && surroundD > 4) {
          let nearestPt = null, nearestRi = 0, nearestD2 = Infinity;
          for (let ri = 0; ri < ribbons.length; ri++) {
            const cl = ribbons[ri].centerline;
            for (let ci = 0; ci < cl.length; ci++) {
              const dx = cl[ci].x - pt.x, dy = cl[ci].y - pt.y;
              const d2 = dx*dx + dy*dy;
              if (d2 < nearestD2) {
                nearestD2 = d2;
                nearestPt = cl[ci];
                nearestRi = ri;
              }
            }
          }
          const toNearest = normalize({
            x: nearestPt.x - pt.x,
            y: nearestPt.y - pt.y,
          });
          const tangent = { x: -toNearest.y, y: toNearest.x };
          targets.push({
            pt: { x: pt.x, y: pt.y },
            tangent,
            sourceRibbonIdx: nearestRi,
            isOpenCap: false,
            isHole: true,
          });
        }
      }
    }
  }

  return targets;
}

// Returns the bounds for grid-based gap scanning. During outward-charge
// mode (after the first fill cycle), use the expanded letterZone so we
// scan the full active territory. Otherwise use TARGET_ELLIPSE for the
// central focus.
function getActiveScanZone() {
  if (letterZone && expansionCycles >= FILL_BEFORE_EXPAND_CYCLES) {
    return {
      minX: letterZone.minX,
      minY: letterZone.minY,
      maxX: letterZone.maxX,
      maxY: letterZone.maxY,
    };
  }
  return {
    minX: TARGET_ELLIPSE.cx - TARGET_ELLIPSE.rx,
    minY: TARGET_ELLIPSE.cy - TARGET_ELLIPSE.ry,
    maxX: TARGET_ELLIPSE.cx + TARGET_ELLIPSE.rx,
    maxY: TARGET_ELLIPSE.cy + TARGET_ELLIPSE.ry,
  };
}

// Returns true if a point is inside the active scan zone.
function inActiveScanZone(pt) {
  if (letterZone && expansionCycles >= FILL_BEFORE_EXPAND_CYCLES) {
    return (
      pt.x >= letterZone.minX && pt.x <= letterZone.maxX &&
      pt.y >= letterZone.minY && pt.y <= letterZone.maxY
    );
  }
  return ellipseScore(pt) >= 0;
}

function addRibbon() {
  if (ribbons.length === 0) {
    placeFirstRibbon();
    return true;
  }

  const targets = collectTargetPoints();
  if (targets.length === 0) return false;

  // Score each target.
  // Core strategy: GROW BREADTH-FIRST, not depth-first. When ribbon A is
  // drawn, we want to add many ribbons connecting to A before moving on.
  // So we track how many branches each ribbon already has, and strongly
  // prefer targets on ribbons with FEW branches yet.
  //
  // Counting branches: a "branch" of ribbon R is any OTHER ribbon whose
  // centerline passes inside R's body. The more of these, the more this
  // ribbon is already saturated.
  const DENSITY_RADIUS = 90;

  // Count branches per ribbon. A "branch" of ribbon R = any other ribbon
  // whose centerline crosses R. We use the cached count if available
  // (invalidated when ribbons change), since this is O(N²) and addRibbon
  // is hot.
  const branchCounts = getBranchCounts();

  for (const t of targets) {
    const density = densityAt(t.pt, DENSITY_RADIUS);
    const ellScore = ellipseScore(t.pt);

    // During early cycles, pull toward the ELLIPSE center (where the letters
    // are) so the algorithm fills the letter region first. After the algorithm
    // switches to outward-charge mode (after FILL_BEFORE_EXPAND_CYCLES),
    // remove this bias entirely — we want the weave to spread uniformly to
    // fill whatever territory the zone has opened up. Without removing this,
    // outer targets get heavily penalized and the weave keeps trying to
    // place near the center even when the zone has expanded.
    let centerPull = 0;
    if (expansionCycles < FILL_BEFORE_EXPAND_CYCLES) {
      const distFromEllipseCenter = Math.hypot(
        t.pt.x - TARGET_ELLIPSE.cx, t.pt.y - TARGET_ELLIPSE.cy
      );
      centerPull = distFromEllipseCenter * 0.08;
    }

    // Branches on this target's source ribbon: if it already has many,
    // penalize (that ribbon is saturated). If it has few, reward (we want
    // to add branches to this one first).
    const br = branchCounts[t.sourceRibbonIdx] || 0;
    const branchPenalty = br * 25;

    // Core score
    // Ellipse score is heavily weighted in early cycles (keep growth in
    // the letter region). In outward-charge mode it's weighted lightly so
    // outer targets aren't heavily penalized.
    const ellipseWeight = (expansionCycles < FILL_BEFORE_EXPAND_CYCLES) ? 40 : 5;
    let score =
      - density * 3
      + ellScore * ellipseWeight
      - centerPull
      - branchPenalty
      + (rand() - 0.5) * 30;

    if (t.isOpenCap) score -= 20;

    // HOLE targets get a BIG bonus. Filling holes takes priority over
    // extending from ribbons.
    if (t.isHole) score += 300;

    t.score = score;
  }
  targets.sort((a, b) => b.score - a.score);

  const sizeVariations = [
    { length: 1.0, bend: 1.0 },
    { length: 0.8, bend: 1.0 },
    { length: 0.65, bend: 0.9 },
    { length: 0.5, bend: 0.8 },
    { length: 0.4, bend: 0.7 },
  ];

  // Try the top N scored targets. Budget tightened — fewer attempts means
  // the algorithm gives up faster on impossible spots and moves on, instead
  // of burning thousands of attempts in dense areas where almost everything
  // fails.
  const TARGETS_TO_TRY = Math.min(20, targets.length);
  for (let ti = 0; ti < TARGETS_TO_TRY; ti++) {
    const target = targets[ti];
    for (const size of sizeVariations) {
      const result = tryPlaceOverTarget(target, size.length, size.bend, 40);
      if (result) {
        const cand = result.ribbon;
        const newIdx = ribbons.length;
        ribbons.push(cand);

        invalidateSaturatedLettersCache();
        // If the target was an open cap, remove it from the open list.
        if (target.isOpenCap) {
          const idx = openCaps.findIndex(c =>
            c.ribbonIdx === target.sourceRibbonIdx &&
            Math.abs(c.pt.x - target.pt.x) < 0.5 &&
            Math.abs(c.pt.y - target.pt.y) < 0.5
          );
          if (idx >= 0) openCaps.splice(idx, 1);
        }
        if (!result.trimmedA) {
          openCaps.push({ ribbonIdx: newIdx, which: 'A', pt: { x: cand.A.x, y: cand.A.y } });
        }
        if (!result.trimmedB) {
          openCaps.push({ ribbonIdx: newIdx, which: 'B', pt: { x: cand.B.x, y: cand.B.y } });
        }
        return true;
      }
    }
  }
  return false;
}

// Refactored from tryPlaceOverCap to tryPlaceOverTarget: accepts a target
// with a point + a tangent (so it works for caps AND mid-ribbon points).
function tryPlaceOverTarget(target, scaleLength, scaleBend, attempts) {
  let best = null, bestScore = -Infinity;

  // Aim perpendicular to the existing ribbon's tangent at this target point.
  const ownerTangent = target.tangent;
  const idealCrossDir = { x: -ownerTangent.y, y: ownerTangent.x };
  const idealAngle = Math.atan2(idealCrossDir.y, idealCrossDir.x);

  for (let attempt = 0; attempt < attempts; attempt++) {
    totalAttempts++;

    // Pick direction (two possible 180°-flipped options), biased toward sparser side
    const probeDist = 70;
    const probeA = {
      x: target.pt.x + idealCrossDir.x * probeDist,
      y: target.pt.y + idealCrossDir.y * probeDist,
    };
    const probeB = {
      x: target.pt.x - idealCrossDir.x * probeDist,
      y: target.pt.y - idealCrossDir.y * probeDist,
    };
    const densA = densityAt(probeA, 70);
    const densB = densityAt(probeB, 70);
    let preferFlip;
    if (densA < densB - 2) preferFlip = 0;
    else if (densB < densA - 2) preferFlip = Math.PI;
    else preferFlip = rand() < 0.5 ? 0 : Math.PI;
    const flip = rand() < 0.25 ? (preferFlip === 0 ? Math.PI : 0) : preferFlip;

    const jitter = (rand() - 0.5) * (Math.PI * 0.44);   // ±40°
    const chordAngle = idealAngle + flip + jitter;

    const length = (100 + rand() * 60) * scaleLength;
    const width = 16 + rand() * 6;
    const bendFrac = (0.35 + rand() * 0.25) * scaleBend;
    const bendSign = rand() < 0.5 ? -1 : 1;
    const bend = (length / 2) * bendFrac * bendSign;

    const dir = { x: Math.cos(chordAngle), y: Math.sin(chordAngle) };
    const perp = { x: -dir.y, y: dir.x };
    const tParam = 0.5;
    const bendAtT = 4 * bend * tParam * (1 - tParam);
    const chordStart = {
      x: target.pt.x - dir.x * (tParam * length) - perp.x * bendAtT,
      y: target.pt.y - dir.y * (tParam * length) - perp.y * bendAtT,
    };
    const cx = chordStart.x + dir.x * (length / 2);
    const cy = chordStart.y + dir.y * (length / 2);

    const fullCand = makeRibbon(cx, cy, chordAngle, length, bend, width);
    const events = findBodyBoundaries(fullCand, ribbons);

    let startInside = false;
    for (const rr of ribbons) {
      if (pointInsideRibbon(fullCand.centerline[0], rr)) { startInside = true; break; }
    }
    let endInside = false;
    const lastPt = fullCand.centerline[fullCand.centerline.length - 1];
    for (const rr of ribbons) {
      if (pointInsideRibbon(lastPt, rr)) { endInside = true; break; }
    }

    let tA = 0, tB = 1;
    let trimmedA = false, trimmedB = false;

    if (startInside) {
      const firstExit = events.find(e => e.kind === 'exit');
      if (firstExit) {
        tA = Math.max(0, firstExit.t - 0.03);
        trimmedA = true;
      }
    }
    if (endInside) {
      let lastEnter = null;
      for (const e of events) if (e.kind === 'enter') lastEnter = e;
      if (lastEnter) {
        tB = Math.min(1, lastEnter.t + 0.03);
        trimmedB = true;
      }
    }

    if (tB - tA < 0.15) continue;

    const cand = makeTrimmedRibbon(cx, cy, chordAngle, length, bend, width, tA, tB);

    if (!pointInsideRibbon(target.pt, cand)) continue;
    if (violatesActiveZone(cand)) continue;

    let valid = true;
    let crossingsTotal = 0;
    for (const rr of ribbons) {
      const n = countCrossings(cand, rr);
      if (n > 1) { valid = false; break; }
      crossingsTotal += n;
    }
    if (!valid) continue;

    for (const rr of ribbons) {
      if (pileUpRun(cand, rr) > 5) { valid = false; break; }
    }
    if (!valid) continue;

    // PARALLEL CHECK: reject if the candidate runs alongside any existing
    // ribbon without crossing it. This prevents the "two ribbons through the
    // same loop" problem where two separate ribbons run parallel through a
    // shared gap.
    const PARALLEL_DIST = 32;   // pixels — ~1.5–2× ribbon width
    const MAX_PARALLEL_SAMPLES = 5;
    for (const rr of ribbons) {
      if (parallelRun(cand, rr, PARALLEL_DIST) > MAX_PARALLEL_SAMPLES) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    // LETTER CROSSING RULE: max 1 white ribbon may cross each letter.
    if (!passesLetterCrossingRule(cand)) continue;

    // Compute crossing angle at the target
    const clC = cand.centerline;
    let nearestIdx = 0;
    let minDist2 = Infinity;
    for (let i = 0; i < clC.length; i++) {
      const dx = clC[i].x - target.pt.x;
      const dy = clC[i].y - target.pt.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < minDist2) { minDist2 = d2; nearestIdx = i; }
    }
    const i1 = Math.max(0, nearestIdx - 1);
    const i2 = Math.min(clC.length - 1, nearestIdx + 1);
    const candTangent = normalize({
      x: clC[i2].x - clC[i1].x,
      y: clC[i2].y - clC[i1].y,
    });
    const dot = Math.abs(candTangent.x * ownerTangent.x + candTangent.y * ownerTangent.y);
    // Soft angle scoring: any crossing angle beyond ~30° is essentially fine.
    // This avoids over-preferring exactly 90° crossings which produce
    // rigidly symmetric patterns.
    const angleScore = dot < 0.85 ? 200 : (1 - dot) * 600;

    let score = 500;
    if (trimmedA) score += 400;
    if (trimmedB) score += 400;
    score += crossingsTotal * 80;
    score += angleScore;
    const len = tB - tA;
    if (len > 0.3 && len < 0.8) score += 100;
    // Randomness so we don't always pick the same "best" candidate
    score += (rand() - 0.5) * 150;

    if (score > bestScore) {
      bestScore = score;
      best = { ribbon: cand, trimmedA, trimmedB };
    }
    if (score > 1700) break;
  }
  return best;
}

// ---- Controls ----
function resetAll() {
  stopPlay();
  ribbons = [];

  invalidateSaturatedLettersCache();
  openCaps = [];
  seed = Math.floor(Math.random() * 100000);
  rand = mulberry32(seed);
  totalAttempts = 0;
  pendingLetterRibbons = [];
  letterZone = null;
  playPhase = 'idle';
  consecutiveZoneFailures = 0;
  fillPlateauTicks = 0;
  fillTotalTicks = 0;
  zoneAddsSinceFill = 0;
  lastExpandRibbonCount = 0;
  expansionCycles = 0;
  stubbornCooldown = 0;
  stubbornFailures = 0;
  render();
  statusEl.textContent = 'ready';
}
function stepOnce(animate) {
  // PHASE: letters — drain pending letter ribbons, one per tick
  if (pendingLetterRibbons.length > 0) {
    playPhase = 'letters';
    const ribbon = pendingLetterRibbons.shift();
    const idx = ribbons.length;
    ribbons.push(ribbon);

    invalidateSaturatedLettersCache();
    if (ribbon._capA) openCaps.push({ ribbonIdx: idx, which: 'A', pt: { x: ribbon.A.x, y: ribbon.A.y } });
    if (ribbon._capB) openCaps.push({ ribbonIdx: idx, which: 'B', pt: { x: ribbon.B.x, y: ribbon.B.y } });
    render({ animateNewest: !!animate });
    statusEl.textContent = pendingLetterRibbons.length > 0
      ? 'drawing letters... (' + pendingLetterRibbons.length + ' left)'
      : 'letters done · weaving zone';
    return true;
  }

  // Letters are done — transition into the zone phase if we haven't already.
  if (playPhase === 'letters' || playPhase === 'idle') {
    if (ribbons.some(r => r.letterFill)) {
      letterZone = computeLetterZone(100);
      playPhase = 'zone';
      consecutiveZoneFailures = 0;
      zoneAddsSinceFill = 0;
    } else {
      // No letters were placed; skip to fill (which will also be a no-op).
      playPhase = 'fill';
      letterZone = null;
    }
  }

  // PHASE: zone — interleave addRibbon with periodic fillGaps to keep density
  // high inside the zone while growth happens. Mirrors the user's manual
  // "add 10 → fill gaps → repeat" workflow.
  if (playPhase === 'zone') {
    // Every ZONE_ADDS_PER_FILL successful additions, run a fill-gaps tick
    if (zoneAddsSinceFill >= ZONE_ADDS_PER_FILL) {
      const gapResult = fillGaps(1);
      if (gapResult.added > 0) {
        const last = ribbons[ribbons.length - 1];
        if (last) last.freshlyPlaced = true;
        render({ animateNewest: !!animate });
        statusEl.textContent = 'weaving zone · gap filled';
        zoneAddsSinceFill = 0;
        consecutiveZoneFailures = 0;
        return true;
      }
      // No gap to fill; reset counter and fall through to addRibbon
      zoneAddsSinceFill = 0;
    }

    const ok = addRibbon();
    render({ animateNewest: !!animate });
    if (ok) {
      consecutiveZoneFailures = 0;
      zoneAddsSinceFill++;
      statusEl.textContent = 'weaving in letter zone';
      return true;
    }
    consecutiveZoneFailures++;
    if (consecutiveZoneFailures < ZONE_SATURATION_THRESHOLD) {
      statusEl.textContent = 'weaving in letter zone (' + consecutiveZoneFailures + '/' + ZONE_SATURATION_THRESHOLD + ')';
      return true;
    }
    // Zone saturated. After the first few careful fill cycles, skip fill
    // phase entirely and just expand outward — the interior is "good
    // enough" and we want to fill the rest of the canvas fast.
    if (expansionCycles >= FILL_BEFORE_EXPAND_CYCLES) {
      const grew = expandLetterZone();
      if (grew) {
        expansionCycles++;
        lastExpandRibbonCount = ribbons.length;
        consecutiveZoneFailures = 0;
        zoneAddsSinceFill = 0;
        statusEl.textContent = 'expanding outward (cycle ' + expansionCycles + ')';
        return true;
      }
      // Already at canvas limits — go to fill phase for final cleanup
      playPhase = 'fill';
      consecutiveZoneFailures = 0;
      statusEl.textContent = 'final cleanup';
      return true;
    }
    // Early cycles: thorough fill before expanding
    playPhase = 'fill';
    statusEl.textContent = 'thorough fill of letter zone';
    consecutiveZoneFailures = 0;
    return true;
  }

  // PHASE: fill — incremental densification: try fillGaps, then coverOpenCaps,
  // then fillStubbornGaps. After enough plateau ticks (where fill operations
  // add little or nothing meaningful), transition to expand phase. Also
  // hard-capped at MAX_FILL_TICKS total to prevent indefinite grinding.
  if (playPhase === 'fill') {
    fillTotalTicks++;

    // Hit hard cap? Force expansion regardless of whether more interior
    // placements are still possible. This is the safety net that ensures
    // outward growth eventually happens even when interior gaps abound.
    if (fillTotalTicks >= MAX_FILL_TICKS) {
      const grew = expandLetterZone();
      if (grew) {
        expansionCycles++;
        lastExpandRibbonCount = ribbons.length;
        playPhase = 'zone';
        consecutiveZoneFailures = 0;
        zoneAddsSinceFill = 0;
        fillPlateauTicks = 0;
        fillTotalTicks = 0;
        statusEl.textContent = 'fill capped, expanding (cycle ' + expansionCycles + ')';
        return true;
      }
      // At canvas max — fall through to normal final cleanup logic below
      fillTotalTicks = 0;
    }

    let added = 0;
    // Try one gap fill
    const gapResult = fillGaps(1);
    if (gapResult.added > 0) {
      const last = ribbons[ribbons.length - 1];
      if (last) last.freshlyPlaced = true;
      added += gapResult.added;
    } else {
      // Try one cap cover
      const capResult = coverOpenCaps();
      if (capResult.added > 0) {
        const last = ribbons[ribbons.length - 1];
        if (last) last.freshlyPlaced = true;
        added += capResult.added;
      }
    }

    if (added > 0) {
      render({ animateNewest: !!animate });
      statusEl.textContent = 'filling letter zone · +' + added + ' (' + fillTotalTicks + '/' + MAX_FILL_TICKS + ')';
      fillPlateauTicks = 0;
      return true;
    }

    // No additions this tick — count toward plateau threshold.
    // We deliberately do NOT run fillStubbornGaps here: it's too aggressive
    // at finding marginal interior placements, which prevents the plateau
    // from triggering and stalls outward expansion. Stubborn is reserved
    // for final cleanup at the canvas edges only.
    fillPlateauTicks++;
    if (fillPlateauTicks < FILL_PLATEAU_THRESHOLD) {
      statusEl.textContent = 'fill plateau (' + fillPlateauTicks + '/' + FILL_PLATEAU_THRESHOLD + ')';
      return true;
    }

    // Plateau reached — letter zone is dense at current size. Try to expand
    // the rectangle outward and continue weaving in the larger zone.
    const grew = expandLetterZone();
    if (grew) {
      expansionCycles++;
      lastExpandRibbonCount = ribbons.length;
      playPhase = 'zone';     // go back to growth in the now-larger zone
      consecutiveZoneFailures = 0;
      zoneAddsSinceFill = 0;
      fillPlateauTicks = 0;
      fillTotalTicks = 0;
      statusEl.textContent = 'expanding zone outward (cycle ' + expansionCycles + ')';
      return true;
    }

    // Zone is at canvas limits — do thorough final cleanup. Run fillGaps and
    // coverOpenCaps every tick; throttle fillStubbornGaps (expensive grid
    // scan) — only run it once per N ticks of pure plateau.
    const finalGap = fillGaps(1);
    if (finalGap.added > 0) {
      const last = ribbons[ribbons.length - 1];
      if (last) last.freshlyPlaced = true;
      render({ animateNewest: !!animate });
      statusEl.textContent = 'final cleanup · gap +' + finalGap.added;
      stubbornCooldown = 0;     // reset throttle since we made progress
      return true;
    }
    const finalCap = coverOpenCaps();
    if (finalCap.added > 0) {
      const last = ribbons[ribbons.length - 1];
      if (last) last.freshlyPlaced = true;
      render({ animateNewest: !!animate });
      statusEl.textContent = 'final cleanup · cap +' + finalCap.added;
      stubbornCooldown = 0;
      return true;
    }
    // No quick fill found — try stubborn ONLY if cooldown has elapsed
    if (stubbornCooldown <= 0) {
      const finalStub = fillStubbornGaps();
      if (finalStub.added > 0) {
        render({ animateNewest: false });
        statusEl.textContent = 'final cleanup · stubborn +' + finalStub.added;
        stubbornCooldown = 0;
        return true;
      }
      // Stubborn returned 0 too — set cooldown, count toward done
      stubbornCooldown = STUBBORN_COOLDOWN_MAX;
      stubbornFailures++;
    } else {
      stubbornCooldown--;
      stubbornFailures++;
    }

    // If stubborn has come up empty STUBBORN_FAILURE_THRESHOLD times in a row,
    // really nothing more can be added — declare done.
    if (stubbornFailures >= STUBBORN_FAILURE_THRESHOLD) {
      playPhase = 'done';
      statusEl.textContent = 'composition complete';
      stopPlay();
      return false;
    }
    statusEl.textContent = 'final cleanup (' + stubbornFailures + '/' + STUBBORN_FAILURE_THRESHOLD + ')';
    return true;
  }

  // Already done
  return false;
}
function startPlay() {
  if (playInterval) return;
  { const _p = document.getElementById('play'); if (_p) { _p.textContent = '■ stop'; _p.classList.add('playing'); } }
  // Interval matches the draw-in animation duration (320ms) + a small gap,
  // so each new ribbon's pen-stroke finishes before the next begins.
  playInterval = setInterval(() => {
    if (!stepOnce(true)) stopPlay();
  }, 380);
}
function stopPlay() {
  if (!playInterval) return;
  clearInterval(playInterval);
  playInterval = null;
  { const _p = document.getElementById('play'); if (_p) { _p.textContent = '▶ play'; _p.classList.remove('playing'); } }
}

// Blocked-gap tracking: when a gap can't be filled, remember it so we don't
// re-find the exact same spot on the next iteration.
const blockedGapRegions = [];
function blockGapPoint(pt) {
  blockedGapRegions.push({ x: pt.x, y: pt.y });
}
function isBlockedGap(pt) {
  for (const b of blockedGapRegions) {
    if (Math.hypot(b.x - pt.x, b.y - pt.y) < 15) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// GAP FILLING — a separate pass run after the main structure is in place.
// -----------------------------------------------------------------------------
// Scans for small empty pockets and exposed cap endings, then tries to place
// SHORT custom ribbons sized exactly to bridge them. Uses smaller widths,
// shorter lengths, and tighter bends than the main algorithm — these are
// the last-mile "fix-it" ribbons that plug residual holes.
function fillGaps(maxAdds) {
  let added = 0;
  const MAX_ITERATIONS = maxAdds || 50;

  // Reset blocked-gap list at the start of each run
  blockedGapRegions.length = 0;

  let gapsFound = 0;
  let gapsRejectedForConstraints = 0;

  // ---------------------------------------------------------------------
  // Collect ALL qualifying gaps in one pass, then sort by score.
  // Process them in score order BUT enforce spatial separation — after
  // each successful fill, any nearby gaps get deferred. This gives us
  // coverage across the whole field instead of greedy clustering.
  // ---------------------------------------------------------------------
  const allGaps = [];
  const STEP = 10;
  const fgZone = getActiveScanZone();
  for (let gx = fgZone.minX; gx <= fgZone.maxX; gx += STEP) {
    for (let gy = fgZone.minY; gy <= fgZone.maxY; gy += STEP) {
      const pt = { x: gx, y: gy };
      if (!inActiveScanZone(pt)) continue;
      const localD = densityAt(pt, 20);
      const surroundD = densityAt(pt, 55);
      if (surroundD < 3) continue;
      if (surroundD <= localD * 2) continue;
      const score = surroundD - localD * 3;
      allGaps.push({ pt, score, localD, surroundD });
    }
  }
  // Sort by score descending
  allGaps.sort((a, b) => b.score - a.score);

  // Spatial deduplication: remove gaps that are very close to other higher-
  // scoring gaps (they're really the same opening viewed from slightly
  // different grid points).
  const DEDUP_DIST = 35;  // pixels — any two gaps within this distance collapse to one
  const dedupedGaps = [];
  for (const g of allGaps) {
    let isDup = false;
    for (const kept of dedupedGaps) {
      if (Math.hypot(kept.pt.x - g.pt.x, kept.pt.y - g.pt.y) < DEDUP_DIST) {
        isDup = true;
        break;
      }
    }
    if (!isDup) dedupedGaps.push(g);
  }

  gapsFound = dedupedGaps.length;
  console.log('fillGaps: found ' + dedupedGaps.length + ' distinct gap regions (deduped from ' + allGaps.length + ')');

  // Process all gaps in order, up to MAX_ITERATIONS fills.
  for (const gap of dedupedGaps) {
    if (added >= MAX_ITERATIONS) break;
    const bestGap = gap.pt;

    // 2) Measure gap dimensions via 16-ray probe (kept from original, used
    //    only for diagnostic purposes now — the brute force doesn't need it)
    const probeAngles = [];
    for (let i = 0; i < 16; i++) probeAngles.push((i / 16) * Math.PI * 2);
    const reaches = [];
    for (const theta of probeAngles) {
      const dx = Math.cos(theta), dy = Math.sin(theta);
      let reach = 150;
      for (let r = 4; r <= 150; r += 2) {
        const testPt = { x: bestGap.x + dx * r, y: bestGap.y + dy * r };
        let hit = false;
        for (const rr of ribbons) {
          if (pointInsideRibbon(testPt, rr)) { hit = true; break; }
        }
        if (hit) { reach = r; break; }
      }
      reaches.push({ theta, reach });
    }

    // 3) Pick the long axis
    let longAxisIdx = 0;
    for (let i = 0; i < reaches.length; i++) {
      if (reaches[i].reach > reaches[longAxisIdx].reach) longAxisIdx = i;
    }
    const oppositeIdx = (longAxisIdx + 8) % 16;
    const reachFwd = reaches[longAxisIdx].reach;
    const reachBack = reaches[oppositeIdx].reach;

    // 4) Find MIN reach among NEARBY angles (perpendicular directions), to
    //    pick a width that actually fits.
    let minPerpReach = Infinity;
    for (let i = 0; i < reaches.length; i++) {
      const diff = Math.abs(i - longAxisIdx);
      const perpDiff = Math.min(diff, 16 - diff);
      if (perpDiff >= 3 && perpDiff <= 5) {
        if (reaches[i].reach < minPerpReach) minPerpReach = reaches[i].reach;
      }
    }
    if (minPerpReach === Infinity) minPerpReach = 20;

    // 3) BRUTE FORCE placement: instead of computing a single "best" angle
    //    from the gap geometry, we just try MANY random candidates centered
    //    on the gap. Each candidate is a normal-width, realistic-length
    //    ribbon oriented randomly, positioned so the gap sits somewhere in
    //    its body (not necessarily at its exact middle). Accept the first
    //    one that passes the strict constraints. This matches how a human
    //    fills a gap: pick up a ribbon, rotate it around until it fits.
    const GAP_ATTEMPTS = 200;
    let placed = false;
    let lastRejectReason = '';

    for (let atpt = 0; atpt < GAP_ATTEMPTS && !placed; atpt++) {
      const chordAngle = rand() * Math.PI * 2;
      // Same WIDTH as main algorithm (16-22). Fill ribbons aren't visually
      // different from main ribbons — a fill ribbon is just a SHORTER
      // version of a regular ribbon. Using a thinner width here creates
      // visual outliers that look like twigs/hairs.
      const width = 16 + rand() * 6;
      // Length: allow down to 60 (shorter than main's 90 minimum) so we
      // can plug small gaps, up to ~130.
      const length = 60 + rand() * 70;
      const bendFrac = 0.30 + rand() * 0.30;
      const bendSign = rand() < 0.5 ? -1 : 1;
      const bend = (length / 2) * bendFrac * bendSign;

      // Position: gap sits at a random tParam inside the ribbon body.
      const tParam = 0.25 + rand() * 0.5;
      const dir = { x: Math.cos(chordAngle), y: Math.sin(chordAngle) };
      const perp = { x: -dir.y, y: dir.x };
      const bendAtT = 4 * bend * tParam * (1 - tParam);
      const chordStart = {
        x: bestGap.x - dir.x * (tParam * length) - perp.x * bendAtT,
        y: bestGap.y - dir.y * (tParam * length) - perp.y * bendAtT,
      };
      const cx = chordStart.x + dir.x * (length / 2);
      const cy = chordStart.y + dir.y * (length / 2);

      const fullCand = makeRibbon(cx, cy, chordAngle, length, bend, width);
      const events = findBodyBoundaries(fullCand, ribbons);
      let startInside = false;
      for (const rr of ribbons) {
        if (pointInsideRibbon(fullCand.centerline[0], rr)) { startInside = true; break; }
      }
      let endInside = false;
      const lastPt2 = fullCand.centerline[fullCand.centerline.length - 1];
      for (const rr of ribbons) {
        if (pointInsideRibbon(lastPt2, rr)) { endInside = true; break; }
      }
      let tA = 0, tB = 1, trimmedA = false, trimmedB = false;
      if (startInside) {
        const firstExit = events.find(e => e.kind === 'exit');
        if (firstExit) { tA = Math.max(0, firstExit.t - 0.03); trimmedA = true; }
      }
      if (endInside) {
        let lastEnter = null;
        for (const e of events) if (e.kind === 'enter') lastEnter = e;
        if (lastEnter) { tB = Math.min(1, lastEnter.t + 0.03); trimmedB = true; }
      }
      if (tB - tA < 0.15) { lastRejectReason = 'too-short trim'; continue; }

      const cand = makeTrimmedRibbon(cx, cy, chordAngle, length, bend, width, tA, tB);

      if (!pointInsideRibbon(bestGap, cand)) { lastRejectReason = 'miss gap'; continue; }
      if (violatesActiveZone(cand)) { lastRejectReason = 'outside letter zone'; continue; }

      // Strict on multi-cross (fundamental weave rule)
      let valid = true, rejectedOn = '';
      for (const rr of ribbons) {
        if (countCrossings(cand, rr) > 1) { valid = false; rejectedOn = 'multi-cross'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }
      // Pile-up: longest CONSECUTIVE run inside another ribbon.
      // For gap-fillers specifically, we allow up to 7 (vs main algorithm's 5)
      // because a fill ribbon entering a bordering ribbon, traversing its
      // body to reach a gap's center, and exiting can legitimately have a
      // longer continuous run of internal samples. That's not piling up —
      // that's the necessary traversal to bridge through a dense area.
      for (const rr of ribbons) {
        if (pileUpRun(cand, rr) > 7) { valid = false; rejectedOn = 'pile-up'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }
      // Parallel: longest consecutive run of close samples with no crossing.
      // Allow up to 7 for gap-fillers too — same reasoning.
      for (const rr of ribbons) {
        if (parallelRun(cand, rr, 28) > 7) { valid = false; rejectedOn = 'parallel'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }

      // Require BOTH ends to be trimmed
      if (!trimmedA || !trimmedB) { lastRejectReason = 'exposed end'; continue; }

      // LETTER CROSSING RULE
      if (!passesLetterCrossingRule(cand)) { lastRejectReason = 'letter cross'; continue; }

      const newIdx = ribbons.length;
      ribbons.push(cand);

      invalidateSaturatedLettersCache();
      added++;
      console.log('fillGaps: added ribbon ' + added + ' at gap', bestGap, 'after ' + (atpt + 1) + ' attempts');
      placed = true;
    }

    if (!placed) {
      gapsRejectedForConstraints++;
      console.log('fillGaps: rejected (' + lastRejectReason + ') at', bestGap, 'after ' + GAP_ATTEMPTS + ' attempts');
      blockGapPoint(bestGap);
    }
  }

  console.log('fillGaps summary: ' + added + ' added, ' + gapsFound + ' candidates found, ' + gapsRejectedForConstraints + ' rejected');
  return { added, found: gapsFound, rejected: gapsRejectedForConstraints };
}

// -----------------------------------------------------------------------------
// coverOpenCaps — targeted pass to cover any remaining exposed cap endings.
// -----------------------------------------------------------------------------
// Runs AFTER fillGaps. For each open cap (exposed cap ending), tries to place
// a ribbon whose BODY (not its own ends) crosses over that cap point.
// This is the "clean up the fringe" pass.
function coverOpenCaps() {
  let added = 0;
  let capsAttempted = 0;

  // Snapshot the current list of open caps — new placements will change it.
  const capsToTry = openCaps.slice();

  for (const targetCap of capsToTry) {
    // Skip if this cap was already covered by a later addition
    let stillOpen = false;
    for (const oc of openCaps) {
      if (oc.ribbonIdx === targetCap.ribbonIdx && oc.which === targetCap.which) {
        stillOpen = true;
        break;
      }
    }
    if (!stillOpen) continue;
    capsAttempted++;

    const GAP_ATTEMPTS = 300;
    let placed = false;
    let lastRejectReason = '';

    for (let atpt = 0; atpt < GAP_ATTEMPTS && !placed; atpt++) {
      // Random angle — we want the ribbon to cross OVER the cap, not parallel
      const chordAngle = rand() * Math.PI * 2;
      // Same width as main ribbons
      const width = 16 + rand() * 6;
      // Shorter lengths OK for fringe coverage
      const length = 70 + rand() * 60;
      const bendFrac = 0.30 + rand() * 0.30;
      const bendSign = rand() < 0.5 ? -1 : 1;
      const bend = (length / 2) * bendFrac * bendSign;

      // Position so the cap sits at a random tParam in the middle 50% of
      // the ribbon (not near the ends).
      const tParam = 0.30 + rand() * 0.40;
      const dir = { x: Math.cos(chordAngle), y: Math.sin(chordAngle) };
      const perp = { x: -dir.y, y: dir.x };
      const bendAtT = 4 * bend * tParam * (1 - tParam);
      const chordStart = {
        x: targetCap.pt.x - dir.x * (tParam * length) - perp.x * bendAtT,
        y: targetCap.pt.y - dir.y * (tParam * length) - perp.y * bendAtT,
      };
      const cx = chordStart.x + dir.x * (length / 2);
      const cy = chordStart.y + dir.y * (length / 2);

      const fullCand = makeRibbon(cx, cy, chordAngle, length, bend, width);

      // Trim ends into neighbors (same machinery)
      const events = findBodyBoundaries(fullCand, ribbons);
      let startInside = false;
      for (const rr of ribbons) {
        if (pointInsideRibbon(fullCand.centerline[0], rr)) { startInside = true; break; }
      }
      let endInside = false;
      const lastPt = fullCand.centerline[fullCand.centerline.length - 1];
      for (const rr of ribbons) {
        if (pointInsideRibbon(lastPt, rr)) { endInside = true; break; }
      }
      let tA = 0, tB = 1, trimmedA = false, trimmedB = false;
      if (startInside) {
        const firstExit = events.find(e => e.kind === 'exit');
        if (firstExit) { tA = Math.max(0, firstExit.t - 0.03); trimmedA = true; }
      }
      if (endInside) {
        let lastEnter = null;
        for (const e of events) if (e.kind === 'enter') lastEnter = e;
        if (lastEnter) { tB = Math.min(1, lastEnter.t + 0.03); trimmedB = true; }
      }
      if (tB - tA < 0.15) { lastRejectReason = 'too-short trim'; continue; }

      const cand = makeTrimmedRibbon(cx, cy, chordAngle, length, bend, width, tA, tB);

      // Verify the cap is inside the candidate's MIDDLE (not near its ends)
      if (!pointInsideRibbonMiddle(targetCap.pt, cand)) { lastRejectReason = 'cap not in middle'; continue; }
      if (violatesActiveZone(cand)) { lastRejectReason = 'outside letter zone'; continue; }

      let valid = true, rejectedOn = '';
      for (const rr of ribbons) {
        if (countCrossings(cand, rr) > 1) { valid = false; rejectedOn = 'multi-cross'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }
      for (const rr of ribbons) {
        if (pileUpRun(cand, rr) > 7) { valid = false; rejectedOn = 'pile-up'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }
      for (const rr of ribbons) {
        if (parallelRun(cand, rr, 28) > 7) { valid = false; rejectedOn = 'parallel'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }

      // Require BOTH ends to be trimmed (tucked under neighbors)
      if (!trimmedA || !trimmedB) { lastRejectReason = 'exposed end'; continue; }

      // LETTER CROSSING RULE
      if (!passesLetterCrossingRule(cand)) { lastRejectReason = 'letter cross'; continue; }

      ribbons.push(cand);


      invalidateSaturatedLettersCache();
      added++;
      placed = true;
      console.log('coverOpenCaps: covered cap at', targetCap.pt, 'after ' + (atpt + 1) + ' attempts');
    }

    if (!placed) {
      console.log('coverOpenCaps: could not cover cap at', targetCap.pt);
    }
  }

  // Recompute open caps after all additions
  // (The open caps list lives at module level; we need to rebuild it.
  // Each cap is open if no LATER ribbon in placement order covers it.)
  rebuildOpenCaps();

  console.log('coverOpenCaps summary: ' + added + ' caps covered out of ' + capsAttempted);
  return { added, attempted: capsAttempted };
}

// -----------------------------------------------------------------------------
// fillStubbornGaps — a last-resort pass for persistent interior holes that
// regular fillGaps couldn't close. Uses SHORTER candidate ribbons (so they
// cross fewer neighbors) and MANY more per-gap attempts. Smaller dedup radius
// so closely-spaced tiny holes get individual attention.
// -----------------------------------------------------------------------------
function fillStubbornGaps(maxAdds) {
  if (maxAdds === undefined) maxAdds = 5;     // small default batch
  let added = 0;

  // Collect gaps with a tighter local/surround measurement, smaller dedup.
  const allGaps = [];
  const STEP = 8;
  const fsZone = getActiveScanZone();
  for (let gx = fsZone.minX; gx <= fsZone.maxX; gx += STEP) {
    for (let gy = fsZone.minY; gy <= fsZone.maxY; gy += STEP) {
      const pt = { x: gx, y: gy };
      if (!inActiveScanZone(pt)) continue;
      const localD = densityAt(pt, 12);       // tight local — even small holes qualify
      const surroundD = densityAt(pt, 40);    // tight surround
      if (surroundD < 4) continue;
      if (localD > 3) continue;              // allow up to 3 encroaching samples
      if (surroundD <= localD * 2) continue;
      const score = surroundD - localD * 3;
      allGaps.push({ pt, score });
    }
  }
  allGaps.sort((a, b) => b.score - a.score);

  // Tighter dedup (20 instead of 35) — small holes can be close together
  const DEDUP_DIST = 20;
  const deduped = [];
  for (const g of allGaps) {
    let isDup = false;
    for (const kept of deduped) {
      if (Math.hypot(kept.pt.x - g.pt.x, kept.pt.y - g.pt.y) < DEDUP_DIST) {
        isDup = true;
        break;
      }
    }
    if (!isDup) deduped.push(g);
  }

  console.log('fillStubbornGaps: found ' + deduped.length + ' stubborn gap regions');

  for (const gap of deduped) {
    if (added >= maxAdds) break;          // batch cap reached
    const bestGap = gap.pt;
    const GAP_ATTEMPTS = 600;       // more attempts
    let placed = false;
    let lastRejectReason = '';

    for (let atpt = 0; atpt < GAP_ATTEMPTS && !placed; atpt++) {
      const chordAngle = rand() * Math.PI * 2;
      // SHORTER ribbons — key for spanning tight pockets. 50-90 px.
      const width = 16 + rand() * 6;
      const length = 50 + rand() * 40;
      const bendFrac = 0.30 + rand() * 0.30;
      const bendSign = rand() < 0.5 ? -1 : 1;
      const bend = (length / 2) * bendFrac * bendSign;

      const tParam = 0.35 + rand() * 0.30;
      const dir = { x: Math.cos(chordAngle), y: Math.sin(chordAngle) };
      const perp = { x: -dir.y, y: dir.x };
      const bendAtT = 4 * bend * tParam * (1 - tParam);
      const chordStart = {
        x: bestGap.x - dir.x * (tParam * length) - perp.x * bendAtT,
        y: bestGap.y - dir.y * (tParam * length) - perp.y * bendAtT,
      };
      const cx = chordStart.x + dir.x * (length / 2);
      const cy = chordStart.y + dir.y * (length / 2);

      const fullCand = makeRibbon(cx, cy, chordAngle, length, bend, width);
      const events = findBodyBoundaries(fullCand, ribbons);
      let startInside = false;
      for (const rr of ribbons) {
        if (pointInsideRibbon(fullCand.centerline[0], rr)) { startInside = true; break; }
      }
      let endInside = false;
      const lastPt = fullCand.centerline[fullCand.centerline.length - 1];
      for (const rr of ribbons) {
        if (pointInsideRibbon(lastPt, rr)) { endInside = true; break; }
      }
      let tA = 0, tB = 1, trimmedA = false, trimmedB = false;
      if (startInside) {
        const firstExit = events.find(e => e.kind === 'exit');
        if (firstExit) { tA = Math.max(0, firstExit.t - 0.03); trimmedA = true; }
      }
      if (endInside) {
        let lastEnter = null;
        for (const e of events) if (e.kind === 'enter') lastEnter = e;
        if (lastEnter) { tB = Math.min(1, lastEnter.t + 0.03); trimmedB = true; }
      }
      if (tB - tA < 0.15) { lastRejectReason = 'too-short trim'; continue; }

      const cand = makeTrimmedRibbon(cx, cy, chordAngle, length, bend, width, tA, tB);

      if (!pointInsideRibbon(bestGap, cand)) { lastRejectReason = 'miss gap'; continue; }
      if (violatesActiveZone(cand)) { lastRejectReason = 'outside letter zone'; continue; }

      let valid = true, rejectedOn = '';
      for (const rr of ribbons) {
        if (countCrossings(cand, rr) > 1) { valid = false; rejectedOn = 'multi-cross'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }
      // VERY lenient for stubborn gaps — these are last-resort bridges
      // in tight geometry where traversal is expected.
      for (const rr of ribbons) {
        if (pileUpRun(cand, rr) > 11) { valid = false; rejectedOn = 'pile-up'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }
      for (const rr of ribbons) {
        if (parallelRun(cand, rr, 25) > 11) { valid = false; rejectedOn = 'parallel'; break; }
      }
      if (!valid) { lastRejectReason = rejectedOn; continue; }
      if (!trimmedA || !trimmedB) { lastRejectReason = 'exposed end'; continue; }

      // LETTER CROSSING RULE
      if (!passesLetterCrossingRule(cand)) { lastRejectReason = 'letter cross'; continue; }

      ribbons.push(cand);


      invalidateSaturatedLettersCache();
      added++;
      placed = true;
      console.log('fillStubbornGaps: added at', bestGap, 'after ' + (atpt + 1) + ' attempts');
    }
    if (!placed) {
      console.log('fillStubbornGaps: gave up at', bestGap, '(' + lastRejectReason + ')');
    }
  }

  rebuildOpenCaps();
  console.log('fillStubbornGaps summary: ' + added + ' filled');
  return { added };
}


// Recompute the open-caps list from scratch based on current ribbons
function rebuildOpenCaps() {
  openCaps = [];
  for (let i = 0; i < ribbons.length; i++) {
    const r = ribbons[i];
    // Cap A: open if no later-placed ribbon covers r.A
    let aCovered = false, bCovered = false;
    for (let j = i + 1; j < ribbons.length; j++) {
      if (!aCovered && pointInsideRibbon(r.A, ribbons[j])) aCovered = true;
      if (!bCovered && pointInsideRibbon(r.B, ribbons[j])) bCovered = true;
      if (aCovered && bCovered) break;
    }
    if (!aCovered) openCaps.push({ ribbonIdx: i, which: 'A', pt: { x: r.A.x, y: r.A.y } });
    if (!bCovered) openCaps.push({ ribbonIdx: i, which: 'B', pt: { x: r.B.x, y: r.B.y } });
  }
}




// -----------------------------------------------------------------------------
// generateTypography — the full entry point for "type a word, get the weave"
// -----------------------------------------------------------------------------
function generateTypography(text) {
  stopPlay();

  // Reset
  ribbons = [];

  invalidateSaturatedLettersCache();
  openCaps = [];
  totalAttempts = 0;
  seed = Math.floor(Math.random() * 100000);
  rand = mulberry32(seed);
  blockedGapRegions.length = 0;
  pendingLetterRibbons = [];
  letterZone = null;
  playPhase = 'idle';
  consecutiveZoneFailures = 0;
  fillPlateauTicks = 0;
  fillTotalTicks = 0;
  zoneAddsSinceFill = 0;
  lastExpandRibbonCount = 0;
  expansionCycles = 0;
  stubbornCooldown = 0;
  stubbornFailures = 0;

  currentText = text;
  placeLetterRibbons();
  render();
}


  // ---------------------------------------------------------------------------
  // Public API — the React wrapper drives these.
  // ---------------------------------------------------------------------------
  let _resizeTimer = null;

  return {
    /** Size the viewport, queue the word's letters, and auto-play the weave. */
    start() {
      setViewport();
      generateTypography(INITIAL_WORD);
      // small delay so first paint completes for a smoother landing feel
      setTimeout(() => { startPlay(); }, 200);
    },
    /** Regenerate to fit new container dimensions (debounced by caller or here). */
    handleResize() {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        setViewport();
        generateTypography(currentText || INITIAL_WORD);
        startPlay();
      }, 250);
    },
    /** Change the wallpaper word at runtime. */
    setWord(word) {
      generateTypography(word || INITIAL_WORD);
      setTimeout(() => { startPlay(); }, 60);
    },

    /* ---- Control-panel actions (used by the optional sidebar) ---- */
    /** Regenerate the weave from the given word (queues letters, no autoplay). */
    regenerate(word) { generateTypography(word || INITIAL_WORD); },
    /** Regenerate for a new word and immediately weave it in (matches the
     *  original's stop → regenerate → play flow, with its small defer). */
    regenerateAndPlay(word) {
      stopPlay();
      setTimeout(() => { generateTypography(word || INITIAL_WORD); startPlay(); }, 10);
    },
    play() { startPlay(); },
    stop() { stopPlay(); },
    togglePlay() { if (playInterval) stopPlay(); else startPlay(); },
    isPlaying() { return !!playInterval; },
    /** Place a single ribbon (stops autoplay first, like the original). */
    step() { stopPlay(); stepOnce(true); },
    /** Place up to n ribbons in one go. */
    addMany(n = 10) { stopPlay(); for (let i = 0; i < n; i++) { if (!stepOnce(true)) break; } },
    /** Remove the most recently placed ribbon. */
    undo() {
      stopPlay();
      if (ribbons.length === 0) return;
      ribbons.pop();
      invalidateSaturatedLettersCache();
      rebuildOpenCaps();
      render();
    },
    /** Clear everything back to empty. */
    reset() { resetAll(); },

    /** Stop all animation timers and clear pending work. */
    destroy() {
      try { stopPlay(); } catch (e) {}
      if (playInterval) { clearInterval(playInterval); playInterval = null; }
      if (_statsTimer) { clearTimeout(_statsTimer); _statsTimer = null; }
      clearTimeout(_resizeTimer);
    },
  };
}
