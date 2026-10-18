/* Odyssey — standalone app logic. Navigation engine: Athena.
 * All scoring is done by the trained Athena model (entities/model.json).
 * Live Environment Agency data is fetched in the browser (CORS-enabled API).
 * No build step, no backend, no keys. Core is exported for Node testing.
 */
"use strict";

/* ----------------------------- constants ------------------------------ */
const BAND_RANK = { low: 0, medium: 1, high: 2 };
const WALK_M_PER_MIN = 80;

// Athena risk-penalty profiles: metres cost more on risky segments
const PROFILES = {
  shortest: { low: 0, medium: 0, high: 0, unknown: 0 },
  safest:   { low: 0, medium: 6, high: 60, unknown: 5 },
  balanced: { low: 0, medium: 3, high: 30, unknown: 3 },
};
// docks/parking access ways: allowed in the graph (they close gated-area
// gaps) but every profile discourages them.
const SERVICE_MULT = 3.0;
// how strongly the continuous model probability adds to segment cost
const RISK_W = { safest: 30, balanced: 15, shortest: 0 };

const PRESETS = [
  ["University of Southampton (Highfield)", 50.9362, -1.3957],
  ["Portswood shops", 50.9285, -1.3995],
  ["City centre (Above Bar)", 50.9045, -1.4025],
  ["Southampton Central station", 50.9085, -1.4115],
  ["Town Quay / ferries", 50.8998, -1.4005],
  ["Ocean Village", 50.9040, -1.3930],
  ["St Denys", 50.9215, -1.3905],
  ["Bitterne Park (Cobden Bridge)", 50.9245, -1.3780],
  ["Bevois Valley Road", 50.9200, -1.4045],
  ["Shirley High Street", 50.9105, -1.4325],
];

const EA_BASE = "https://environment.data.gov.uk/flood-monitoring";
const EA_TIDE_GAUGE = "E12660";   // Woolston tide gauge (live, OGL v3)

/* ------------------------------ utils --------------------------------- */
function distM(a, b) {
  const r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const key = (c) => c[0].toFixed(5) + "," + c[1].toFixed(5);
const esc = (s) => String(s).replace(/[&<>"]/g,
  (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));

/* ------------------------- graph + routing ---------------------------- */
function buildGraph(segments) {
  const nodes = new Map();
  function node(c) {
    const k = key(c);
    if (!nodes.has(k)) nodes.set(k, { c, adj: [] });
    return k;
  }
  const byId = new Map(segments.map(s => [s.id, s]));
  for (const s of segments) {
    const cs = s.coordinates;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = node(cs[i]), b = node(cs[i + 1]);
      const len = distM(cs[i], cs[i + 1]) || 1;
      nodes.get(a).adj.push({ to: b, len, seg: s.id });
      nodes.get(b).adj.push({ to: a, len, seg: s.id });
    }
  }
  return { nodes, byId };
}

function snap(graph, latlng) {
  let best = null, bestD = Infinity;
  for (const n of graph.nodes.values()) {
    const d = distM(n.c, latlng);
    if (d < bestD) { bestD = d; best = n; }
  }
  return { key: key(best.c), coord: best.c, dist: bestD };
}

class MinHeap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top; }
  get size() { return this.a.length; }
}

/* Dijkstra over a per-segment penalty profile. Returns:
 * { segments: unique segs in order, chainLen: metres actually walked,
 *   steps: [{from,to,seg,len}] node hops } or null. */
const MAX_EXTRA_MIN = 12;   // a safer route is only offered if the detour
                            // stays within this many extra walking minutes

function findRoute(graph, startKey, destKey, profile) {
  const isNamed = typeof profile === "string";
  const pen = isNamed ? PROFILES[profile] : profile;
  const rw = profile.rw ?? (isNamed ? RISK_W[profile] : RISK_W.safest);
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new MinHeap(); heap.push([0, startKey]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === destKey) break;
    for (const e of graph.nodes.get(u).adj) {
      if (done.has(e.to)) continue;
      const seg = graph.byId.get(e.seg);
      const cost = e.len * (1 + pen[seg.risk_band]
        + rw * (seg.risk_score ?? 0)) *
        (seg.highway_type === "service" ? SERVICE_MULT : 1);
      const nd = d + cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: u, seg: e.seg, len: e.len });
        heap.push([nd, e.to]);
      }
    }
  }
  if (!done.has(destKey)) return null;
  const back = [];
  let cur = destKey;
  while (cur !== startKey) {
    const p = prev.get(cur);
    if (!p) return null;
    back.push({ from: p.node, to: cur, seg: p.seg, len: p.len });
    cur = p.node;
  }
  back.reverse();
  const segments = [];
  let chainLen = 0, lastSeg = null;
  for (const st of back) {
    chainLen += st.len;
    if (st.seg !== lastSeg) { segments.push(graph.byId.get(st.seg)); lastSeg = st.seg; }
  }
  return { segments, chainLen, steps: back };
}

/* Athena band for a route. Unscored ("unknown") segments are NOT skipped:
 * a route with no scored segments, or mostly unscored by length, is "unknown",
 * never "low". unknownShare is the share of walked metres that are unscored. */
function routeStats(route) {
  const len = route.chainLen;
  let worst = "low", unknownCount = 0, scored = 0, unknownLen = 0;
  const bySeg = new Map(route.segments.map(s => [s.id, s]));
  for (const s of route.segments) {
    if (s.risk_band === "unknown") { unknownCount++; continue; }
    scored++;
    if (BAND_RANK[s.risk_band] > BAND_RANK[worst]) worst = s.risk_band;
  }
  for (const st of route.steps || []) {
    const s = bySeg.get(st.seg);
    if (s && s.risk_band === "unknown") unknownLen += st.len;
  }
  const unknownShare = len > 0 ? unknownLen / len : 0;
  const band = scored === 0 || unknownShare >= 0.5 ? "unknown" : worst;
  return { len, minutes: len / WALK_M_PER_MIN, band, unknownCount, unknownShare };
}

/* Full route triad with the detour bound applied. Returns
 * { shortest, safest, safestNote, balanced } (any may be null). */
function planTriad(graph, startKey, destKey) {
  const shortest = findRoute(graph, startKey, destKey, "shortest");
  const shortMin = shortest ? routeStats(shortest).minutes : 0;
  let safest = null, safestNote = "";
  for (const f of [1, 0.5, 0.25]) {
    const pen = {};
    for (const [band, p] of Object.entries(PROFILES.safest)) pen[band] = p * f;
    const r = findRoute(graph, startKey, destKey, { ...pen, rw: RISK_W.safest * f });
    if (!r) continue;
    if (routeStats(r).minutes - shortMin <= MAX_EXTRA_MIN) {
      safest = r;
      if (f < 1) safestNote =
        `Best risk reduction Athena can offer within a ${MAX_EXTRA_MIN}-minute detour.`;
      break;
    }
  }
  // nothing stayed within the bound: never exceed it, fall back to the fastest route
  if (!safest && shortest) {
    safest = shortest;
    safestNote = `No lower-risk route fits within a ${MAX_EXTRA_MIN}-minute detour, so this is the fastest route.`;
  }
  const balanced = findRoute(graph, startKey, destKey, "balanced");
  return { shortest, safest, safestNote, balanced };
}

