/* Node test for the Odyssey routing core + real-data sanity — node test_core.js */
"use strict";
const fs = require("fs");
const core = require("./app.js");
const segments = JSON.parse(fs.readFileSync("data/path_segments.json"));
const crimes = JSON.parse(fs.readFileSync("data/incidents.json"));
const havens = JSON.parse(fs.readFileSync("data/safe_havens.json"));
const model = JSON.parse(fs.readFileSync("data/model.json"));
console.log(`segments: ${segments.length}, real crimes: ${crimes.length}, havens: ${havens.length}`);
console.log(`model: AUC ${model.evaluation.auc_model} vs baseline ${model.evaluation.auc_baseline_recent_crime} (test month ${model.training.test_month})`);
let fail = 0;
const banned = ["lit_no","lit_partial","lit_unknown","isolation","tide_exposed","haven_300m"];
let modelFails = 0;
for (const f of banned) if (model.features.includes(f)) { console.log(`!! removed feature still present: ${f}`); modelFails++; }
if (!model.removed_features || model.removed_features.length !== 6) { console.log("!! removed_features block missing/incomplete"); modelFails++; }
for (const need of ["design_choice", "known_limitations"])
  if (!model[need]) { console.log(`!! model card missing ${need}`); modelFails++; }
if (modelFails) fail += modelFails;

// real-data sanity
const withCrime = segments.filter(s => s.crime_count_90d > 0);
console.log(`segments with real crimes in last 3 months: ${withCrime.length}`);
const months = [...new Set(crimes.map(c => c.month))].sort();
console.log(`crime months: ${months[0]}..${months[-1] ?? months[months.length-1]}`);
const unsnapped = crimes.filter(c => !c.segment_id).length;
if (unsnapped) { console.log(`!! ${unsnapped} crimes missing segment_id`); }
const hi = segments.filter(s => s.risk_band === "high");
const hiCrime = hi.filter(s => s.crime_count_90d > 0).length;
console.log(`high-band segments: ${hi.length}, of which with recent crime: ${hiCrime}`);

const t0 = Date.now();
const graph = core.buildGraph(segments);
console.log(`graph built in ${Date.now() - t0}ms, nodes: ${graph.nodes.size}`);

