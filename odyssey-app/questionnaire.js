/* Odyssey — route preferences: ONE question ("What matters on this walk?") made of
 * on/off buttons. Shown as a first-run screen and again, with a small "More
 * settings" area, behind the ⚙ button. Plain DOM, no framework, no build step.
 * Every piece of text is inserted with textContent, never innerHTML.
 *
 * On = the route finder takes it into account. Off = ignored. The answers are
 * read by app.js (planRoutes) through OdysseyQuestionnaire.getPrefs().
 */
"use strict";
(function () {
  const P = window.OdysseyPrefs;
  if (!P) return;

  const SKIP_KEY = "odyssey_prefs_skipped";
  const OPENING = "Tell us what matters on this walk. We’ll show up to three different routes " +
    "and explain how each matches your choices. Route information may be incomplete, and a " +
    "higher preference match does not mean a route is guaranteed safe.";

  // Browsers can throw when storage is blocked (private mode, site settings).
  const safe = (get) => { try { return get(); } catch (e) { return null; } };
  const local = safe(() => window.localStorage);
  const session = safe(() => window.sessionStorage);

  /* ------------------------------- state -------------------------------- */
  let current = P.defaultPrefs();     // what the app uses right now
  let savedOnDevice = false;
  let sessionSet = false;             // answered this visit without saving
  let modal = null, body = null, foot = null;
  let draft = null, mode = "wizard", opener = null;
  const listeners = [];
  const notify = () => listeners.forEach(fn => { try { fn(P.clone(current)); } catch (e) { /* a listener must not break saving */ } });

  /* ------------------------------ helpers ------------------------------- */
  let uidN = 0;
  const uid = (p) => `${p}-${++uidN}`;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid);                       // strings become text nodes
    }
    return el;
  }

  function localInputValue(d) {
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
  }
  function nextSlot() {            // roughly 15 minutes from now, on a 5-minute mark
    const d = new Date(Date.now() + 15 * 60000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d;
  }

  const applyDisplay = () => document.body.classList.toggle("large-text", !!current.large);

  /* Radio group drawn as big tappable buttons (native radios underneath, so
   * arrow keys and screen readers work). Wrap in a <fieldset> + <legend>. */
  function segmented({ name, options, value, onChange }) {
    const wrap = h("div", { class: "seg" });
    options.forEach((o) => {
      const id = uid("seg");
      const input = h("input", { type: "radio", name, id, value: String(o.value), checked: o.value === value });
      input.addEventListener("change", () => { if (input.checked) onChange(o.value); });
      wrap.append(h("label", { class: "seg-opt", for: id }, input, h("span", {}, o.label)));
    });
    return wrap;
  }

  function checkRow({ label, checked, onChange }) {
    const id = uid("chk");
    const input = h("input", { type: "checkbox", id, role: "switch", checked: !!checked });
    input.addEventListener("change", () => onChange(input.checked));
    return h("label", { class: "opt", for: id }, input, h("span", { class: "opt-text" }, label));
  }

  /* --------------------------- the one question -------------------------- */
  function buildQuestion() {
    const heading = mode === "wizard"
      ? h("h2", { id: "pm-title", tabindex: "-1" }, "What matters on this walk?")
      : h("h3", { class: "pm-sec-title" }, "What matters on this walk?");
    const status = h("p", { class: "pm-status", "aria-live": "polite" });
    const buttons = new Map();
    const countOn = () => P.TOGGLES.filter(t => draft.on[t.id]).length;
    const refresh = (msg) => {
      P.TOGGLES.forEach((t) => {
        const b = buttons.get(t.id);
        b.setAttribute("aria-pressed", String(!!draft.on[t.id]));
      });
      const n = countOn();
      status.textContent = msg || (n ? `${n} turned on.` : "Nothing turned on yet.");
    };

    const root = h("div", {}, heading,
      h("p", { class: "pm-lead" }, OPENING),
      h("p", { class: "pm-sub" }, "Turn on anything you want us to take into account. Everything starts off, and off means ignored. " +
        "You can change this any time with the ⚙ button."));

    for (const g of P.GROUPS) {
      const items = P.TOGGLES.filter(t => t.group === g.id);
      const grid = h("div", { class: "togs" });
      for (const t of items) {
        const hintId = uid("hint");
        const soon = t.tier === "soon";
        const b = h("button", { type: "button", class: "tog" + (soon ? " is-soon" : ""), "aria-pressed": "false", "aria-describedby": hintId },
          h("span", { class: "tog-mark", "aria-hidden": "true" }),
          h("span", { class: "tog-text" },
            h("span", { class: "tog-label" }, t.label),
            h("span", { class: "tog-hint", id: hintId }, t.hint + (soon ? " Saved for later; it doesn’t change routes yet." : ""))));
        b.addEventListener("click", () => {
          const wasOn = !!draft.on[t.id];
          const r = P.setToggle(draft.on, t.id, !wasOn);
          draft.on = r.on;
          const other = r.switchedOff && P.toggleById(r.switchedOff);
          refresh(other ? `Turned off “${other.label}”: the two can’t both be on.`
            : `“${t.label}” ${wasOn ? "off" : "on"}. ${countOn()} turned on.`);
        });
        buttons.set(t.id, b);
        grid.append(b);
      }
      root.append(h("h3", { class: "pm-sec-title" }, g.label), grid);
    }
    root.append(status,
      h("p", { class: "f-hint" }, "Buttons marked “Coming soon” are saved but not used yet. " +
        "“No stairs” is strict: routes never use known stairs. Everything else is a preference that can be traded off, and every card says how well it was met."));
    refresh();
    return root;
  }

  /* ----------------------------- more settings -------------------------- */
  function buildMore() {
    const root = h("div", {}, h("h3", { class: "pm-sec-title" }, "More settings"));

    /* extra time */
    const range = h("input", { type: "range", min: "0", max: String(P.EXTRA_MIN_STOPS.length - 1), step: "1",
      id: uid("extra"), value: String(P.EXTRA_MIN_STOPS.indexOf(draft.extraMin)) });
    const out = h("output", { class: "slider-value", for: range.id, "aria-live": "polite" });
    const set = (i) => {
      i = Math.max(0, Math.min(P.EXTRA_MIN_STOPS.length - 1, i));
      range.value = String(i);
      draft.extraMin = P.EXTRA_MIN_STOPS[i];
      out.textContent = P.EXTRA_MIN_LABELS[i];
      range.setAttribute("aria-valuetext", P.EXTRA_MIN_LABELS[i]);
    };
    set(P.EXTRA_MIN_STOPS.indexOf(draft.extraMin));
    range.addEventListener("input", () => set(+range.value));
    const stepBtn = (label, sym, d) => h("button", { type: "button", class: "step-btn", "aria-label": label,
      onclick: () => set(+range.value + d) }, sym);
    root.append(h("fieldset", { class: "factor" },
      h("legend", {}, "Extra time you’d accept"),
      h("div", { class: "slider-top" }, stepBtn("Less extra time", "−", -1), out, stepBtn("More extra time", "+", 1)),
      range,
      h("div", { class: "ticks", "aria-hidden": "true" }, ...["None", "5", "10", "15", "No limit"].map(t => h("span", {}, t))),
      h("p", { class: "f-hint" }, "How much longer than the fastest route a better match may take. " +
        "Ignored while “Happy to go further” is on. If this leaves fewer than three different routes, we show fewer.")));

    /* start time */
    const timeInput = h("input", { type: "datetime-local", id: uid("dep"), "aria-label": "Departure date and time" });
    timeInput.min = localInputValue(new Date());
    timeInput.value = draft.departure.time || "";
    const timeRow = h("div", { class: "time-row" }, timeInput);
    const syncTime = () => timeRow.classList.toggle("hidden", draft.departure.mode !== "time");
    syncTime();
    const onTime = () => { draft.departure.time = timeInput.value; };
    timeInput.addEventListener("input", onTime);
    timeInput.addEventListener("change", onTime);
    root.append(h("fieldset", { class: "factor" },
      h("legend", {}, "When will you start walking?"),
      segmented({ name: "dep-mode", value: draft.departure.mode,
        options: [{ value: "now", label: "Now" }, { value: "time", label: "Choose a departure time" }],
        onChange: (v) => {
          draft.departure.mode = v;
          if (v === "time" && !draft.departure.time) {
            draft.departure.time = localInputValue(nextSlot());
            timeInput.value = draft.departure.time;
          }
          syncTime();
        } }),
      timeRow,
      h("p", { class: "f-hint" }, "Used for arrival times and the late-night ride suggestion.")));

    /* ride suggestion */
    root.append(h("fieldset", { class: "factor" },
      h("legend", {}, "Suggest a ride"),
      checkRow({ label: "Suggest a ride for long walks, or late-night walks with little confirmed lighting",
        checked: draft.ride.on, onChange: (v) => { draft.ride.on = v; } }),
      h("p", { class: "f-q" }, "Count a walk as long when it’s over:"),
      segmented({ name: "ride-min", value: draft.ride.minutes,
        options: P.RIDE_MINUTES.map(m => ({ value: m, label: `${m} min` })),
        onChange: (v) => { draft.ride.minutes = v; } }),
      h("p", { class: "f-hint" }, "The suggestion opens a sheet with Uber, Bolt and a share link. Nothing is shared until you tap one.")));

    /* display and saving */
    root.append(h("div", { class: "factor" },
      checkRow({ label: "Large text", checked: draft.large,
        onChange: (v) => { draft.large = v; document.body.classList.toggle("large-text", v); } }),
      checkRow({ label: "Save these on this device", checked: draft.save, onChange: (v) => { draft.save = v; } }),
      h("p", { class: "f-hint" }, "Saved in your browser only: no account, and your preferences are never sent anywhere. " +
        "Turn saving off to use them for this visit only. (Destinations you type are looked up with OpenStreetMap’s " +
        "Nominatim service, a third party; preferences are not part of that request.)")));
    return root;
  }

  /* ------------------------------ modal frame --------------------------- */
  const btn = (label, cls, onClick) => h("button", { type: "button", class: `pm-btn ${cls || ""}`, onclick: onClick }, label);

  function buildModal() {
    body = h("div", { class: "pm-body" });
    foot = h("div", { class: "pm-foot" });
    const sos = h("button", { type: "button", class: "pm-sos", "aria-label": "Emergency SOS",
      onclick: () => { const b = document.getElementById("sos-open"); if (b) b.click(); } }, "SOS");
    const close = h("button", { type: "button", class: "pm-close",
      "aria-label": mode === "wizard" ? "Skip for now" : "Close without saving", onclick: () => cancel() }, "×");
    modal = h("div", { id: "prefs-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pm-title" },
      h("div", { class: "pm-card" },
        h("div", { class: "pm-head" },
          h("div", { class: "pm-head-row" }, h("p", { class: "pm-step" }, mode === "wizard" ? "Route preferences" : "Settings"),
            h("div", { class: "pm-head-actions" }, sos, close)),
          mode === "settings" ? h("h2", { id: "pm-title", class: "pm-title", tabindex: "-1" }, "Route preferences") : null),
        body, foot));
    document.body.append(modal);
  }

  function render(opts) {
    const o = opts || {};
    const y = body.scrollTop;
    if (mode === "wizard") body.replaceChildren(buildQuestion());
    else body.replaceChildren(h("section", { class: "pm-section" }, buildQuestion()), h("section", { class: "pm-section" }, buildMore()));
    renderFooter();
    body.scrollTop = o.keepScroll ? y : 0;
    const target = modal.querySelector("#pm-title");
    if (target) target.focus({ preventScroll: true });
  }

  function renderFooter() {
    foot.replaceChildren();
    if (mode === "settings") {
      foot.append(
        h("div", { class: "pm-foot-left" },
          btn("Reset to defaults", "", () => { draft = P.defaultPrefs(); document.body.classList.toggle("large-text", false); render({ keepScroll: true }); }),
          btn("Delete saved preferences", "danger", deleteSaved)),
        h("div", { class: "pm-foot-right" }, btn("Cancel", "", cancel), btn("Save", "primary", commit)));
      return;
    }
    foot.append(h("div", { class: "pm-foot-left" }),
      h("div", { class: "pm-foot-right" }, btn("Skip for now", "", cancel), btn("Done", "primary", commit)));
  }

  function open(m) {
    if (modal) return;
    mode = m === "settings" ? "settings" : "wizard";
    draft = P.clone(current);
    opener = document.activeElement;
    buildModal();
    render();
    document.addEventListener("keydown", onKey, true);
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    if (modal) modal.remove();
    modal = body = foot = draft = null;
    applyDisplay();                                  // undo any live large-text preview
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    opener = null;
  }

  function cancel() {
    if (mode === "wizard" && !savedOnDevice && !sessionSet && session) { try { session.setItem(SKIP_KEY, "1"); } catch (e) { /* ignore */ } }
    close();
  }

  function commit() {
    const prefs = P.sanitize(draft);
    current = prefs;
    sessionSet = true;
    if (prefs.save) savedOnDevice = !!local && P.stored.save(local, prefs);
    else { if (local) P.stored.clear(local); savedOnDevice = false; }
    close();
    renderCard(prefs.save && !savedOnDevice ? "Couldn’t save on this device (storage is blocked), so these are kept for this visit only." : "");
    notify();
  }

  function deleteSaved() {
    if (!window.confirm("Delete your saved route preferences from this device?")) return;
    if (local) P.stored.clear(local);
    if (session) { try { session.removeItem(SKIP_KEY); } catch (e) { /* ignore */ } }
    current = P.defaultPrefs(); savedOnDevice = false; sessionSet = false;
    close();
    renderCard();
    notify();
  }

  function onKey(e) {
    if (!modal) return;
    const sos = document.getElementById("sos-overlay");
    if (sos && !sos.classList.contains("hidden")) return;        // let the SOS screen handle keys
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (e.key !== "Tab") return;
    const f = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], inside = modal.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
  }

  /* --------------------------- summary card ----------------------------- */
  function renderCard(extraNote) {
    const el = document.getElementById("prefs-card");
    if (!el) return;
    const set = savedOnDevice || sessionSet;
    el.replaceChildren(h("div", { class: "pc-head" }, h("h2", {}, "Your route preferences")));
    if (set) {
      const items = P.summarise(current);
      if (items.length) {
        const list = h("ul", { class: "pc-chips" });
        items.slice(0, 6).forEach(i => list.append(h("li", { class: i.soon ? "soon" : "" }, i.text)));
        if (items.length > 6) list.append(h("li", { class: "more" }, `+${items.length - 6} more`));
        el.append(list);
      } else {
        el.append(h("p", { class: "pc-note" }, "Nothing turned on, so routes are the quickest way."));
      }
      el.append(h("p", { class: "pc-note" }, (savedOnDevice ? "Saved on this device. " : "Kept for this visit only. ") + (extraNote || "")));
    } else {
      el.append(h("p", { class: "pc-note" }, "Tell us what matters on your walk. It’s one question, and you can skip it."));
    }
    el.append(h("button", { type: "button", class: "pc-btn", onclick: () => open(set ? "settings" : "wizard") },
      set ? "Edit preferences" : "Set your preferences"));
  }

  /* ------------------------------- start-up ----------------------------- */
  function init() {
    const loaded = P.stored.load(local);
    current = loaded.prefs;
    savedOnDevice = loaded.saved;
    applyDisplay();
    renderCard();
    const gear = document.getElementById("prefs-open");
    if (gear) gear.addEventListener("click", () => open("settings"));
    const skipped = session && safe(() => session.getItem(SKIP_KEY)) === "1";
    const demo = /[?&]demo=1(&|$)/.test(location.search);       // ?demo=1 skips the first-run screen
    if (!savedOnDevice && !skipped && !demo) open("wizard");
  }

  window.OdysseyQuestionnaire = {
    open,
    getPrefs: () => P.clone(current),
    departureMs: () => P.departureMs(current, Date.now()),
    onChange: (fn) => { if (typeof fn === "function") listeners.push(fn); },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
