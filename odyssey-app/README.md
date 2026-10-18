# Odyssey — night-safety route planner for Southampton

**Run it:** `python3 -m http.server 8000` in this folder, then open
http://localhost:8000. No backend, no accounts, no keys.

- **Map:** every walking segment coloured by the Athena risk model
  (green low / amber medium / red high / grey-dashed = no lighting data, never
  scored). Click a segment for lighting, real Police UK crime history
  (categories + months), isolation, tide exposure, and sources.
- **Route preferences:** one question, "What matters on this walk?", made of
  on/off buttons (lighting, no stairs, parks, unpaved surfaces, slopes, covered
  routes, main or quiet streets, fewer turns, recorded crime, and more). On =
  the planner takes it into account.
  Saved on the device only (`prefs.js`, `questionnaire.js`); change it any
  time with the ⚙ button. "No stairs" is strict, the rest are preferences,
  and buttons marked "Coming soon" are saved but not used yet.
- **Routing:** `planRoutes` in `app.js` returns up to three different routes
  (Best match / Fastest / Alternative; names live in `ROUTE_LABELS`), inside
  your extra-time limit. Each card has a match list built from the metres
  actually walked (matched / partly / unknown / not met), so it can't
  overclaim. Recorded crime is shown as info and only changes ranking when its
  button is on. Surface, incline and cover come from `path_segments.json`;
  `data/segment_extras.json` adds parks, shared paths, underpasses and
  main-road distance (without it those buttons find nothing). Incline and cover
  are mapped on very few paths, and the cards say so.
- **Ride suggestion:** long walks, late-night walks with little confirmed
  lighting, or a route with a lot of the highest recorded-crime band show a
  neutral banner that opens a sheet: Uber (trip pre-filled), Bolt (site only,
  no public pre-fill link) and a share link (`rides.js`). No keys or server.
- **Live:** the panel fetches the real-time Environment Agency tide gauge at
  Woolston and active flood warnings directly in your browser.
- **Step-by-step directions:** each route card has a list built from our own route (street names, turns,
  stairs, distances), so nothing is rerouted. Unnamed ways are called "the footpath" and so on.
- **Google Maps handoff:** Google picks its own path between the points you give it, so two pins alone often
  differ from our route. The link adds the fewest stops that keep Google on our route (we pretend Google takes
  the shortest walk, find where that leaves our route, and pin the middle of the longest gap, repeating). Google
  allows 3 stops in a phone browser and 9 elsewhere. The match is simulated on our own street map, not on
  Google, so it can still differ a little; the card says so.
- **Demo:** open the app with `?demo=1` to plan a sample walk without GPS or typing.
- **SOS:** 999 / 101 dial buttons, copy-my-location, official guidance links.
- **Tests:** `node test_plan.js` checks the planner (all 45 preset pairs under
  20 button combinations), the preferences and the ride rules; run both from
  this folder.
- **Honesty:** `node test_core.js` verifies routes on the real data;
  `data/data_manifest.json` lists every source with its licence and fetch
  date; `data/model.json` is the full model card (AUC 0.982 vs 0.866
  recency baseline on held-out Aug 2026).

Regenerate all data + retrain the model: see `../odyssey-city-data`.
Full write-up and demo script: `../GUIDE.md` and `../odyssey-city-data/README.md`.

Licences: OSM ODbL (basemap, network) · Police UK & EA OGL v3 · Leaflet BSD · code MIT.