const trips = [
  ["Uni -> Portswood",        [50.9362,-1.3957], [50.9285,-1.3995], 2.5],
  ["City centre -> Town Quay",[50.9045,-1.4025], [50.8998,-1.4005], 2.0],
  ["City centre -> Ocean Village",[50.9045,-1.4025],[50.9040,-1.3930], 2.5],
  ["St Denys -> Cobden Bridge",[50.9215,-1.3905],[50.9245,-1.3780], 2.5],
  ["Shirley -> city centre",  [50.9105,-1.4325], [50.9045,-1.4025], 4.5],
];
for (const [name, from, to, maxKm] of trips) {
  console.log(`\n== ${name} ==`);
  const a = core.snap(graph, from), b = core.snap(graph, to);
  const triad = core.planTriad(graph, a.key, b.key);
  const routes = [];
  for (const [label, route] of [["Safest", triad.safest], ["Shortest", triad.shortest], ["Balanced", triad.balanced]]) {
    if (!route) { console.log(`  ${label}: NO ROUTE`); fail++; continue; }
    const st = core.routeStats(route);
    const high = route.segments.filter(s => s.risk_band === "high").length;
    const crimes90 = route.segments.reduce((t, s) => t + (s.crime_count_90d||0), 0);
    console.log(`  ${label}: ${(st.len/1000).toFixed(2)}km, ${Math.round(st.minutes)}min, ` +
      `band=${st.band}, high-segs=${high}, recent-crimes-on-route=${crimes90}, unscored=${st.unknownCount}` +
      (label === "Safest" && triad.safestNote ? `  [bound applied]` : ""));
    routes.push({ label, route });
    if (label === "Shortest" && st.len / 1000 > maxKm) { console.log(`  !! shortest ${(st.len/1000).toFixed(2)}km > ${maxKm}km`); fail++; }
  }
  // bounded-safest invariants
  const shortMin = core.routeStats(routes[1].route).minutes;
  const safeMin = core.routeStats(routes[0].route).minutes;
  if (safeMin - shortMin > core.MAX_EXTRA_MIN + 1) { console.log(`  !! safest detour ${(safeMin-shortMin).toFixed(0)} min > ${core.MAX_EXTRA_MIN}`); fail++; }
  const exposure = (rr) => rr.route.segments.reduce((t, s) => t + (s.crime_count_90d || 0), 0);
  const hiN = (rr) => rr.route.segments.filter(s => s.risk_band === "high").length;
  // in uniformly risky areas "safest" may only match the shortest; it must
  // never be dramatically worse, and the UI states the similarity honestly.
  if (exposure(routes[0]) > exposure(routes[1]) * 2 || hiN(routes[0]) > hiN(routes[1]) * 2) {
    console.log("  !! safest exposure dramatically worse than shortest"); fail++;
  }
  const uniq = [];
  for (const r of routes)
    if (!uniq.some(u => u.route.segments.map(s=>s.id).join() === r.route.segments.map(s=>s.id).join())) uniq.push(r);
  for (const r of uniq.slice(0, 2))
    console.log(`  [${r.label}] "${core.explain(r.route, uniq, crimes, havens, r.label)}"`);
  const tbt = core.turnByTurn(graph, uniq[0].route);
  console.log(`  tbt: ${tbt.length} steps; first: "${tbt[0].text}"`);
  if (tbt.length < 3) { console.log("  !! suspiciously few steps"); fail++; }
  if (!/^Head (north|north-east|east|south-east|south|south-west|west|north-west) on .+ — \d/.test(tbt[0].text)) { console.log("  !! first step malformed"); fail++; }
  if (tbt[tbt.length - 1].text !== "Arrive at your destination") { console.log("  !! missing arrival step"); fail++; }
  const covered = tbt.reduce((s, x) => s + x.dist, 0);
  if (Math.abs(covered - uniq[0].route.chainLen) > 1) { console.log(`  !! tbt distance ${covered.toFixed(0)} != route ${uniq[0].route.chainLen.toFixed(0)}`); fail++; }
  if (new Set(tbt.map(x => x.text)).size < 3) { console.log("  !! no street variety"); fail++; }
  // Google link: the fewest stops that keep Google on our route (3 max on a phone browser, 9 elsewhere)
  for (const budget of [3, 9]) {
    const url = core.routeToGmapsUrl(graph, uniq[0].route, null, null, { maxStops: budget });
    const wps = (url.match(/waypoints=([^&]*)/)?.[1] || "").split("%7C").filter(Boolean);
    console.log(`  gmaps (up to ${budget}): hops=${uniq[0].route.steps.length} waypoints=${wps.length}`, url.slice(0, 80) + "…");
    if (wps.length > budget) { console.log(`  !! more than ${budget} waypoints`); fail++; }
    if (url.length > 2048) { console.log("  !! URL longer than Google's 2,048-character limit"); fail++; }
    if (!url.includes("travelmode=walking")) { console.log("  !! missing travelmode=walking"); fail++; }
  }
}
// ---- route data fields used by the preference buttons ----
console.log("\n== preference data ==");
for (const f of ["surface", "steep", "covered"]) {
  const missing = segments.filter(s => !(f in s)).length;
  if (missing) { console.log(`  !! ${missing} segments lack the "${f}" field`); fail++; }
}
const knownPct = (f) => (100 * segments.filter(s => s[f] !== null && s[f] !== undefined).length / segments.length).toFixed(1);
console.log(`  surface known on ${knownPct("surface")}% of segments, incline on ${knownPct("steep")}%, cover on ${knownPct("covered")}%`);
const extras = JSON.parse(fs.readFileSync("data/segment_extras.json"));
core.attachExtras(graph, extras);
const stairsPlan = core.planRoutes(graph, core.snap(graph, [50.9215, -1.3905]).key, core.snap(graph, [50.9245, -1.3780]).key,
  { on: { stairs: true } }, {});
if (!stairsPlan.ok || stairsPlan.routes.some(r => r.role !== "fastest" && r.metrics.stairsSegs > 0)) {
  console.log("  !! the No stairs button still lets stairs through"); fail++;
} else console.log("  No stairs button: routes are stairs-free");

console.log(fail ? `\nFAILED: ${fail} problems` : "\nALL TESTS PASSED");
process.exit(fail ? 1 : 0);