// base = epoch ms the walk starts from (the questionnaire's start time); default now
function etaTime(minutes, base) {
  return new Date((base ?? Date.now()) + minutes * 60000)
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/* ===================== preference-aware planner =========================
 * planRoutes() turns the questionnaire's on/off buttons into per-segment
 * walking costs (a cost multiplier on each metre) and returns up to three
 * different routes: Best match, Fastest, Alternative.
 *  - "No stairs" is strict: those segments are removed. Every other button is
 *    soft: it adds cost, and the extra-time limit caps how far it can pull.
 *  - Unknown data is never treated as unsafe. For lighting, "assumed" UK
 *    defaults count as not confirmed (half weight) and unknown as 0.6.
 *  - The Athena crime model only affects ranking when the "crime" button is on.
 * Everything is measured on the metres actually walked (route.steps).
 * ======================================================================= */
const MAIN_CLASSES = new Set(["primary", "secondary", "tertiary"]);
const SIDE_CLASSES = new Set(["residential", "living_street", "unclassified"]);
const SOFT_B = 3.0;          // a fully-violated button makes a metre cost up to 1 + 3 = 4x
const STAIRS_SOFT = 40;      // only used when "No stairs" is relaxed ("Show routes anyway")
const TURN_M = 60;           // walking-metre equivalent of one turn
const TURN_DEG = 35;         // a turn = a direction change this big at a junction
const LIMIT_FACTORS = [1, 0.5, 0.2, 0];    // preference strength tried against the extra-time limit
const SAME_MAX = 0.1;        // routes closer than this (share of metres not shared) count as the same
const DISTINCT_MIN = 0.2;    // an Alternative must differ from the others by at least this
const DEFAULT_EXTRA_MIN = 10;
const SOFT_STRENGTH = { lit: 1, parks: 1, unpaved: 1, slopes: 1, sheltered: 0.4, traffic: 0.8, shared: 0.8,
                        underpass: 1, passage: 1, main: 0.8, quiet: 0.8, nightlife: 1 };
// Buttons the questionnaire shows as "Coming soon": saved, but nothing applies them.
// (Keep in step with prefs.js.)
const SOON_IDS = ["narrow", "crossings", "kerbs", "rest", "staffed", "busy", "isolated"];
/* All route names live here, so changing the wording is one edit. */
const ROUTE_LABELS = { best: "Best match", fastest: "Fastest", alt: "Alternative",
                       both: "Best match · also the fastest" };
// used only when the caller doesn't pass opts.labels (the questionnaire's own labels)
const LABEL_FALLBACK = { lit: "Well-lit (confirmed lighting)", stairs: "No stairs", unpaved: "Avoid unpaved surfaces",
  slopes: "Avoid steep slopes", sheltered: "Prefer sheltered or covered routes",
  parks: "Avoid parks and green spaces", main: "Stay on main streets", quiet: "Stay on quiet side streets",
  traffic: "Avoid paths beside busy roads", shared: "Avoid shared walking and cycling paths",
  underpass: "Avoid underpasses", passage: "Avoid enclosed passages", nightlife: "Avoid nightlife areas",
  crime: "Avoid streets with more recorded crime", shorter: "Shorter walk", further: "Happy to go further",
  turns: "Fewer turns, simpler route" };

/* Facts about one segment that preferences care about. s.surface, s.steep and
 * s.covered come from path_segments.json (null = not mapped); x = the segment's
 * entry in segment_extras.json (may be undefined). */
function segmentAttrs(s, x) {
  const hw = s.highway_type;
  const lit = s.lighting === "no" ? "no"
    : s.lighting === "yes" ? ((s.lighting_source || "").startsWith("assumed") ? "assumed" : "confirmed")
    : "unknown";
  x = x || {};
  return {
    cls: hw === "service" ? "service" : MAIN_CLASSES.has(hw) ? "main" : SIDE_CLASSES.has(hw) ? "side" : "path",
    steps: hw === "steps",
    lit,                                          // confirmed | assumed | unknown | no
    park: x.g || 0,                               // share of the segment inside mapped green space
    unpaved: s.surface === "unpaved" ? true : s.surface === "paved" ? false : null,   // null = surface not mapped
    // "steep" in the data also flags most stairs (OSM puts up/down tags on steps);
    // stairs have their own button, so slopes here means non-stair paths only.
    steep: s.steep === true && hw !== "steps",
    covered: s.covered === true,                  // mapped as covered, or a tunnel
    underpass: !!x.up, passage: !!x.ps, shared: x.sh || 0,        // shared: 1 = shared, 2 = segregated
    mainRoad: !!x.mr, crossing: !!x.cx,
    nightlife: s.nightlife_venues_250m || 0,
  };
}

/* Attach segment_extras.json (or null) to a graph. Safe to call with null:
 * the extras-based buttons then simply find nothing. */
function attachExtras(graph, extras) {
  const seg = (extras && extras.seg) || {};
  graph.extras = extras || null;
  graph.attrs = new Map();
  for (const [id, s] of graph.byId) graph.attrs.set(id, segmentAttrs(s, seg[id]));
  return graph;
}

function buildWeights(prefs, opts) {
  const on = (prefs && prefs.on) || {};
  const w = { soft: {}, hardStairs: false, stairsSoft: false, turns: 0, crime: !!on.crime,
              K: on.shorter ? 0.5 : 1, noLimit: !!on.further, soon: SOON_IDS.filter(id => on[id]) };
  for (const id of Object.keys(SOFT_STRENGTH)) if (on[id]) w.soft[id] = SOFT_STRENGTH[id];
  if (on.stairs) { if (opts && opts.relaxHard) w.stairsSoft = true; else w.hardStairs = true; }
  if (on.turns) w.turns = TURN_M;
  w.hasSoft = Object.keys(w.soft).length > 0 || w.turns > 0 || w.crime || w.stairsSoft;
  return w;
}
const FASTEST_W = { soft: {}, hardStairs: false, stairsSoft: false, turns: 0, crime: false, K: 1 };

// Recorded-crime cost per metre (only when the "recorded crime" button is on).
// Based on the recorded count itself, spread over the segment's length (a short
// street with many records costs more per metre than a long one with a few), so
// the ranking agrees with the count shown on the route card. Segments are never
// penalised for being unscored, only for crimes actually recorded on or near them.
const CRIME_K = 6, CRIME_CAP = 150;
function crimeAdd(seg) {
  const c = seg.crime_count_90d || 0;
  return c ? CRIME_K * Math.min(c, CRIME_CAP) / Math.max(seg.length_m || 0, 20) : 0;
}

/* Cost multiplier per segment id. f (0..1) scales how hard preferences pull;
 * f = 0 keeps only hard rules. Infinity = blocked. */
function buildCostTable(graph, w, f) {
  const t = new Map(), S = w.soft;
  for (const [id, seg] of graph.byId) {
    const a = graph.attrs.get(id);
    let add = 0;
    if (S.lit) add += S.lit * (a.lit === "confirmed" ? 0 : a.lit === "assumed" ? 0.5 : a.lit === "unknown" ? 0.6 : 1);
    if (S.parks) add += S.parks * a.park;
    if (S.unpaved && a.unpaved === true) add += S.unpaved;
    if (S.slopes && a.steep) add += S.slopes;
    if (S.sheltered && !a.covered) add += S.sheltered;    // covered stretches become the cheaper ones
    if (S.traffic && a.mainRoad) add += S.traffic;
    if (S.shared && a.shared) add += S.shared * (a.shared === 2 ? 0.5 : 1);
    if (S.underpass && a.underpass) add += S.underpass;
    if (S.passage && a.passage) add += S.passage;
    if (S.main && a.cls !== "main") add += S.main * (a.cls === "service" ? 0.5 : 1);
    if (S.quiet && a.cls === "main") add += S.quiet;
    if (S.nightlife && a.nightlife) add += S.nightlife * Math.min(1, a.nightlife / 6);
    let m = 1 + SOFT_B * w.K * f * add;
    if (w.stairsSoft && a.steps) m += STAIRS_SOFT * f;
    if (w.crime) m += f * crimeAdd(seg);
    if (a.cls === "service") m *= SERVICE_MULT;
    if (w.hardStairs && a.steps) m = Infinity;
    t.set(id, m);
  }
  return t;
}

function bearing(a, b) {
  const r = Math.PI / 180;
  return Math.atan2((b[1] - a[1]) * r * Math.cos(a[0] * r), (b[0] - a[0]) * r) / r;
}
/* A turn is a direction change of TURN_DEG or more at a junction (a node where
 * the route could have gone elsewhere). Bends along a single way don't count. */
function isTurn(graph, p, u, v) {
  const nu = graph.nodes.get(u);
  if (nu.adj.length < 3) return false;
  let d = Math.abs(bearing(nu.c, graph.nodes.get(v).c) - bearing(graph.nodes.get(p).c, nu.c));
  if (d > 180) d = 360 - d;
  return d >= TURN_DEG;
}
function countTurns(graph, steps) {
  let n = 0;
  for (let i = 1; i < steps.length; i++) if (isTurn(graph, steps[i - 1].from, steps[i].from, steps[i].to)) n++;
  return n;
}

/* A* over a cost table (multipliers are >= 1, so straight-line distance never
 * overestimates). turnM > 0 adds a turn penalty, which needs one search state
 * per (node, previous node). Returns { segments, chainLen, steps } or null. */
function searchRoute(graph, startKey, destKey, table, turnM) {
  const useTurns = turnM > 0;
  const destC = graph.nodes.get(destKey).c;
  const h = (k) => distM(graph.nodes.get(k).c, destC);
  const s0 = useTurns ? startKey + ">" : startKey;
  const dist = new Map([[s0, 0]]), prev = new Map(), done = new Set();
  const heap = new MinHeap();
  // heap items: [priority, state, node, previous node, cost so far, bearing we arrived on]
  heap.push([h(startKey), s0, startKey, null, 0, 0]);
  let endState = null;
  while (heap.size) {
    const [, st, u, pu, g, inB] = heap.pop();
    if (done.has(st)) continue;
    done.add(st);
    if (u === destKey) { endState = st; break; }
    const nu = graph.nodes.get(u);
    const junction = nu.adj.length >= 3;        // only junctions can count as turns
    for (const e of nu.adj) {
      const m = table.get(e.seg);
      if (m === Infinity) continue;
      const ns = useTurns ? e.to + ">" + u : e.to;
      if (done.has(ns)) continue;
      let c = e.len * (m === undefined ? 1 : m);
      if (useTurns) {
        if (e.bear === undefined) e.bear = bearing(nu.c, graph.nodes.get(e.to).c);   // cached on the edge
        if (pu !== null && junction) {
          let d = Math.abs(e.bear - inB);
          if (d > 180) d = 360 - d;
          if (d >= TURN_DEG) c += turnM;
        }
      }
      const ng = g + c;
      if (ng < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, ng);
        prev.set(ns, { st, from: u, to: e.to, seg: e.seg, len: e.len });
        heap.push([ng + h(e.to), ns, e.to, u, ng, e.bear]);
      }
    }
  }
  if (!endState) return null;
  const back = [];
  for (let cur = endState; cur !== s0;) {
    const p = prev.get(cur);
    back.push({ from: p.from, to: p.to, seg: p.seg, len: p.len });
    cur = p.st;
  }
  back.reverse();
  const segments = [];
  let chainLen = 0, lastSeg = null;
  for (const st of back) {
    chainLen += st.len;
    if (st.seg !== lastSeg) { segments.push(graph.byId.get(st.seg)); lastSeg = st.seg; }
  }
  return { segments, chainLen, steps: back };
}

