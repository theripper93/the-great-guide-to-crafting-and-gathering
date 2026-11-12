const MOD = "the-great-guide-to-crafting-and-gathering";
const ITEM_PACKS = ["ggcg-materials", "ggcg-goods", "ggcg-tools"];
const TABLE_PACK = "ggcg-tables";
const KINDS = ["raw", "intermediate", "finished", "tool"];
const TIERS = [1, 2, 3, 4, 5];
const LIMIT = 60;
const OPEN_GROUP = 10;
const L = (key, data) => (data ? game.i18n.format(`GGCG.${key}`, data) : game.i18n.localize(`GGCG.${key}`));
const APP_ID = "ggcg-tools";

let packData = null;
let worldData = null;

const refresh = foundry.utils.debounce(() => foundry.applications.instances.get(APP_ID)?.panels.lookup.refresh(), 250);

const isOurPack = doc => doc?.pack?.startsWith(`${MOD}.`);
const isOurJournal = journal => !!(journal?.getFlag(MOD, "book") || journal?.getFlag(MOD, "processBook") || journal?.getFlag(MOD, "activity"));

for ( const type of ["Item", "RollTable"] ) {
  for ( const action of ["create", "update", "delete"] ) {
    Hooks.on(`${action}${type}`, doc => {
      if ( !isOurPack(doc) ) return;
      packData = null;
      worldData = null;
      refresh();
    });
  }
}
for ( const action of ["create", "update", "delete"] ) {
  Hooks.on(`${action}JournalEntry`, journal => {
    if ( isOurJournal(journal) ) { worldData = null; refresh(); }
  });
  Hooks.on(`${action}JournalEntryPage`, page => {
    if ( isOurJournal(page.parent) ) { worldData = null; refresh(); }
  });
}

async function loadPacks() {
  const items = new Map();
  for ( const name of ITEM_PACKS ) {
    const pack = game.packs.get(`${MOD}.${name}`);
    if ( !pack ) continue;
    const index = await pack.getIndex({ fields: [`flags.${MOD}`, "flags.mastercrafted.tags"] });
    for ( const e of index ) {
      const f = e.flags?.[MOD] ?? {};
      items.set(e.uuid, {
        uuid: e.uuid, name: e.name, img: e.img, slug: f.slug ?? null, kind: f.kind ?? null, tier: Number(f.tier) || null,
        subcategory: f.subcategory ?? null, activity: f.activity ?? null, profession: f.profession ?? null,
        tags: e.flags?.mastercrafted?.tags ?? []
      });
    }
  }
  const tables = [];
  const pack = game.packs.get(`${MOD}.${TABLE_PACK}`);
  for ( const table of (await pack?.getDocuments()) ?? [] ) {
    const f = table.flags?.[MOD] ?? {};
    const total = table.results.reduce((sum, r) => sum + r.weight, 0);
    tables.push({
      uuid: table.uuid, name: table.name, activity: f.activity ?? null, source: f.source ?? null, tier: Number(f.tier) || null,
      mishap: !!f.mishap, results: table.results.filter(r => r.documentUuid).map(r => ({
        uuid: r.documentUuid, chance: total ? (r.weight / total) * 100 : null, qty: r.flags?.gatherer?.quantity ?? "1"
      }))
    });
  }
  return { items, tables };
}

