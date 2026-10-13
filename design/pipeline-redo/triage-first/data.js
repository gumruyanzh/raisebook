// Fictional investors for the mockups (no real people). Deterministic.
(function () {
  let s = 411;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const FIRST = "Avery Blake Casey Dana Elliot Frankie Gray Harper Indy Jordan Kai Logan Morgan Noel Oakley Parker Quinn Reese Sage Taylor Uma Vic Wren Xan Yael Zion Ada Bram Cleo Dov Esme Finn Gia Hugo Iris Jude Kira Leo Mira Nico Odette Pax Rhea Silas Tova Ugo Vera Wes Yara Zane".split(" ");
  const LAST = "Ashford Brightwater Calloway Dunmore Everly Fairbanks Galloway Hollis Ingram Jessup Kettering Lockwood Merriman Northcott Oakhurst Pemberton Quill Radley Stanhope Thorne Underhill Vance Whitlock Yardley Zeller Ambrose Birch Corwin Dalby Eastman Fenwick Granger Hale Irvine Jarrow Keel Larkin Moss Nyland Orme Prentice Rowe Sutter Tamsin Upton Voss Weld".split(" ");
  const FA = "Harbor Northwind Juniper Copperline Saltmarsh Bluefin Granite Lantern Fieldstone Ironbark Meridian Tidewater Redwood Halcyon Quarry Ember Larch Basalt Driftwood Silverpine Foxglove Wayfinder Cinder Brightline Hollow Summit Petrel Alder".split(" ");
  const FB = ["Ventures", "Capital", "Partners", "Angels", "Fund", "Labs", "Collective"];
  const TITLES = ["Partner", "General Partner", "Principal", "Associate", "Managing Partner", "Venture Partner", "Scout", "Investor"];
  const TYPES = ["VC", "VC", "VC", "VC", "VC", "Angel", "Angel", "Angel", "Scout", "Family office", "CVC"];
  const IND = ["Other", "Other", "Other", "AI", "AI", "SaaS", "Fintech", "Dev tools", "Climate", "Health"];
  const fits = [].concat(Array(12).fill(5), Array(28).fill(4), Array(95).fill(3), Array(120).fill(2), Array(70).fill(1), Array(86).fill(0));
  for (let i = fits.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [fits[i], fits[j]] = [fits[j], fits[i]]; }
  const seen = new Set(), list = [];
  for (let i = 0; i < 411; i++) {
    let n; do { n = pick(FIRST) + " " + pick(LAST); } while (seen.has(n)); seen.add(n);
    const type = pick(TYPES);
    list.push({ name: n, firm: type === "Angel" && rnd() < .5 ? "" : pick(FA) + " " + pick(FB), title: pick(TITLES), type, ind: pick(IND), fit: fits[i] });
  }
  list.sort((a, b) => b.fit - a.fit || a.name.localeCompare(b.name));
  window.INV = list;
  window.pips = (n, mini) => `<span class="pips${mini ? " mini" : ""}" title="fit ${n}/5">${[1,2,3,4,5].map((k) => `<i class="${k <= n ? "f" : ""}"></i>`).join("")}</span>`;
  window.prioChip = (f) => f === 5 ? '<span class="chip hot">Hot</span>' : f === 4 ? '<span class="chip warm">Warm</span>' : f === 3 ? '<span class="chip maybe">Maybe</span>' : '<span class="chip low">Low fit</span>';
  window.STAGES = [
    { k: "new", label: "New", c: "slate" }, { k: "res", label: "Researching", c: "violet" }, { k: "con", label: "Contacted", c: "cobalt" },
    { k: "rep", label: "Replied", c: "teal" }, { k: "mtg", label: "Meeting", c: "amber" }, { k: "dd", label: "Diligence", c: "orange" },
    { k: "com", label: "Committed", c: "green" }, { k: "pas", label: "Passed", c: "gray" },
  ];
})();