const minutesOf = (r) => r.chainLen / WALK_M_PER_MIN;
const edgeKey = (s) => (s.from < s.to ? s.from + "|" + s.to : s.to + "|" + s.from);
/* 0 = identical, 1 = nothing in common (share of the longer route's metres not shared). */
function routeDistance(a, b) {
  const kb = new Set(b.steps.map(edgeKey));
  let shared = 0;
  for (const s of a.steps) if (kb.has(edgeKey(s))) shared += s.len;
  return 1 - shared / Math.max(a.chainLen, b.chainLen, 1);
}

/* Everything measurable about a route, in metres actually walked. */
function analyseRoute(graph, route) {
  const m = { lenM: route.chainLen, minutes: minutesOf(route),
    cls: { main: 0, side: 0, path: 0, service: 0 }, lit: { confirmed: 0, assumed: 0, unknown: 0, no: 0 },
    band: { low: 0, medium: 0, high: 0, unknown: 0 },
    parkM: 0, stairsSegs: 0, stairsM: 0, unpavedM: 0, surfaceKnownM: 0, steepM: 0, coveredM: 0, underpassM: 0, passageM: 0,
    sharedM: 0, mainRoadM: 0, nightlifeM: 0, tideM: 0, crossings: 0,
    turns: countTurns(graph, route.steps), crime90: 0, crimeTop: null };
  const seen = new Set();
  for (const st of route.steps) {
    const seg = graph.byId.get(st.seg), a = graph.attrs.get(st.seg), L = st.len;
    m.cls[a.cls] += L; m.lit[a.lit] += L; m.band[seg.risk_band] += L; m.parkM += L * a.park;
    if (a.steps) m.stairsM += L;
    if (a.unpaved !== null) { m.surfaceKnownM += L; if (a.unpaved) m.unpavedM += L; }
    if (a.steep) m.steepM += L;
    if (a.covered) m.coveredM += L;
    if (a.underpass) m.underpassM += L;
    if (a.passage) m.passageM += L;
    if (a.shared) m.sharedM += L;
    if (a.mainRoad) m.mainRoadM += L;
    if (a.nightlife >= 3) m.nightlifeM += L;
    if (seg.tide_exposed) m.tideM += L;
    if (!seen.has(st.seg)) {
      seen.add(st.seg);
      if (a.steps) m.stairsSegs++;
      if (a.crossing) m.crossings++;
      const c = seg.crime_count_90d || 0;
      m.crime90 += c;
      if (c > 0 && (!m.crimeTop || c > m.crimeTop.count)) {
        m.crimeTop = { name: seg.name === "unnamed path" ? null : seg.name, count: c, month: seg.last_crime_month };
      }
    }
  }
  return m;
}

/* How well one route matches the buttons that are on. Each item:
 * { id, label, status: matched | partly | unknown | missed | na, detail }.
 * Built only from the route's own measurements, so it can't overclaim. */
function buildReport(on, m, fm, ctx) {
  const L = Math.max(m.lenM, 1), items = [];
  const lab = (id) => (ctx.labels && ctx.labels[id]) || LABEL_FALLBACK[id] || id;
  const add = (id, status, detail) => items.push({ id, label: lab(id), status, detail });
  const pc = (x) => Math.round(x * 100) + "%";
  const mn = (x) => Math.round(x);

  if (on.lit) {
    const conf = m.lit.confirmed / L, no = m.lit.no / L, unconf = (m.lit.assumed + m.lit.unknown) / L;
    let d = `Lighting confirmed on ${pc(conf)} of this route` + (no >= 0.005 ? `, mapped as unlit on ${pc(no)}` : "") +
      `; ${pc(unconf)} unconfirmed.`;
    const status = no >= 0.1 ? "missed" : conf >= 0.8 ? "matched" : conf >= 0.4 ? "partly" : "unknown";
    if (status === "unknown") d += " Unconfirmed isn't the same as dark.";
    add("lit", status, d);
  }
  if (on.stairs) {
    add("stairs", m.stairsSegs === 0 ? "matched" : "missed", m.stairsSegs === 0
      ? "No known stairs on this route (based on mapped steps)."
      : `Uses ${m.stairsSegs} set${m.stairsSegs > 1 ? "s" : ""} of mapped steps.`);
  }
  if (on.unpaved) {
    const known = m.surfaceKnownM / L;
    if (m.unpavedM >= 5) add("unpaved", m.unpavedM / L >= 0.1 ? "missed" : "partly", `${mn(m.unpavedM)} m is mapped as unpaved or uneven.`);
    else if (known < 0.5) add("unpaved", "unknown", `Surface isn't mapped for most of this route (known for ${pc(known)}).`);
    else add("unpaved", "matched", `No unpaved surface mapped (surface known for ${pc(known)}).`);
  }
  if (on.slopes) {
    // slopes are mapped on very few paths, so "none found" is unknown rather than a clean pass
    if (m.steepM >= 5) add("slopes", m.steepM / L >= 0.1 ? "missed" : "partly", `${mn(m.steepM)} m has a mapped incline.`);
    else add("slopes", "unknown", "No mapped incline on this route, but slopes are mapped on very few paths (about 2%).");
  }
  if (on.sheltered) {
    if (m.coveredM >= 20) add("sheltered", m.coveredM / L >= 0.2 ? "matched" : "partly", `${mn(m.coveredM)} m is under mapped cover (covered or a tunnel).`);
    else add("sheltered", "unknown", "No covered section mapped on this route. Very little cover is mapped.");
  }
  if (on.parks) {
    const share = m.parkM / L;
    let status = share <= 0.02 ? "matched" : m.parkM < fm.parkM * 0.5 ? "partly" : "missed";
    let d = share <= 0.02 ? "No mapped green space on this route." : `${mn(m.parkM)} m is inside mapped green space.`;
    if (share > 0.02 && ctx.parkProbe) {
      if (ctx.parkProbe.parkM >= m.parkM * 0.9) d += " Every route we found uses about this much, so it can't be avoided on this journey.";
      else if (ctx.limit !== null) d += ` Avoiding more would add about ${mn(ctx.parkProbe.extraMin)} min (your limit is ${ctx.limit}).`;
    }
    add("parks", status, d);
  }
  if (on.traffic) {
    const s = m.mainRoadM / L;
    add("traffic", s <= 0.05 ? "matched" : s >= 0.4 ? "missed" : "partly",
      s <= 0.05 ? "No sections mapped beside main roads."
        : `${pc(s)} runs beside a main road (estimated from distance, not measured traffic).`);
  }
  if (on.shared) add("shared", m.sharedM < 5 ? "matched" : "partly", m.sharedM < 5
    ? "No shared walking and cycling paths mapped." : `${mn(m.sharedM)} m is on a shared walking and cycling path.`);
  if (on.underpass) add("underpass", m.underpassM < 5 ? "matched" : "partly", m.underpassM < 5
    ? "No underpasses mapped." : `${mn(m.underpassM)} m is in a mapped underpass.`);
  if (on.passage) add("passage", m.passageM < 5 ? "matched" : "partly", m.passageM < 5
    ? "No enclosed passages mapped." : `${mn(m.passageM)} m is in a mapped enclosed passage.`);
  if (on.main) {
    const s = m.cls.main / L;
    add("main", s >= 0.6 ? "matched" : s >= 0.3 ? "partly" : "missed", `${pc(s)} of this route is on main roads.`);
  }
  if (on.quiet) {
    const s = m.cls.main / L;
    add("quiet", s <= 0.15 ? "matched" : s <= 0.4 ? "partly" : "missed", `${pc(s)} of this route is on main roads; the rest is side streets and paths.`);
  }
  if (on.nightlife) add("nightlife", m.nightlifeM < 5 ? "matched" : "partly", m.nightlifeM < 5
    ? "Passes no mapped pubs, bars or clubs closely." : `${mn(m.nightlifeM)} m is near several mapped pubs, bars or clubs.`);
  if (on.crime) {
    const c = m.crime90, fc = fm.crime90;
    const top = m.crimeTop ? `, most on or near ${m.crimeTop.name ? m.crimeTop.name : "an unnamed path"}` : "";
    add("crime", c < fc ? "matched" : c === fc ? "partly" : "missed",
      `${c} recorded street crime${c === 1 ? "" : "s"} on or near this route in the last 3 months${top} (whole streets, Police UK).`);
  }
  if (on.shorter) {
    const ex = m.minutes - fm.minutes;
    add("shorter", ex <= 1 ? "matched" : ex <= 3 ? "partly" : "missed",
      ex <= 1 ? "About as quick as the fastest route." : `About ${mn(ex)} min longer than the fastest route.`);
  }
  if (on.turns) add("turns", m.turns <= fm.turns ? "matched" : "missed",
    `${m.turns} turn${m.turns === 1 ? "" : "s"} at junctions (the fastest route has ${fm.turns}).`);
  if (on.further) add("further", "matched", "No extra-time limit, so your other choices came first.");
  for (const id of ctx.soon || []) add(id, "na", "Not applied yet: we don't have this data. Saved for later.");
  return items;
}