function readWorld(items) {
  const byTag = new Map();
  for ( const item of items.values() ) for ( const tag of item.tags ) {
    if ( !byTag.has(tag) ) byTag.set(tag, []);
    byTag.get(tag).push(item);
  }
  const books = game.journal.filter(j => j.getFlag(MOD, "book")).sort((a, b) => a.sort - b.sort);
  const processes = new Map();
  for ( const journal of game.journal.filter(j => j.getFlag(MOD, "processBook")) ) {
    for ( const page of journal.pages ) if ( page.getFlag(MOD, "process") ) processes.set(page.getFlag(MOD, "process"), page.uuid);
  }
  const gathererPages = new Map();
  const toolUses = [];
  for ( const journal of game.journal.filter(j => j.getFlag(MOD, "activity")).sort((a, b) => a.sort - b.sort) ) {
    for ( const page of journal.pages ) {
      if ( page.system?.table ) gathererPages.set(page.system.table, page.uuid);
      toolUses.push({ group: journal.name, pages: true, require: page.system?.require });
    }
  }
  const recipes = [];
  for ( const [order, journal] of books.entries() ) {
    for ( const page of journal.pages.contents.sort((a, b) => a.sort - b.sort) ) {
      const mc = page.flags?.mastercrafted;
      const f = page.flags?.[MOD];
      if ( !mc || !f?.slug ) continue;
      const slots = (mc.ingredients ?? []).map(slot => (slot.components ?? []).map(c => {
        const tag = c.tags?.[0] ?? null;
        return { name: c.name, qty: Number(c.quantity) || 1, currency: c.currency || null, tag,
          item: c.uuid ? items.get(c.uuid) ?? null : null, members: tag ? byTag.get(tag) ?? [] : [] };
      }));
      const products = (mc.products ?? []).flatMap(p => p.components ?? []).map(c => ({ item: items.get(c.uuid) ?? null, qty: Number(c.quantity) || 1 }));
      recipes.push({ uuid: page.uuid, name: page.name, slug: f.slug, tier: Number(f.tier) || null, book: journal.name, bookOrder: order,
        modification: page.type === "mastercrafted.modification", slots, products, process: processes.get(f.slug) ?? null });
      toolUses.push({ group: journal.name, pages: false, require: mc.require });
    }
  }
  return { books: books.length, recipes, gathererPages, toolUses };
}

function addToolUses(items, toolUses) {
  const byName = new Map([...items.values()].filter(i => i.kind === "tool").map(i => [i.name, i]));
  for ( const { group, pages, require } of toolUses ) {
    for ( const name of String(require ?? "").split(",").map(n => n.trim()) ) {
      const item = byName.get(name);
      if ( !item ) continue;
      let entry = item.toolFor.find(e => e.group === group);
      if ( !entry ) item.toolFor.push(entry = { group, pages, count: 0 });
      entry.count++;
    }
  }
}

