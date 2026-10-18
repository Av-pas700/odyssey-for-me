/* Tests for the preference-aware planner, the preferences module and the ride
 * rules. Run from anywhere:  node odyssey-app/test_plan.js
 * Uses the real data in data/ and all 45 pairs of the app's preset places. */
"use strict";
const fs = require("fs");
const path = require("path");
const core = require("./app.js");
const P = require("./prefs.js");
const R = require("./rides.js");

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "data", f)));
const segments = read("path_segments.json");
const extras = read("segment_extras.json");
const graph = core.attachExtras(core.buildGraph(segments), extras);

let fails = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) { fails++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const pairs = [];
for (let i = 0; i < core.PRESETS.length; i++) for (let j = i + 1; j < core.PRESETS.length; j++) {
  pairs.push({ name: `${core.PRESETS[i][0].split(" (")[0]} -> ${core.PRESETS[j][0].split(" (")[0]}`,
    a: core.snap(graph, [core.PRESETS[i][1], core.PRESETS[i][2]]).key,
    b: core.snap(graph, [core.PRESETS[j][1], core.PRESETS[j][2]]).key });
}
console.log(`${segments.length} segments, ${Object.keys(extras.seg).length} with extras, ${pairs.length} preset pairs`);

/* ---- 1. planner invariants for many button combinations ---- */
const SETS = {
  none: { on: {} }, stairs: { on: { stairs: true } }, parks: { on: { parks: true } }, lit: { on: { lit: true } },
  unpaved: { on: { unpaved: true } }, main: { on: { main: true } }, quiet: { on: { quiet: true } },
  traffic: { on: { traffic: true } }, shared: { on: { shared: true } }, underpass: { on: { underpass: true } },
  passage: { on: { passage: true } }, nightlife: { on: { nightlife: true } }, crime: { on: { crime: true } },
  turns: { on: { turns: true } }, shorter: { on: { shorter: true } }, further: { on: { further: true } },
  combo: { on: { lit: true, parks: true, stairs: true, traffic: true, turns: true }, extraMin: 10 },
  limit0: { on: { lit: true, parks: true }, extraMin: 0 },
  furtherCombo: { on: { further: true, parks: true, lit: true } },
  soonOnly: { on: { crossings: true, kerbs: true } },
  slopes: { on: { slopes: true } }, sheltered: { on: { sheltered: true } },
};
const agg = {};
const times = [];
for (const [name, prefs] of Object.entries(SETS)) {
  const on = prefs.on;
  const limit = on.further || prefs.extraMin === null ? null : (prefs.extraMin ?? core.DEFAULT_EXTRA_MIN);
  const a = agg[name] = { better: 0, equal: 0, worse: 0 };
  for (const p of pairs) {
    const t0 = Date.now();
    const plan = core.planRoutes(graph, p.a, p.b, prefs, {});
    times.push(Date.now() - t0);
    const tag = `${name} / ${p.name}`;
    check(`${tag}: finds routes`, plan.ok && plan.routes.length >= 1 && plan.routes.length <= 3);
    if (!plan.ok) continue;
    const roles = plan.routes.map(r => r.role);
    check(`${tag}: unique roles`, new Set(roles).size === roles.length && !(roles.includes("both") && roles.includes("fastest")), roles.join());
    const exceedNote = plan.notes.some(n => /needs about/.test(n));
    for (const r of plan.routes) {
      const st = r.route.steps;
      let contiguous = st.length > 0 && st[0].from === p.a && st[st.length - 1].to === p.b;
      for (let i = 1; i < st.length; i++) if (st[i].from !== st[i - 1].to) contiguous = false;
      check(`${tag}/${r.role}: route is contiguous start to end`, contiguous);
      if (limit !== null && r.role !== "fastest") {
        check(`${tag}/${r.role}: within extra-time limit`, r.extraMin <= limit + 0.05 || exceedNote, `+${r.extraMin.toFixed(1)} min`);
      }
      if (on.stairs && r.role !== "fastest") check(`${tag}/${r.role}: no stairs`, r.metrics.stairsSegs === 0);
      if (on.crossings) check(`${tag}/${r.role}: coming-soon is "not applied"`, r.report.some(i => i.id === "crossings" && i.status === "na"));
    }
    for (let i = 0; i < plan.routes.length; i++) for (let j = i + 1; j < plan.routes.length; j++) {
      check(`${tag}: routes differ`, core.routeDistance(plan.routes[i].route, plan.routes[j].route) >= 0.09);
    }
    const fast = plan.routes.find(r => r.role === "fastest" || r.role === "both").metrics;
    const best = plan.routes.find(r => r.role === "best" || r.role === "both").metrics;
    const cmp = (better, worse) => { if (better) a.better++; else if (!worse) a.equal++; else a.worse++; };
    if (on.parks) cmp(best.parkM < fast.parkM - 1, best.parkM > fast.parkM + 1);
    if (on.lit) cmp(best.lit.confirmed / best.lenM > fast.lit.confirmed / fast.lenM + 0.01, best.lit.confirmed / best.lenM < fast.lit.confirmed / fast.lenM - 0.01);
    if (on.crime) cmp(best.crime90 < fast.crime90, best.crime90 > fast.crime90);
    if (on.turns) cmp(best.turns < fast.turns, best.turns > fast.turns);
    if (on.unpaved) cmp(best.unpavedM < fast.unpavedM - 1, best.unpavedM > fast.unpavedM + 1);
    if (on.slopes) cmp(best.steepM < fast.steepM - 1, best.steepM > fast.steepM + 1);
    if (on.sheltered) cmp(best.coveredM > fast.coveredM + 1, best.coveredM < fast.coveredM - 1);
    if (on.main) cmp(best.cls.main / best.lenM > fast.cls.main / fast.lenM + 0.01, best.cls.main / best.lenM < fast.cls.main / fast.lenM - 0.01);
  }
}
for (const k of ["parks", "lit", "crime", "turns", "main"]) {
  check(`${k}: never worse than the fastest route`, agg[k].worse === 0, JSON.stringify(agg[k]));
  check(`${k}: improves at least one pair`, agg[k].better > 0, JSON.stringify(agg[k]));
}
// data is thin for these (incline and cover are mapped on very few paths), so only "never worse" is required
for (const k of ["unpaved", "slopes", "sheltered"]) check(`${k}: never worse than the fastest route`, agg[k].worse === 0, JSON.stringify(agg[k]));
times.sort((x, y) => x - y);
console.log(`planRoutes: ${times.length} runs, median ${times[times.length >> 1]} ms, max ${times[times.length - 1]} ms`);
console.log("improvement counts (better/equal/worse vs fastest, over 45 pairs):",
  JSON.stringify(Object.fromEntries(["parks", "lit", "crime", "turns", "main", "unpaved", "slopes", "sheltered"].map(k => [k, agg[k]]))));

/* ---- 1b. the data fields from path_segments.json become the right attributes ---- */
{
  const base = { highway_type: "footway", lighting: "unknown", lighting_source: "", nightlife_venues_250m: 0 };
  const at = (o) => core.segmentAttrs({ ...base, ...o }, undefined);
  check("surface: unpaved / paved / unknown", at({ surface: "unpaved" }).unpaved === true && at({ surface: "paved" }).unpaved === false && at({ surface: null }).unpaved === null);
  check("steep: a mapped incline counts on a footway", at({ steep: true }).steep === true && at({ steep: null }).steep === false);
  check("steep: stairs are NOT also counted as slopes (they have their own button)", at({ highway_type: "steps", steep: true }).steep === false && at({ highway_type: "steps" }).steps === true);
  check("covered: only a mapped cover counts", at({ covered: true }).covered === true && at({ covered: false }).covered === false && at({ covered: null }).covered === false);
  const withData = (k, v) => segments.filter(x => x[k] === v).length;
  check("data has surface, steep and covered fields", withData("surface", "unpaved") > 100 && withData("steep", true) > 100 && withData("covered", true) > 50);
}

/* ---- 2. a requirement that cannot be met says so ---- */
{
  const mk = (id, hw, c) => ({ id, highway_type: hw, coordinates: c, length_m: 30, lighting: "unknown", lighting_source: "no OSM lit tag",
    risk_band: "unknown", risk_score: null, crime_count_90d: 0, name: "unnamed path", tide_exposed: false, nightlife_venues_250m: 0 });
  const g = core.attachExtras(core.buildGraph([mk("A", "steps", [[50.9, -1.4], [50.9003, -1.4]]), mk("B", "footway", [[50.9003, -1.4], [50.9006, -1.4]])]), null);
  const a = core.snap(g, [50.9, -1.4]).key, b = core.snap(g, [50.9006, -1.4]).key;
  const strict = core.planRoutes(g, a, b, { on: { stairs: true } }, {});
  check("only route has stairs: strict 'No stairs' reports an unmet requirement", !strict.ok && strict.reason === "requirement" && strict.unmet.includes("stairs"));
  const relaxed = core.planRoutes(g, a, b, { on: { stairs: true } }, { relaxHard: true });
  check("relaxed: route shown and stairs marked 'missed'", relaxed.ok && relaxed.routes[0].report.some(i => i.id === "stairs" && i.status === "missed"));
}

/* ---- 3. bugs fixed ---- */
{
  const unk = segments.find(s => s.risk_band === "unknown" && s.highway_type === "footway");
  const st = core.routeStats({ segments: [unk], chainLen: unk.length_m, steps: [{ seg: unk.id, len: unk.length_m }] });
  check("routeStats: an all-unscored route is 'unknown', not 'low'", st.band === "unknown", st.band);

  const names = Object.fromEntries(core.PRESETS.map(p => [p[0].split(" (")[0], p]));
  const key = (n) => core.snap(graph, [names[n][1], names[n][2]]).key;
  for (const [x, y] of [["University of Southampton", "St Denys"], ["University of Southampton", "Bitterne Park"],
                        ["Portswood shops", "St Denys"], ["Portswood shops", "Bitterne Park"]]) {
    const t = core.planTriad(graph, key(x), key(y));
    const extra = core.routeStats(t.safest).minutes - core.routeStats(t.shortest).minutes;
    check(`planTriad bound holds: ${x} -> ${y}`, extra <= core.MAX_EXTRA_MIN + 0.05, `+${extra.toFixed(1)} min`);
  }

  const evil = { id: "X", name: "<img src=x onerror=alert(1)>", highway_type: "residential", risk_band: "low", risk_score: 0.01, lighting: "yes",
    coordinates: [[50.9, -1.4], [50.9001, -1.4]], crime_count_90d: 3, last_crime_month: "2026-08", tide_exposed: false, length_m: 20 };
  const unk2 = { ...evil, id: "Y", name: "Quiet Lane", risk_band: "unknown", risk_score: null, lighting: "unknown", crime_count_90d: 0 };
  const text = core.explain({ segments: [evil, unk2], chainLen: 40, steps: [] }, [], [], [], "Safest");
  check("explain: street names are HTML-escaped", !/<img/.test(text) && /&lt;img/.test(text), text);
  check("explain: the unknown-lighting note is not cut", /no lighting data/.test(text), text);
}

/* ---- 4. preferences module ---- */
{
  const bad = P.sanitize({ on: { stairs: true, main: true, quiet: true, shorter: true, further: true, nope: true },
    extraMin: 999, departure: { mode: "time", time: "garbage" }, large: "yes", ride: { on: "x", minutes: 7 }, save: "no" });
  check("sanitize: opposite buttons can't both be on", bad.on.main && !bad.on.quiet && bad.on.shorter && !bad.on.further);
  check("sanitize: bad values fall back to defaults", bad.extraMin === 10 && bad.departure.mode === "now" && bad.large === false &&
    bad.ride.on === true && bad.ride.minutes === 20 && bad.save === true && !("nope" in bad.on));
  const t = P.setToggle({ main: true, quiet: false }, "quiet", true);
  check("setToggle: turning one on turns its partner off", t.on.quiet && !t.on.main && t.switchedOff === "main");
  const now = Date.now();
  check("departureMs: a past time means now", P.departureMs({ departure: { mode: "time", time: "2020-01-01T10:00" } }, now) === now);
  check("departureMs: a future time is used", P.departureMs({ departure: { mode: "time", time: "2999-01-01T10:00" } }, now) > now);
  check("departureMs: 'now' mode and empty prefs mean now", P.departureMs({ departure: { mode: "now", time: "" } }, now) === now && P.departureMs(null, now) === now);
  const boom = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  check("storage that throws never crashes", P.stored.load(boom).saved === false && P.stored.save(boom, {}) === false && P.stored.clear(boom) === false && P.stored.load(null).saved === false);
  check("every soon button is known to the planner", P.TOGGLES.filter(x => x.tier === "soon").every(x => core.SOON_IDS.includes(x.id)) &&
    core.SOON_IDS.every(id => P.toggleById(id) && P.toggleById(id).tier === "soon"));
}

/* ---- 5. ride suggestion ---- */
{
  const m = (o) => Object.assign({ lenM: 1000, minutes: 12, lit: { confirmed: 900 }, band: { high: 0 } }, o);
  const prefs = { ride: { on: true, minutes: 20 } };
  const noon = new Date(2026, 9, 17, 12, 0).getTime(), late = new Date(2026, 9, 17, 23, 30).getTime();
  check("ride: short daytime walk -> no suggestion", R.rideReasons(m(), prefs, noon).length === 0);
  check("ride: walk over the limit -> suggested", R.rideReasons(m({ minutes: 24 }), prefs, noon).some(r => r.id === "long"));
  check("ride: late start with little confirmed lighting -> suggested", R.rideReasons(m({ lit: { confirmed: 200 } }), prefs, late).some(r => r.id === "late"));
  check("ride: late start with good lighting -> not suggested", R.rideReasons(m(), prefs, late).length === 0);
  check("ride: a quarter of the route in the highest crime band -> suggested", R.rideReasons(m({ band: { high: 300 } }), prefs, noon).some(r => r.id === "crime"));
  check("ride: switched off -> never", R.rideReasons(m({ minutes: 60 }), { ride: { on: false, minutes: 20 } }, late).length === 0);
  const all = R.rideReasons(m({ minutes: 60, lit: { confirmed: 0 }, band: { high: 900 } }), prefs, late).map(r => r.text + r.chip).join(" ");
  check("ride: wording never says 'unsafe'", !/unsafe|dangerous/i.test(all), all);
  const u = R.uberUrl([50.9, -1.39], "Ocean Village", [50.93, -1.4], true);
  check("uberUrl: pre-filled destination and my_location pickup", /^https:\/\/m\.uber\.com\/ul\/\?/.test(u) && /pickup=my_location/.test(u) &&
    /dropoff\[latitude\]=50\.900000/.test(u) && /dropoff\[longitude\]=-1\.390000/.test(u) && /dropoff\[nickname\]=Ocean%20Village/.test(u), u);
  const u2 = R.uberUrl([50.9, -1.39], "", [50.93, -1.4], false);
  check("uberUrl: explicit pickup when the start isn't GPS", /pickup\[latitude\]=50\.930000/.test(u2) && /dropoff\[nickname\]=Destination/.test(u2), u2);
}

/* ---- 7. step-by-step directions and the Google Maps handoff ---- */
{
  const RAW_TAGS = /\b(tertiary|secondary|primary|residential|unclassified|footway|cycleway|living_street)\b/;   // raw map tags must not leak into the text
  const ll = (c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  const sum = { 0: [0, 0], 3: [0, 0], 9: [0, 0], n: 0 };   // [stops, simulated match %] per stop budget
  let badTbt = 0, badUrl = 0, badStopPos = 0, firstBad = "";
  for (const p of pairs) {
    const plan = core.planRoutes(graph, p.a, p.b, {}, {});
    if (!plan.ok) continue;
    for (const r of plan.routes) {
      sum.n++;
      // directions
      const t = core.turnByTurn(graph, r.route);
      const body = t.slice(0, -1);
      const covered = t.reduce((x, y) => x + y.dist, 0);
      const ok = t.length >= 2 && /^Head (north|north-east|east|south-east|south|south-west|west|north-west) on /.test(t[0].text) &&
        t[t.length - 1].text === "Arrive at your destination" && Math.abs(covered - r.route.chainLen) < 1 &&
        body.every(x => x.name && x.lead && (x.dist >= 15 || /steps/.test(x.name))) && !t.some(x => RAW_TAGS.test(x.text));
      if (!ok) { badTbt++; firstBad = firstBad || `${p.name}: ${t.map(x => x.text).join(" | ")}`; }
      // Google link with 0, 3 and 9 stops
      const nodes = new Set([r.route.steps[0].from].concat(r.route.steps.map(s => s.to)));
      const nodePts = new Set([...nodes].map(k => ll(graph.nodes.get(k).c)));
      for (const k of [0, 3, 9]) {
        const hnd = core.gmapsHandoff(graph, r.route, null, null, { maxStops: k });
        const u = new URL(hnd.url), wp = u.searchParams.get("waypoints"), cnt = wp ? wp.split("|").length : 0;
        const pipesOk = wp ? !hnd.url.includes("|") && (cnt < 2 || hnd.url.includes("%7C")) : !hnd.url.includes("waypoints");
        if (cnt > k || cnt !== hnd.stops.length || hnd.url.length > 2048 || u.searchParams.get("travelmode") !== "walking" || !pipesOk) badUrl++;
        if (hnd.stops.some(c => !nodePts.has(ll(c)))) badStopPos++;
        sum[k][0] += hnd.stops.length; sum[k][1] += hnd.matchPct;
      }
    }
  }
  check(`directions: all ${sum.n} routes well-formed (start, arrival, distances add up, no tiny or raw-tag lines)`, badTbt === 0, `${badTbt} bad; first: ${firstBad}`);
  check(`Google link: 0, 3 and 9 stop budgets are respected, valid and short enough on all ${sum.n} routes`, badUrl === 0, `${badUrl} bad`);
  check("Google link: every stop sits on a point of the route", badStopPos === 0, `${badStopPos} bad`);
  const avg = (k) => sum[k][1] / sum.n;
  console.log(`google stops: none ${avg(0).toFixed(1)}% of the route reproduced (simulated); up to 3 stops ${avg(3).toFixed(1)}% (avg ${(sum[3][0] / sum.n).toFixed(2)} stops); up to 9 stops ${avg(9).toFixed(1)}% (avg ${(sum[9][0] / sum.n).toFixed(2)} stops)`);
  check("Google link: stops raise the simulated match (none < 3 stops <= 9 stops)", avg(0) < avg(3) && avg(3) <= avg(9));
  check("Google link: 3 stops reproduce at least 90% of the route on average", avg(3) >= 90, avg(3).toFixed(1));
  check("Google link: 9 stops reproduce at least 97% of the route on average", avg(9) >= 97, avg(9).toFixed(1));

  // the person's own start and end are used, same-place and empty routes are safe
  const plan0 = core.planRoutes(graph, pairs[3].a, pairs[3].b, {}, {});
  const own = core.gmapsHandoff(graph, plan0.routes[0].route, [50.91, -1.41], [50.93, -1.39], { maxStops: 3 });
  const q = new URL(own.url).searchParams;
  check("Google link: uses the person's own start and destination when given", q.get("origin") === "50.91000,-1.41000" && q.get("destination") === "50.93000,-1.39000", own.url);
  const none = core.gmapsHandoff(graph, { steps: [], chainLen: 0 }, null, null, {});
  check("Google link: empty route -> plain Google Maps, no crash", none.url === "https://www.google.com/maps" && none.stops.length === 0);
  const same = core.turnByTurn(graph, { steps: [], chainLen: 0 });
  check("directions: empty route -> says start and destination are the same place", same.length === 1 && /same place/.test(same[0].text));
  const t0 = Date.now();
  for (const p of pairs.slice(0, 10)) core.gmapsHandoff(graph, core.planRoutes(graph, p.a, p.b, {}, {}).routes[0].route, null, null, { maxStops: 9 });
  check("Google link: finding 9 stops stays quick (10 routes under 3 s including planning)", Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
}

console.log(`${checks} checks, ${fails} failed`);
console.log(fails ? "\nFAILED" : "\nALL TESTS PASSED");
process.exit(fails ? 1 : 0);