/* The planner. prefs = { on:{...}, extraMin } from prefs.js (or null).
 * opts: { relaxHard, labels }. Returns
 *   { ok:true, routes:[{role,label,route,metrics,extraMin,report}], notes, limit }
 *   { ok:false, reason:"no-route" }
 *   { ok:false, reason:"requirement", unmet:[...] }  (e.g. no stairs-free route exists) */
function planRoutes(graph, startKey, destKey, prefs, opts) {
  opts = opts || {};
  if (!graph.attrs) attachExtras(graph, null);
  const p = prefs || {}, on = p.on || {};
  const W = buildWeights(p, opts);
  const limit = W.noLimit || p.extraMin === null ? null : (p.extraMin ?? DEFAULT_EXTRA_MIN);

  const fastest = searchRoute(graph, startKey, destKey, buildCostTable(graph, FASTEST_W, 0), 0);
  if (!fastest) return { ok: false, reason: "no-route", routes: [], notes: [], unmet: [] };
  const fMin = minutesOf(fastest);
  const extraOf = (r) => minutesOf(r) - fMin;
  const fits = (r) => limit === null || extraOf(r) <= limit + 1e-9;
  const notes = [];

  // fastest route that still obeys the hard rule(s)
  let constrained = fastest;
  if (W.hardStairs) {
    constrained = searchRoute(graph, startKey, destKey, buildCostTable(graph, W, 0), 0);
    if (!constrained) return { ok: false, reason: "requirement", unmet: ["stairs"], routes: [], notes: [] };
  }

  // best match: the strongest preference pull that still fits the extra-time limit
  let best = constrained, f = 0;
  if (W.hasSoft) {
    best = null;
    for (const ff of LIMIT_FACTORS) {
      const cand = ff === 0 ? constrained
        : searchRoute(graph, startKey, destKey, buildCostTable(graph, W, ff), W.turns * ff);
      if (cand && fits(cand)) { best = cand; f = ff; break; }
    }
    if (!best) { best = constrained; f = 0; }
  }
  const bestExceeds = !fits(best);

  // alternative: a different way, found by discouraging the segments the others use
  let alt = null;
  const used = new Set([...best.steps, ...fastest.steps].map(s => s.seg));
  const fa = f > 0 ? Math.min(f, 0.5) : (W.hasSoft ? 0.2 : 0);
  for (const pen of [1.5, 3]) {
    const tbl = buildCostTable(graph, W, fa);
    for (const id of used) { const v = tbl.get(id); if (v !== Infinity) tbl.set(id, v * (1 + pen)); }
    const cand = searchRoute(graph, startKey, destKey, tbl, 0);     // no turn penalty: it only needs to be a different way
    if (cand && fits(cand) && routeDistance(cand, best) >= DISTINCT_MIN && routeDistance(cand, fastest) >= DISTINCT_MIN) {
      alt = cand; break;
    }
  }

  const same = routeDistance(best, fastest) < SAME_MAX;
  const picks = same ? [{ role: "both", route: best }]
    : [{ role: "best", route: best }, { role: "fastest", route: fastest }];
  if (alt) picks.push({ role: "alt", route: alt });

  const fm = analyseRoute(graph, fastest);
  const routes = picks.map(pk => ({ role: pk.role, label: ROUTE_LABELS[pk.role], route: pk.route,
    metrics: pk.route === fastest ? fm : analyseRoute(graph, pk.route) }));

  // can parks be avoided at all on this journey? (only worth a search if they matter)
  let parkProbe = null;
  if (on.parks && routes.some(r => r.metrics.parkM > 20)) {
    const pw = { ...FASTEST_W, soft: { parks: 20 }, hardStairs: W.hardStairs, K: 1 };
    const pr = searchRoute(graph, startKey, destKey, buildCostTable(graph, pw, 1), 0);
    if (pr) parkProbe = { parkM: analyseRoute(graph, pr).parkM, extraMin: extraOf(pr) };
  }

  const ctx = { limit, parkProbe, labels: opts.labels || {}, soon: W.soon };
  for (const r of routes) {
    r.extraMin = r.metrics.minutes - fm.minutes;
    r.report = buildReport(on, r.metrics, fm, ctx);
  }

  if (bestExceeds) {
    notes.push(`Meeting your "No stairs" requirement needs about ${Math.round(extraOf(best))} min extra, more than your ${limit}-minute limit. It's shown anyway because it's a requirement.`);
  } else if (W.hasSoft && f === 0) {
    notes.push(`Within your ${limit === null ? "no" : limit + "-minute"} extra-time limit, no route matches your choices better than the fastest.`);
  } else if (W.hasSoft && f < 1) {
    notes.push(`This is the best match within your ${limit}-minute extra-time limit; some choices are only partly met.`);
  }
  return { ok: true, routes, notes, limit };
}

/* ----------------------- plain-English explanation ---------------------
 * LEGACY text for the old Safest/Shortest/Balanced triad (kept for
 * test_core.js; the app now uses planRoutes + the match list below).
 * Template-based, deterministic. All crime numbers are real Police UK data.
 * Returns HTML-SAFE text: street and place names are escaped, so the result
 * can go into innerHTML. Safety and honesty notes come first and are never
 * cut; lower-priority lines (crime counts, havens) are dropped first.
 * --------------------------------------------------------------------- */
function explain(route, altRoutes, crimes, havens, label) {
  const st = routeStats(route);
  const segIds = new Set(route.segments.map(s => s.id));
  const parts = [];

  const shortest = altRoutes.find(r => r.label === "Shortest");
  if (shortest && label !== "Shortest") {
    const dMin = Math.round(st.minutes - routeStats(shortest.route).minutes);
    const lead = label === "Safest" ? "Prefers streets with confirmed lighting" : "Balances distance and recorded crime";
    parts.push(dMin < 3
      ? `${lead}, for much the same walking time as the shortest option.`
      : `${lead}; about ${dMin} min longer than the shortest option.`);
  } else {
    parts.push("The most direct route Athena found.");
  }

  // what this route avoids vs the shortest route
  if (shortest && label !== "Shortest") {
    const avoided = shortest.route.segments.filter(s => !segIds.has(s.id) &&
      (s.risk_band === "high" || s.risk_band === "unknown"));
    if (avoided.length) {
      const s = avoided[0];
      const what = s.lighting === "no" ? "unlit" :
        (s.lighting === "unknown" ? "no-lighting-data" : "higher-risk");
      const nm = s.name === "unnamed path" ? "path" : esc(s.name) +
        ((s.highway_type === "footway" || s.highway_type === "path") ? " path" : "");
      parts.push(`Avoids the ${what} ${nm}.`);
    }
  }

  // unknowns: the honesty case (kept ahead of the optional lines)
  if (st.unknownCount > 0) {
    parts.push(`${st.unknownCount} segment${st.unknownCount > 1 ? "s" : ""} on this ` +
      `route have no lighting data — risk unknown there.`);
  }

  // tidal paths
  const tidal = route.segments.find(s => s.tide_exposed);
  if (tidal) parts.push("Part of this route is near tidal water, where low-lying paths can flood at high tide.");

  // honesty: if the safest option doesn't actually reduce exposure, say so
  if (label === "Safest" && shortest) {
    const exposure = (rr) => rr.segments.reduce((t, s) => t + (s.crime_count_90d || 0), 0);
    if (exposure(route) >= exposure(shortest.route))
      parts.push("In this area reported crime is similar on all reasonable options — Athena cannot reduce it further here.");
  }

  // real crime history on this route (Police UK)
  const withCrime = route.segments.filter(s => s.crime_count_90d > 0)
    .sort((a, b) => b.crime_count_90d - a.crime_count_90d);
  if (withCrime.length) {
    const s = withCrime[0];
    const nm = s.name === "unnamed path" ? "this route" : esc(s.name);
    parts.push(`${s.crime_count_90d} street crime${s.crime_count_90d > 1 ? "s were" : " was"} reported on or near ` +
      `${nm} in the last 3 months (Police UK, to ${esc(s.last_crime_month)}).`);
  }

  // safe havens (lowest priority)
  const near = havens.filter(h => route.segments.some(s =>
    s.coordinates.some(c => distM(c, [h.lat, h.lng]) < 150)));
  const haven = near.find(h => /24\/7/.test(h.hours)) || near[0];
  if (haven) parts.push(`Passes ${esc(haven.name)}${/24\/7/.test(haven.hours) ? " (listed as staffed 24/7)" : ""}.`);

  return parts.slice(0, 5).join(" ");
}