async function getData() {
  packData ??= await loadPacks();
  if ( worldData ) return worldData;
  const items = new Map([...packData.items].map(([uuid, item]) => [uuid, { ...item, drops: [], made: [], uses: [], toolFor: [], names: [] }]));
  const world = readWorld(items);
  addToolUses(items, world.toolUses);
  for ( const table of packData.tables ) {
    for ( const r of table.results ) {
      items.get(r.uuid)?.drops.push({ table, chance: r.chance, qty: r.qty, page: world.gathererPages.get(table.uuid) ?? null });
    }
  }
  for ( const recipe of world.recipes ) {
    for ( const p of recipe.products ) if ( p.item ) {
      p.item.made.push({ recipe, qty: p.qty });
      if ( recipe.name !== p.item.name ) p.item.names.push(recipe.name);
    }
    for ( const slot of recipe.slots ) for ( const c of slot ) {
      for ( const item of c.item ? [c.item] : c.members ) item.uses.push({ recipe, qty: c.qty, via: c.item ? null : c.name });
    }
  }
  const list = [...items.values()].map(item => ({ ...item, search: [item.name, ...item.names, item.slug ?? ""].join("\n").toLowerCase() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  worldData = { items: new Map(list.map(i => [i.uuid, i])), list, books: world.books };
  return worldData;
}

const tierLabel = tier => (tier >= 5 ? L("Lookup.Artifact") : L("Tracker.TierN", { tier }));

function titleCase(slug) {
  return String(slug).split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function placeLabel(source) {
  const key = `GGCG.Nodes.Places.${source}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : titleCase(source);
}

function creatureLabel(type) {
  const label = CONFIG.DND5E?.creatureTypes?.[type]?.label;
  return label ? game.i18n.localize(label) : titleCase(type);
}

function activityLabel(activity) {
  const key = `GGCG.Lookup.Activities.${activity}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : titleCase(activity);
}

function chanceLabel(chance) {
  if ( chance === null ) return "";
  const rounded = chance < 10 ? Math.round(chance * 10) / 10 : Math.round(chance);
  return `${rounded}%`;
}

function metaOf(item) {
  const bits = [L(`Lookup.Kinds.${item.kind}`)];
  if ( item.kind === "raw" && item.activity ) bits.push(activityLabel(item.activity));
  if ( item.kind === "finished" && item.profession ) bits.push(titleCase(item.profession));
  if ( item.tier ) bits.push(tierLabel(item.tier));
  return bits.join(" · ");
}

function search(list, { query, kind, tier }) {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hits = list.filter(i => (!kind || (i.kind === kind)) && (!tier || (i.tier === tier)) && words.every(w => i.search.includes(w)));
  if ( !q ) return hits;
  const rank = i => {
    const name = i.name.toLowerCase();
    if ( name === q ) return 0;
    if ( name.startsWith(q) ) return 1;
    if ( name.split(/[\s-]+/).some(w => w.startsWith(words[0])) ) return 2;
    return 3;
  };
  return hits.map(i => [rank(i), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
}

function findItem(list, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if ( !q ) return null;
  return list.find(i => i.uuid.toLowerCase() === q) ?? list.find(i => i.slug === q) ?? list.find(i => i.name.toLowerCase() === q)
    ?? list.find(i => i.names.some(n => n.toLowerCase() === q)) ?? null;
}

function sourceRows(item) {
  return item.drops.filter(d => !d.table.mishap).map(d => {
    const t = d.table;
    const where = t.activity === "monster"
      ? [L("Lookup.Harvest", { type: creatureLabel(t.source) })]
      : [activityLabel(t.activity), placeLabel(t.source), t.tier ? tierLabel(t.tier) : null];
    return {
      label: where.filter(Boolean).join(" · "), chance: chanceLabel(d.chance), qty: d.qty !== "1" ? d.qty : null,
      open: d.page ?? t.uuid, tooltip: L(d.page ? "Lookup.OpenPage" : "Lookup.OpenTable"),
      sort: [t.activity === "monster" ? 0 : 1, t.tier ?? 0, -(d.chance ?? 0)]
    };
  }).sort((a, b) => (a.sort[0] - b.sort[0]) || (a.sort[1] - b.sort[1]) || (a.sort[2] - b.sort[2]));
}

function slotLabel(slot) {
  return slot.map(c => {
    const members = c.members.map(m => m.name).sort();
    return {
      text: `${c.qty} ${c.name}`, uuid: c.item?.uuid ?? null,
      tooltip: members.length ? members.slice(0, 12).join(", ") + (members.length > 12 ? ", ..." : "") : null
    };
  });
}

function madeRows(item) {
  return item.made.map(({ recipe, qty }) => ({
    name: recipe.name, uuid: recipe.uuid, book: recipe.book, tier: tierLabel(recipe.tier), qty: qty > 1 ? qty : null,
    process: recipe.process, needs: recipe.slots.map(slotLabel)
  }));
}

function useGroups(item) {
  const groups = new Map();
  const seen = new Set();
  for ( const use of item.uses ) {
    const key = `${use.recipe.uuid}|${use.via ?? ""}`;
    if ( seen.has(key) ) continue;
    seen.add(key);
    const r = use.recipe;
    if ( !groups.has(r.book) ) groups.set(r.book, { book: r.book, order: r.bookOrder, rows: [] });
    const product = r.products[0]?.item ?? null;
    groups.get(r.book).rows.push({
      name: r.name, uuid: r.uuid, tierNum: r.tier ?? 0, tier: tierLabel(r.tier), qty: use.qty, via: use.via,
      modification: r.modification, product: product?.uuid ?? null
    });
  }
  const total = seen.size;
  return [...groups.values()].sort((a, b) => a.order - b.order).map(g => ({
    ...g, count: g.rows.length, open: total <= OPEN_GROUP,
    rows: g.rows.sort((a, b) => (a.tierNum - b.tierNum) || a.name.localeCompare(b.name))
  }));
}

function detailOf(item) {
  const trophy = item.subcategory === "boss-trophies";
  const sources = sourceRows(item);
  const made = madeRows(item);
  let note = null;
  if ( trophy ) {
    const types = [...new Set(item.drops.map(d => d.table.source).filter(Boolean))].map(creatureLabel);
    note = L("Lookup.Trophy", { type: types.join(", ") || "?" });
  } else if ( !sources.length && !made.length ) note = L("Lookup.NoSource");
  const uses = useGroups(item);
  const toolFor = item.toolFor.map(e => L(e.pages ? "Lookup.ToolPages" : "Lookup.ToolRecipes", { count: e.count, group: e.group }));
  return { item: { ...item, meta: metaOf(item) }, note, sources, made, uses, toolFor, useCount: uses.reduce((n, g) => n + g.count, 0) };
}

export class LookupPanel {
  static TAB = { id: "lookup", icon: "fa-solid fa-magnifying-glass", label: "GGCG.Lookup.Title" };

  static PARTS = {
    lookupSearch: { template: `modules/${MOD}/templates/lookup-search.hbs` },
    lookupResults: { template: `modules/${MOD}/templates/lookup-results.hbs`, scrollable: [""] },
    lookupDetail: { template: `modules/${MOD}/templates/lookup-detail.hbs`, scrollable: [""] }
  };

  static ACTIONS = { lookupSelect: "select", lookupOpen: "open" };

  constructor(app) {
    this.app = app;
  }

  query = "";

  kind = "";

  tier = 0;

  selected = null;

  #loaded = false;

  #debounced = foundry.utils.debounce(() => this.app.render({ parts: ["lookupResults"] }), 120);

  refresh() {
    if ( this.app.rendered && this.#loaded ) this.app.render({ parts: ["lookupResults", "lookupDetail"] });
  }

  shown() {
    if ( !this.#loaded ) this.app.render({ parts: Object.keys(LookupPanel.PARTS) });
  }

  async search(query) {
    const hit = findItem((await getData()).list, query);
    this.query = hit?.name ?? String(query);
    this.kind = "";
    this.tier = 0;
    this.selected = hit?.uuid ?? this.selected;
    if ( this.app.rendered ) await this.app.render({ parts: Object.keys(LookupPanel.PARTS) });
  }

  focus() {
    this.app.element?.querySelector("input[name=lookupQuery]")?.focus();
  }

  async prepare(partId, context) {
    if ( !this.#loaded && !context.tab.active ) return { ...context, kinds: [], tiers: [] };
    const data = await getData();
    this.#loaded = true;
    if ( partId === "lookupSearch" ) {
      const version = game.modules.get(MOD).version;
      const imported = game.settings.get(MOD, "importedVersion");
      return Object.assign(context, {
        query: this.query,
        kind: this.kind,
        tier: this.tier || "",
        kinds: KINDS.map(k => ({ value: k, label: L(`Lookup.Kinds.${k}`) })),
        tiers: TIERS.map(t => ({ value: t, label: tierLabel(t) })),
        warning: !data.books ? L("Lookup.NotImported") : (imported && (imported !== version)) ? L("Lookup.OldImport", { imported, version }) : null
      });
    }
    if ( partId === "lookupResults" ) {
      const hits = search(data.list, { query: this.query, kind: this.kind, tier: this.tier });
      return Object.assign(context, {
        results: hits.slice(0, LIMIT).map(i => ({ uuid: i.uuid, name: i.name, img: i.img, meta: metaOf(i), selected: i.uuid === this.selected })),
        more: hits.length > LIMIT ? L("Lookup.More", { count: hits.length - LIMIT }) : null,
        count: L(hits.length === 1 ? "Lookup.CountOne" : "Lookup.Count", { count: hits.length })
      });
    }
    const item = data.items.get(this.selected);
    return Object.assign(context, { detail: item ? detailOf(item) : null });
  }

  listen(element) {
    element.addEventListener("input", ev => {
      if ( ev.target.name !== "lookupQuery" ) return;
      this.query = ev.target.value;
      this.#debounced();
    });
    element.addEventListener("keydown", ev => {
      if ( (ev.target.name !== "lookupQuery") || (ev.key !== "Enter") ) return;
      ev.preventDefault();
      const first = element.querySelector(".ggcg-lookup-results [data-uuid]");
      if ( first ) this.#select(first.dataset.uuid);
    });
    element.addEventListener("dragstart", ev => {
      const uuid = ev.target.closest?.("[data-drag-uuid]")?.dataset.dragUuid;
      if ( uuid ) ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid }));
    });
  }

  change(target) {
    if ( target.name === "lookupKind" ) this.kind = target.value;
    else if ( target.name === "lookupTier" ) this.tier = Number(target.value);
    else return;
    this.app.render({ parts: ["lookupResults"] });
  }

  #select(uuid) {
    this.selected = uuid;
    this.app.render({ parts: ["lookupResults", "lookupDetail"] });
  }

  select(event, target) {
    this.#select(target.dataset.uuid);
  }

  async open(event, target) {
    event.stopPropagation();
    const doc = await fromUuid(target.dataset.open);
    if ( !doc ) {
      ui.notifications.warn(L("Lookup.Missing"));
      return;
    }
    doc.sheet.render({ force: true });
  }
}