/* ---- Step-by-step directions for the route we chose --------------------
 * Built in the app from our own route, so nothing is rerouted. Hops are grouped
 * by street name; unnamed ways get a plain name ("the footpath"), tiny hops are
 * folded into their neighbours, and turns are judged from the walking
 * direction just before and just after each junction (not the whole chord). */
function bearingDeg(a, b) {
  const d2r = Math.PI / 180;
  const la1 = a[0] * d2r, la2 = b[0] * d2r, dlo = (b[1] - a[1]) * d2r;
  const y = Math.sin(dlo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m / 5) * 5 || Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }

const WAY_NAME = { pedestrian: "the pedestrian street", footway: "the footpath", path: "the path",
  cycleway: "the cycle path", service: "the service road", living_street: "the road", track: "the track",
  steps: "the steps", corridor: "the passage", bridleway: "the bridleway" };
const wayName = (seg) => {
  const n = seg && seg.name;
  if (n && n !== "unnamed path") return { name: n, generic: false, steps: seg.highway_type === "steps" };
  const t = seg && seg.highway_type;
  return { name: WAY_NAME[t] || "the road", generic: true, steps: t === "steps" };
};
const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const TBT_TINY_M = 15, TBT_LOOK_M = 20;

function turnByTurn(graph, route) {
  if (!route || !route.steps.length) return [{ lead: "", name: "", dist: 0, text: "Start and destination are the same place" }];
  // 1. one group per run of hops with the same name
  let groups = [];
  for (const st of route.steps) {
    const w = wayName(graph.byId.get(st.seg));
    const c0 = graph.nodes.get(st.from).c, c1 = graph.nodes.get(st.to).c;
    const g = groups[groups.length - 1];
    if (g && g.name === w.name && g.steps === w.steps) { g.dist += st.len; g.pts.push(c1); }
    else groups.push({ name: w.name, generic: w.generic, steps: w.steps, dist: st.len, pts: [c0, c1] });
  }
  // 2. fold tiny non-step groups into a neighbour, then re-merge equal names
  const fold = () => {
    for (let i = 0; i < groups.length && groups.length > 1; i++) {
      const g = groups[i];
      if (g.dist >= TBT_TINY_M || g.steps) continue;
      const into = i > 0 ? groups[i - 1] : groups[i + 1];
      if (i > 0) { into.dist += g.dist; into.pts = into.pts.concat(g.pts.slice(1)); }
      else { into.dist += g.dist; into.pts = g.pts.slice(0, -1).concat(into.pts); }
      groups.splice(i, 1); return true;
    }
    return false;
  };
  while (fold()) { /* repeat until nothing tiny is left */ }
  const merged = [];
  for (const g of groups) {
    const p = merged[merged.length - 1];
    if (p && p.name === g.name && p.steps === g.steps) { p.dist += g.dist; p.pts = p.pts.concat(g.pts.slice(1)); }
    else merged.push(g);
  }
  // 3. walking direction just after the start of a group / just before its end
  const pathLen = (pts, i, j) => { let d = 0; for (let k = i; k < j; k++) d += distM(pts[k], pts[k + 1]); return d; };
  const dirOut = (g) => { let j = 1; while (j < g.pts.length - 1 && pathLen(g.pts, 0, j) < TBT_LOOK_M) j++; return bearingDeg(g.pts[0], g.pts[j]); };
  const dirIn = (g) => { const n = g.pts.length - 1; let i = n - 1; while (i > 0 && pathLen(g.pts, i, n) < TBT_LOOK_M) i--; return bearingDeg(g.pts[i], g.pts[n]); };
  const out = [];
  merged.forEach((g, i) => {
    let lead;
    if (g.steps) lead = "Take";
    else if (i === 0) lead = `Head ${COMPASS[Math.round(dirOut(g) / 45) % 8]} on`;
    else {
      const delta = ((dirOut(g) - dirIn(merged[i - 1]) + 540) % 360) - 180, a = Math.abs(delta);
      const side = delta > 0 ? "right" : "left";
      lead = a < 30 ? "Continue onto" : a < 60 ? `Bear ${side} onto` : a < 135 ? `Turn ${side} onto` : `Turn sharp ${side} onto`;
    }
    out.push({ lead, name: g.name, dist: g.dist, text: `${lead} ${g.name} — ${fmtDist(g.dist)}` });
  });
  out.push({ lead: "", name: "", dist: 0, text: "Arrive at your destination" });
  return out;
}

/* ---- Handing the route to Google Maps ----------------------------------
 * Google's link takes a start, an end and a few stops, and then picks its own
 * path between them, so two pins alone often give a different walk. We add the
 * fewest stops that make Google's likely path match ours: pretend Google takes
 * the shortest walk between the points (our own street map stands in for
 * Google's), find where that pretend route leaves ours, and pin the middle of
 * the longest stretch that is off. Repeat until it matches or the stop budget
 * is used. Google allows 3 stops in a phone browser and 9 elsewhere. */
const GMAPS_STOPS_PHONE = 3, GMAPS_STOPS_DESKTOP = 9, GMAPS_MIN_OFF_M = 50;
const onPhoneBrowser = () => typeof navigator !== "undefined" &&
  (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") ||
   (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform || "")));

function gmapsHandoff(graph, route, origin, dest, opts) {
  opts = opts || {};
  const maxStops = opts.maxStops ?? (onPhoneBrowser() ? GMAPS_STOPS_PHONE : GMAPS_STOPS_DESKTOP);
  if (!route || !route.steps.length) return { url: "https://www.google.com/maps", stops: [], matchPct: 100, complete: true, maxStops };
  if (!graph.attrs) attachExtras(graph, null);
  const steps = route.steps;
  const nodes = [steps[0].from].concat(steps.map(s => s.to));
  const cum = [0];
  for (const s of steps) cum.push(cum[cum.length - 1] + s.len);
  const table = graph._plainTable || (graph._plainTable = buildCostTable(graph, FASTEST_W, 0));
  const legs = new Map();
  const leg = (a, b) => {
    const k = a + ">" + b;
    if (!legs.has(k)) legs.set(k, a === b ? null : searchRoute(graph, a, b, table, 0));
    return legs.get(k);
  };
  // how much of our route would a "shortest walk between the points" reproduce?
  const evaluate = (idx) => {
    const pts = [0].concat(idx, [nodes.length - 1]), theirs = new Set();
    for (let k = 0; k < pts.length - 1; k++) {
      const r = leg(nodes[pts[k]], nodes[pts[k + 1]]);
      if (r) for (const s of r.steps) theirs.add(edgeKey(s));
    }
    let match = 0, run = null, worst = null;
    steps.forEach((s, i) => {
      if (theirs.has(edgeKey(s))) { match += s.len; run = null; return; }
      if (!run) run = { a: i, b: i, len: 0 };
      run.b = i; run.len += s.len;
      if (!worst || run.len > worst.len) worst = run;
    });
    return { match, worst };
  };
  const stops = [];
  let ev = evaluate(stops);
  while (stops.length < maxStops && ev.worst && ev.worst.len >= GMAPS_MIN_OFF_M) {
    const mid = (cum[ev.worst.a] + cum[ev.worst.b + 1]) / 2;
    let pick = -1;
    for (let i = ev.worst.a; i <= ev.worst.b + 1; i++) {
      if (i === 0 || i === nodes.length - 1 || stops.includes(i)) continue;
      if (pick < 0 || Math.abs(cum[i] - mid) < Math.abs(cum[pick] - mid)) pick = i;
    }
    if (pick < 0) break;
    stops.push(pick); stops.sort((x, y) => x - y);
    ev = evaluate(stops);
  }
  const ll = (c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  const stopLL = stops.map(i => graph.nodes.get(nodes[i]).c);
  const q = new URLSearchParams({
    api: "1", origin: ll(origin || graph.nodes.get(nodes[0]).c),
    destination: ll(dest || graph.nodes.get(nodes[nodes.length - 1]).c), travelmode: "walking",
  });
  if (stopLL.length) q.set("waypoints", stopLL.map(ll).join("|"));
  return { url: "https://www.google.com/maps/dir/?" + q.toString(), stops: stopLL, maxStops,
    matchPct: Math.round(100 * ev.match / Math.max(route.chainLen, 1)),
    complete: !ev.worst || ev.worst.len < GMAPS_MIN_OFF_M };
}
/* Origin and destination ([lat, lng]) are the person's own points when given. */
function routeToGmapsUrl(graph, route, origin, dest, opts) { return gmapsHandoff(graph, route, origin, dest, opts).url; }
// older call shape, kept so existing callers keep working
const gmapsUrl = (route, origin, dest, graph) => routeToGmapsUrl(graph, route, origin, dest);

/* ----------------------------- exports -------------------------------- */
if (typeof module !== "undefined") {
  module.exports = { buildGraph, snap, findRoute, routeStats, explain,
                     gmapsUrl, distM, PRESETS, PROFILES, MAX_EXTRA_MIN,
                     planTriad, routeToGmapsUrl, gmapsHandoff, turnByTurn, etaTime, attachExtras, segmentAttrs, buildWeights, buildCostTable,
                     searchRoute, analyseRoute, buildReport, planRoutes, routeDistance,
                     countTurns, ROUTE_LABELS, SOON_IDS, DEFAULT_EXTRA_MIN };
}

/* ============================ browser UI =============================== */
if (typeof document !== "undefined") (async function () {
  const showErr = (label, err) => {
    const msg = String(err && (err.message || err));
    console.error(label, err);
    if (/ResizeObserver|Script error/i.test(msg)) return;      // harmless browser noise
    const el = document.getElementById("status");
    if (el) el.textContent = `${label}: ${msg}`;
  };
  window.addEventListener("error", (e) => showErr("Error", e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => showErr("Async error", e.reason));

  const $ = (id) => document.getElementById(id);
  // "no-cache" = always check with the server (a cheap 304 if unchanged), so a
  // browser never keeps showing an older data build after the data is updated
  const load = (p) => fetch(p, { cache: "no-cache" }).then(r => r.json());
  const [segments, crimes, havens, model, liveSnapshot, manifest, basemap, extras] = await Promise.all([
    load("data/path_segments.json"), load("data/incidents.json"),
    load("data/safe_havens.json"), load("data/model.json").catch(() => null),
    load("data/live_check.json").catch(() => null),
    load("data/data_manifest.json").catch(() => null),
    load("data/basemap.geojson").catch(() => null),
    load("data/segment_extras.json").catch(() => null),     // preference data; routes still work without it
  ]);
  // tiny DOM helper: text goes in as text nodes, never as HTML
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };

  /* map */
  const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([50.9195, -1.4045], 13);
  L.control.attribution({ prefix: false })
    .addAttribution("basemap &copy; OpenStreetMap contributors (ODbL) · crime: Police UK (OGL v3) · search: Nominatim")
    .addTo(map);

  /* self-contained GeoJSON basemap: no third-party tile server, no API key.
     Water, parks and rail from the same OSM build that feeds Athena. */
  const BASE_STYLE = {
    water: { color: "#16324f", weight: 1.5, fill: true, fillColor: "#101f35", fillOpacity: 0.9 },
    green: { color: "#16281e", weight: 0, fill: true, fillColor: "#111f18", fillOpacity: 0.9 },
    rail:  { color: "#262e3a", weight: 2, dashArray: "10 7", fill: false, fillOpacity: 0 },
  };
  const basemapLayer = L.layerGroup().addTo(map);
  if (basemap && basemap.features) {
    for (const f of basemap.features) {
      const st = BASE_STYLE[f.properties.kind] || {};
      const toLL = (c) => [c[1], c[0]];
      if (f.geometry.type === "Polygon") {
        const ring = f.geometry.coordinates[0].map(toLL);
        if (ring.length > 3) L.polygon(ring, st).addTo(basemapLayer);
      } else if (f.geometry.type === "LineString") {
        L.polyline(f.geometry.coordinates.map(toLL), st).addTo(basemapLayer);
      }
    }
  }

  /* locate-me control (mobile-first: one tap back to where you are) */
  const LocateControl = L.Control.extend({
    onAdd() {
      const btn = L.DomUtil.create("button", "locate-btn");
      btn.type = "button";
      btn.title = "Show my location";
      btn.setAttribute("aria-label", "Show my location");
      btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (!navigator.geolocation) return;
        btn.classList.add("busy");
        navigator.geolocation.getCurrentPosition(
          (pos) => { map.setView([pos.coords.latitude, pos.coords.longitude], 16); btn.classList.remove("busy"); },
          () => { btn.classList.remove("busy"); },
          { enableHighAccuracy: true, timeout: 10000 });
      });
      return btn;
    },
  });
  new LocateControl({ position: "topleft" }).addTo(map);

  const COLORS = { low: "#10b981", medium: "#f59e0b", high: "#ef4444", unknown: "#5b6673" };
  const segLayer = L.layerGroup().addTo(map);

  function popupHtml(s) {
    const cats = Object.entries(s.crime_categories || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => `${esc(k)} (${v})`).join(", ");
    const rows = [
      ["Risk band", s.risk_band === "unknown" ? "UNKNOWN (no lighting data)" :
        s.risk_band.toUpperCase() + (s.risk_score != null ? ` · model risk ${(s.risk_score*100).toFixed(1)}%/month` : "")],
      ["Lighting", s.lighting === "unknown"
        ? "data unavailable (no OSM lighting survey)"
        : s.lighting + (s.lighting_source.startsWith("assumed") ? " (assumed: UK main-road default)" : " (OSM lit tag)")],
      ["Street crimes (90d)", s.crime_count_90d +
        (s.last_crime_month ? ` (latest ${s.last_crime_month})` : " (none recorded)")],
      ["Crimes (7 months)", s.crime_count_6m + (cats ? `<br>${cats}` : "")],
      ["Isolation score", s.isolation_score + " / 10"],
      ["Tide-exposed", s.tide_exposed ? "yes — can flood at high tide" : "no"],
      ["Nightlife venues ≤250m", s.nightlife_venues_250m],
      ["Length", s.length_m + " m"],
    ];
    return `<b>${esc(s.name)}</b> (${s.id})` +
      `<table>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>` +
      `<p class="pop-note">Sources: OSM geometry & lighting (ODbL) · Police UK ` +
      `street-level crime (OGL v3) · Athena model ${model ? "AUC " + model.evaluation.auc_model : "n/a"}.</p>`;
  }

  const walkable = segments.filter(s => s.highway_type !== "service" && s.length_m >= 10);
  for (const s of walkable) {
    L.polyline(s.coordinates, {
      color: COLORS[s.risk_band],
      weight: s.risk_band === "high" ? 3 : s.risk_band === "unknown" ? 1.5 : 2,
      opacity: s.risk_band === "unknown" ? 0.55 : 0.9,
      dashArray: s.risk_band === "unknown" ? "4 4" : null,
    }).on("click", (e) => {
      L.popup().setLatLng(e.latlng).setContent(popupHtml(s)).openOn(map);
      L.DomEvent.stopPropagation(e);
    }).addTo(segLayer);
  }

  for (const h of havens) {
    L.circleMarker([h.lat, h.lng], {
      radius: 5, color: "#7dd3fc", fillColor: "#7dd3fc", fillOpacity: 0.9,
    }).bindPopup(`<b>Safe haven</b><br>${esc(h.name)}<br>${esc(h.hours)}`).addTo(map);
  }

  /* honesty + model coverage line */
  const counts = { low: 0, medium: 0, high: 0, unknown: 0 };
  walkable.forEach(s => counts[s.risk_band]++);
  const pct = Math.round(counts.unknown / walkable.length * 100);
  const monthSpan = model && model.training ? model.training.test_month : "";
  $("coverage").innerHTML =
    `${walkable.length.toLocaleString()} walking segments · ` +
    `${counts.low.toLocaleString()} low · ${counts.medium.toLocaleString()} medium · ` +
    `${counts.high} high · <b>${counts.unknown.toLocaleString()} unknown</b> ` +
    `(${pct}% have no lighting data — we show it, not hide it).` +
    (model ? `<br><span class="modelcard">Athena model: trained on ${crimes.length.toLocaleString()} ` +
      `real Police UK street crimes (${model.training.train_months[0]}–${model.training.test_month}); ` +
      `AUC ${model.evaluation.auc_model} vs ${model.evaluation.auc_baseline_recent_crime} ` +
      `recency baseline on held-out ${monthSpan}.</span>` : "");

  /* data freshness panel */
  if (manifest) {
    const rows = manifest.sources.map(s =>
      `<tr><td>${esc(s.name)}</td><td>${(s.fetched_at || "").slice(0, 16).replace("T", " ")}</td></tr>`)
      .join("");
    $("sources").innerHTML =
      `<details><summary>Data sources &amp; freshness (click)</summary>` +
      `<table class="src">${rows}</table>` +
      `<p class="hint">Licences: OSM ODbL · Police UK &amp; EA OGL v3 · CARTO tiles.</p></details>`;
  }

  /* LIVE panel: real-time Environment Agency data, fetched in this browser */
  async function refreshLive() {
    const el = $("live");
    try {
      const r = await fetch(`${EA_BASE}/id/stations/${EA_TIDE_GAUGE}/readings?latest`).then(x => x.json());
      const it = r.items[0];
      const level = it.value.toFixed(2);
      const t = new Date(it.dateTime).toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"});
      const fw = await fetch(`${EA_BASE}/id/floods`).then(x => x.json());
      const hants = (fw.items || []).filter(i => (i.countyName || "") === "Hampshire"
        || (i.countyName || "") === "Southampton");
      el.innerHTML = `<span class="livedot"></span> LIVE · EA Woolston tide gauge:
        <b>${level} mAOD</b> at ${t}` +
        (hants.length ? ` · <b style="color:var(--high)">${hants.length} flood warning(s) active in Hampshire</b>`
         : " · no active flood warnings in Hampshire");
    } catch (e) {
      // offline: fall back to the build-time snapshot, clearly dated
      if (liveSnapshot && liveSnapshot.tide_gauge && liveSnapshot.tide_gauge.value != null) {
        el.innerHTML = `EA gauge (snapshot from data build): ` +
          `${liveSnapshot.tide_gauge.value} mAOD at ` +
          `${liveSnapshot.tide_gauge.reading_time.slice(11, 16)}Z` +
          ` — offline, not live`;
      } else {
        el.textContent = "";
      }
    }
  }
  $("live").textContent = "checking live EA data…";
  refreshLive();

  /* destination geocoding: Nominatim (OSM, ODbL), bounded to Southampton */
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const SOTON_VIEWBOX = "-1.48,50.86,-1.33,50.96";   // left,top,right,bottom
  async function geocode(q) {
    const url = `${NOMINATIM}?format=jsonv2&limit=1&accept-language=en` +
      `&countrycodes=gb&viewbox=${SOTON_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url).then(x => x.json());
    return Array.isArray(r) && r[0] ? r[0] : null;
  }
  function setStatus(msg) { $("status").textContent = msg; }

  let clickStart = null, clickCount = 0, markers = [];
  map.on("click", (e) => {
    markers[clickCount] = L.marker([e.latlng.lat, e.latlng.lng], {
      icon: L.divIcon({ className: "", html: `<b style="color:#7dd3fc;font-size:14px">${clickCount === 0 ? "A" : "B"}</b>` }),
    }).addTo(map);
    if (clickCount === 0) clickStart = [e.latlng.lat, e.latlng.lng];
    else {
      planRoute(clickStart, [e.latlng.lat, e.latlng.lng], undefined, false);
      clickCount = -1;
    }
    clickCount++;
  });

  /* routing */
  const graph = attachExtras(buildGraph(segments), extras);
  let routeLayers = [];
  let routeLines = [], routeCards = [], selected = -1;

  function selectRoute(idx) {
    selected = idx;
    routeLines.forEach((l, i) => {
      if (i === idx) l.setStyle({ color: "#7dd3fc", weight: 6, opacity: 1, dashArray: null });
      else l.setStyle({ color: "#e6e6e6", weight: 3, opacity: 0.7, dashArray: "6 6" });
      if (i === idx) l.bringToFront();
    });
    routeCards.forEach((c, i) => {
      c.classList.toggle("selected", i === idx);
      const btn = c.querySelector(".choose");
      if (btn) { btn.disabled = i === idx;
                 btn.textContent = i === idx ? "✓ Chosen" : "Choose this route"; }
    });
  }
  function clearRouteLayers() {
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
    routeLines = []; routeCards = []; selected = -1;
    markers.forEach(m => m && map.removeLayer(m));
    planMarkers.forEach(m => map && map.removeLayer(m));
  }

  let planMarkers = [];
  function setPlanMarkers(fromLL, toLL, aLabel, bLabel) {
    planMarkers.forEach(m => map.removeLayer(m));
    const mk = (ll, letter, name) => L.marker(ll, {
      icon: L.divIcon({ className: "", html:
        `<b style="color:#7dd3fc;font-size:14px">${letter}</b>` }),
    }).bindPopup(`<b>${esc(name || letter)}</b>`).addTo(map);
    planMarkers = [mk(fromLL, "A", aLabel), mk(toLL, "B", bLabel)];
  }

  /* ------------------------------ route cards ------------------------------ */
  const STATUS = { matched: ["✓", "Matched"], partly: ["~", "Partly"], unknown: ["?", "Unknown"],
                   missed: ["✗", "Not met"], na: ["–", "Not applied"] };
  const toggleLabels = Object.fromEntries(
    (window.OdysseyPrefs ? window.OdysseyPrefs.TOGGLES : []).map(t => [t.id, t.label]));
  const dataBuilt = manifest && manifest.generated_at
    ? new Date(manifest.generated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
  let lastPlan = null;           // remembered so changing preferences can re-plan the same trip

  const pctOf = (x, L) => Math.round(100 * x / Math.max(L, 1)) + "%";

  function summaryLine(r) {
    const c = { matched: 0, partly: 0, unknown: 0, missed: 0 };
    r.report.forEach(i => { if (c[i.status] !== undefined) c[i.status]++; });
    const n = c.matched + c.partly + c.unknown + c.missed;
    if (!n) return "Turn on preferences with the ⚙ button to see how each route matches them.";
    return `${c.matched} of ${n} choices matched` + (c.partly ? `, ${c.partly} partly` : "") +
      (c.unknown ? `, ${c.unknown} unknown` : "") + (c.missed ? `, ${c.missed} not met` : "") + ".";
  }

  function matchList(r) {
    if (!r.report.length) return null;
    return h("ul", { class: "match-list" }, ...r.report.map(i => h("li", { class: `match-item st-${i.status}` },
      h("span", { class: "mi-icon", "aria-hidden": "true" }, STATUS[i.status][0]),
      h("span", { class: "mi-body" },
        h("b", { class: "mi-label" }, i.label), " ",
        h("span", { class: "mi-word" }, STATUS[i.status][1]),
        h("span", { class: "mi-detail" }, i.detail)))));
  }

  /* Recorded crime stays information here; it only changes ranking when the
   * "recorded crime" button is on. */
  function infoBlock(r) {
    const m = r.metrics, L = m.lenM;
    const kids = [h("summary", {}, "Route details and recorded crime (info only)")];
    const crime = m.crime90
      ? `${m.crime90} street crime${m.crime90 === 1 ? " was" : "s were"} recorded on or near this route in the last 3 months` +
        (m.crimeTop ? `; most on or near ${m.crimeTop.name || "an unnamed path"} (Police UK, to ${m.crimeTop.month})` : "") + "."
      : "No street crimes were recorded on or near this route in the last 3 months.";
    kids.push(h("p", {}, crime));
    kids.push(h("p", {}, `Athena's risk bands by distance: ${pctOf(m.band.low, L)} lower, ${pctOf(m.band.medium, L)} medium, ` +
      `${pctOf(m.band.high, L)} higher, ${pctOf(m.band.unknown, L)} not scored. Bands are relative to other streets, and a street is ` +
      "rated medium or higher only if crimes were also recorded on it recently. Not scored doesn't mean safe."));
    kids.push(h("p", { class: "hint" }, "Counts cover whole streets, aren't live, and don't show time of day."));
    if (m.tideM > 0) kids.push(h("p", {}, "Part of this route is near tidal water, where low-lying paths can flood at high tide."));
    if (dataBuilt) kids.push(h("p", { class: "hint" }, `Map data built ${dataBuilt}.`));
    return h("details", { class: "info-block" }, ...kids);
  }

  const handoffQueue = [];       // Google stop-finding jobs, run after the cards are drawn
  function buildCard(r, idx, c) {
    const m = r.metrics;
    const extra = r.role === "fastest" ? "" : (Math.round(r.extraMin) >= 1 ? ` · +${Math.round(r.extraMin)} min vs fastest` : " · same time as fastest");
    const card = h("div", { class: "route-card" + (idx === 0 ? " best" : "") },
      h("div", { class: "route-head" }, h("span", { class: "route-title" }, r.label)),
      h("div", { class: "route-meta" }, h("b", {}, `ETA ${etaTime(m.minutes, c.departAt)}`),
        ` · ${Math.round(m.minutes)} min · ${(m.lenM / 1000).toFixed(1)} km${extra}`),
      h("p", { class: "route-explain" }, summaryLine(r)),
      matchList(r));
    if (idx === 0 && window.OdysseyRides) {
      const reasons = window.OdysseyRides.rideReasons(m, c.prefs, c.departAt);
      if (reasons.length) {
        card.append(window.OdysseyRides.banner(reasons, (e) => window.OdysseyRides.openSheet({
          from: c.fromLL, to: c.toLL, destName: c.destName, fromIsGps: c.fromIsGps,
          shareUrl: gmapsHandoff(graph, r.route, c.fromLL, c.toLL).url,
        })));
      }
    }
    // Google link: starts as plain start + end, then gets its stops a moment later
    // (finding them takes a few searches, so the card appears first).
    const gm = h("a", { class: "gmaps", target: "_blank", rel: "noopener noreferrer",
      href: routeToGmapsUrl(graph, r.route, c.fromLL, c.toLL, { maxStops: 0 }) }, "Open in Google Maps");
    const gmNote = h("p", { class: "hint gm-note" }, "");
    handoffQueue.push(() => {
      const hand = gmapsHandoff(graph, r.route, c.fromLL, c.toLL);
      gm.href = hand.url;
      const n = hand.stops.length;
      gmNote.textContent = !hand.complete
        ? `Opens Google Maps with ${n} stop${n === 1 ? "" : "s"}. A phone browser allows only ${hand.maxStops}, so parts of the walk may differ. Use the step-by-step list.`
        : n ? `Opens Google Maps with ${n} stop${n === 1 ? "" : "s"} to keep it on this route. Google picks the exact path between stops, so it can still differ a little.`
        : "Opens Google Maps. Its own route should match this one, but it can still differ a little.";
    });
    const steps = turnByTurn(graph, r.route);
    card.append(infoBlock(r),
      h("details", { class: "tbt" },
        h("summary", {}, `Step-by-step directions (${steps.length - 1} steps)`),
        h("ol", {}, ...steps.map(st => h("li", {}, `${st.lead} ${st.name}`.trim() || st.text,
          st.dist ? h("span", { class: "tbt-d" }, ` — ${fmtDist(st.dist)}`) : null)))),
      h("div", { class: "route-actions" },
        h("button", { class: "choose", "data-i": String(idx) }, "Choose this route"),
        gm,
        h("button", { class: "report", "data-i": String(idx) }, "Report this route")),
      gmNote,
      h("p", { class: "report-msg hidden", id: `msg-${idx}` },
        "Thanks. Saved on this device only; nothing is sent anywhere."));
    return card;
  }

  async function planRoute(fromLL, toLL, destName, fromIsGps, relaxHard) {
    clearRouteLayers();
    handoffQueue.length = 0;
    lastPlan = { fromLL, toLL, destName, fromIsGps, relaxHard: !!relaxHard };
    const routesEl = $("routes");
    routesEl.classList.remove("hidden");
    routesEl.replaceChildren(h("p", { class: "hint" }, "Athena is scoring routes…"));

    setPlanMarkers(fromLL, toLL, fromIsGps ? "Your location" : "Start", destName);
    // let the message paint before the search blocks the page
    await new Promise(res => requestAnimationFrame(() => setTimeout(res, 0)));
    const a = snap(graph, fromLL), b = snap(graph, toLL);
    if (a.dist > 400 || b.dist > 400) {
      routesEl.replaceChildren(h("p", { class: "hint" }, "Start or destination is too far from the walking network — pick a point nearer a street or path."));
      return;
    }
    if (a.key === b.key) {
      routesEl.replaceChildren(h("p", { class: "hint" }, "Start and destination are the same point. Pick two different points on the map."));
      return;
    }
    const prefs = window.OdysseyQuestionnaire ? window.OdysseyQuestionnaire.getPrefs() : null;
    const plan = planRoutes(graph, a.key, b.key, prefs, { labels: toggleLabels, relaxHard });
    if (!plan.ok) {
      if (plan.reason === "requirement") {
        routesEl.replaceChildren(h("div", { class: "route-card" },
          h("p", { class: "route-explain" }, `We cannot confirm a route that meets this requirement: ${toggleLabels.stairs || "No stairs"}.`),
          h("p", { class: "hint" }, "Every walking route we found between these points uses known stairs. " +
            "You can turn the requirement off with the ⚙ button, or see the routes anyway and check which choices they don't meet."),
          h("div", { class: "route-actions" },
            h("button", { onclick: () => planRoute(fromLL, toLL, destName, fromIsGps, true) }, "Show routes anyway"))));
      } else {
        routesEl.replaceChildren(h("p", { class: "hint" }, "No walking route found between those points."));
      }
      return;
    }

    routesEl.replaceChildren();
    if (relaxHard) routesEl.append(h("p", { class: "hint plan-note" }, "These routes don't fully meet “No stairs”. Check each card to see which choices they miss."));
    plan.notes.forEach(n => routesEl.append(h("p", { class: "hint plan-note" }, n)));
    const ctx = { prefs, departAt: window.OdysseyQuestionnaire ? window.OdysseyQuestionnaire.departureMs() : Date.now(),
      fromLL, toLL, destName, fromIsGps };
    plan.routes.forEach((r, idx) => {
      const card = buildCard(r, idx, ctx);
      routesEl.appendChild(card);
      const pts = [graph.nodes.get(r.route.steps[0].from).c]
        .concat(r.route.steps.map(st => graph.nodes.get(st.to).c));
      routeLayers.push(L.polyline(pts, { color: "#0b1220", weight: 9, opacity: 0.6 }).addTo(map));
      const line = L.polyline(pts, {
        color: idx === 0 ? "#7dd3fc" : "#e6e6e6",
        weight: idx === 0 ? 5 : 3, opacity: 0.95, dashArray: idx === 0 ? null : "6 6",
      }).addTo(map);
      routeLayers.push(line);
      routeLines[idx] = line;
      routeCards[idx] = card;
    });
    selectRoute(0);
    map.fitBounds(L.featureGroup(routeLines).getBounds(), { padding: [40, 40] });
    // add the Google stops one card at a time, so the page stays responsive
    const runHandoffs = () => {
      const job = handoffQueue.shift();
      if (job) setTimeout(() => { job(); runHandoffs(); }, 0);
    };
    runHandoffs();

    routesEl.querySelectorAll(".choose").forEach(btn =>
      btn.addEventListener("click", () => selectRoute(+btn.dataset.i)));
    routesEl.querySelectorAll(".report").forEach(btn =>
      btn.addEventListener("click", () => {
        const r = plan.routes[+btn.dataset.i];
        let reports = [];
        try { reports = JSON.parse(localStorage.getItem("odyssey_reports") || "[]"); } catch (e) { reports = []; }
        reports.push({ ts: new Date().toISOString(), route_label: r.label, segment_ids: r.route.segments.map(s => s.id) });
        try { localStorage.setItem("odyssey_reports", JSON.stringify(reports)); } catch (e) { /* storage blocked */ }
        $("msg-" + btn.dataset.i).classList.remove("hidden");
        btn.disabled = true;
      }));
  }

  // changing preferences re-plans the trip on screen
  if (window.OdysseyQuestionnaire && window.OdysseyQuestionnaire.onChange) {
    window.OdysseyQuestionnaire.onChange((p) => {
      if (lastPlan && !$("routes").classList.contains("hidden")) {
        // keep "Show routes anyway" only while "No stairs" is still on
        planRoute(lastPlan.fromLL, lastPlan.toLL, lastPlan.destName, lastPlan.fromIsGps,
          lastPlan.relaxHard && !!(p && p.on && p.on.stairs));
      }
    });
  }

  /* the core flow: type where you're going, start from where you are */
  $("plan").addEventListener("click", async () => {
    const q = $("dest").value.trim();
    if (!q) { setStatus("Type a destination first — e.g. 'Ocean Village' or a street name."); return; }
    setStatus("Searching for that place…");
    let dest = null;
    try { dest = await geocode(q); } catch (e) { /* offline / blocked */ }
    if (!dest) { setStatus("Couldn't find that place in Southampton. Try a street name, landmark, or postcode area."); return; }
    const destLL = [+dest.lat, +dest.lon];
    const destName = (dest.display_name || "").split(",")[0];
    setStatus(`Destination: ${destName}. Getting your location…`);
    if (!navigator.geolocation) {
      setStatus("This browser can't share GPS — click two points on the map instead (start, then destination).");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setStatus(`Heading to ${destName} — Athena is scoring routes…`);
        planRoute([pos.coords.latitude, pos.coords.longitude], destLL, destName, true);
      },
      (err) => {
        setStatus("GPS unavailable (" + err.message + ") — click two points on the map: first your start, then your destination.");
      }, { enableHighAccuracy: true, timeout: 10000 });
  });

  /* SOS: official guidance links, per safety-product best practice */
  $("sos-open").addEventListener("click", () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const ll = `${pos.coords.latitude.toFixed(5)},${pos.coords.longitude.toFixed(5)}`;
        $("sos-location").textContent = `Location: ${ll}`;
        $("sos-copy").onclick = () => navigator.clipboard?.writeText(
          `https://www.google.com/maps?q=${ll}`);
      },
      () => { $("sos-location").textContent = "Location unavailable — enable GPS."; });
    $("sos-overlay").classList.remove("hidden");
  });
  $("sos-close").addEventListener("click", () => $("sos-overlay").classList.add("hidden"));

  /* demo mode: ?demo=1 plans a real route between two points near the University
   * and Portswood, with the default preferences, so the app can be tried (or
   * screenshotted) without GPS or typing. */
  if (new URLSearchParams(location.search).get("demo") === "1") {
    setStatus("Demo mode: a sample walk starting near the University of Southampton (Highfield).");
    planRoute([50.9362, -1.39561], [50.92841, -1.39961], "Demo destination", false);
  }
})();
