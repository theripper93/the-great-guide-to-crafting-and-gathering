const MOD = "the-great-guide-to-crafting-and-gathering";
const GATHERER = "gatherer";
const PAGE_TYPE = "gatherer.gatherer";
const NODE_COLORS = { gathering: "#3f8f3a", hunting: "#9a5b2b", mining: "#7d7d8a", fishing: "#2f6fa8" };
const L = (key, data) => (data ? game.i18n.format(`GGCG.${key}`, data) : game.i18n.localize(`GGCG.${key}`));
const APP_ID = "ggcg-tools";

export function registerNodePlacer(moduleApi) {
  Object.assign(moduleApi, { placeNode, nodePages });
}

const refresh = foundry.utils.debounce(() => foundry.applications.instances.get(APP_ID)?.panels.nodes.refresh(), 250);
for ( const action of ["create", "update", "delete"] ) {
  Hooks.on(`${action}JournalEntry`, journal => {
    if ( journal.getFlag(MOD, "activity") ) refresh();
  });
  Hooks.on(`${action}JournalEntryPage`, page => {
    if ( page.parent?.getFlag(MOD, "activity") ) refresh();
  });
}

function gathererActive() {
  return !!game.modules.get(GATHERER)?.active && !!game.modules.get(GATHERER).API?.placeNode;
}

function nodePages() {
  const entries = [];
  const journals = game.journal.filter(j => j.getFlag(MOD, "activity")).sort((a, b) => a.sort - b.sort);
  for ( const journal of journals ) {
    for ( const page of journal.pages.contents.sort((a, b) => a.sort - b.sort) ) {
      const f = page.flags?.[MOD];
      if ( (page.type !== PAGE_TYPE) || !f?.activity || (f.activity === "monster") || !f.source || !f.tier ) continue;
      entries.push({ page, activity: f.activity, activityLabel: journal.name, source: f.source, tier: Number(f.tier) });
    }
  }
  return entries;
}

function placeLabel(source) {
  const key = `GGCG.Nodes.Places.${source}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : source.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function describe(entry) {
  const system = entry.page.system;
  const check = String(system.checks?.[0] ?? "");
  const dc = check.match(/dc=(\d+)/)?.[1] ?? "?";
  const [kind, key] = (check.match(/check=([^|]+)/)?.[1] ?? "").split(".");
  const config = { skill: CONFIG.DND5E?.skills, ability: CONFIG.DND5E?.abilities, tool: CONFIG.DND5E?.tools }[kind];
  const skill = config?.[key]?.label ?? key ?? "?";
  return { check: L("Nodes.Check", { check: game.i18n.localize(skill), dc }), tools: system.require?.trim() || L("Nodes.NoTools") };
}

async function placeNode(page, element) {
  if ( !game.user.isGM ) return;
  if ( !gathererActive() ) {
    ui.notifications.warn(L("Nodes.NoGatherer"));
    return;
  }
  if ( typeof page === "string" ) page = await fromUuid(page);
  if ( page?.type !== PAGE_TYPE ) {
    ui.notifications.warn(L("Nodes.NotAPage"));
    return;
  }
  return game.modules.get(GATHERER).API.placeNode(page, {
    element,
    region: { color: NODE_COLORS[page.getFlag(MOD, "activity")] ?? NODE_COLORS.gathering, flags: { [MOD]: { page: page.getFlag(MOD, "slug") } } },
    behavior: { name: page.name, system: { mode: "instance" } }
  });
}

export class NodePanel {
  static TAB = { id: "nodes", icon: "fa-solid fa-location-dot", label: "GGCG.Nodes.Title" };

  static PARTS = {
    nodes: { template: `modules/${MOD}/templates/node-placer.hbs` }
  };

  static ACTIONS = { nodesPlace: "place", nodesOpen: "open" };

  constructor(app) {
    this.app = app;
  }

  activity = null;

  source = null;

  tier = null;

  refresh() {
    if ( this.app.rendered ) this.app.render({ parts: Object.keys(NodePanel.PARTS) });
  }

  #choose(entries) {
    const first = (list, value) => (list.includes(value) ? value : list[0] ?? null);
    this.activity = first([...new Set(entries.map(e => e.activity))], this.activity);
    const ofActivity = entries.filter(e => e.activity === this.activity);
    this.source = first([...new Set(ofActivity.map(e => e.source))], this.source);
    const ofSource = ofActivity.filter(e => e.source === this.source);
    this.tier = first([...new Set(ofSource.map(e => e.tier))].sort((a, b) => a - b), this.tier);
    return { ofActivity, ofSource, entry: ofSource.find(e => e.tier === this.tier) ?? null };
  }

  prepare(partId, context) {
    const active = gathererActive();
    const entries = active ? nodePages() : [];
    const { ofActivity, ofSource, entry } = this.#choose(entries);
    const unique = (list, key) => list.filter((e, i) => list.findIndex(o => o[key] === e[key]) === i);
    const field = label => new foundry.data.fields.StringField({ label: L(label), required: true, blank: false });
    return Object.assign(context, {
      fields: { activity: field("Nodes.Activity"), source: field("Nodes.Place"), tier: field("Nodes.Tier") },
      activity: this.activity,
      source: this.source,
      tier: this.tier,
      activities: unique(entries, "activity").map(e => ({ value: e.activity, label: e.activityLabel })),
      places: unique(ofActivity, "source").map(e => ({ value: e.source, label: placeLabel(e.source) })),
      tiers: unique(ofSource, "tier").sort((a, b) => a.tier - b.tier).map(e => ({ value: e.tier, label: L("Tracker.TierN", { tier: e.tier }) })),
      name: entry?.page.name ?? null,
      uuid: entry?.page.uuid ?? null,
      info: entry ? describe(entry) : null,
      warning: !active ? L("Nodes.NoGatherer") : !entries.length ? L("Nodes.NotImported") : null
    });
  }

  change(target) {
    const name = { nodeActivity: "activity", nodeSource: "source", nodeTier: "tier" }[target.name];
    if ( !name ) return;
    this[name] = name === "tier" ? Number(target.value) : target.value;
    this.refresh();
  }

  open(event, target) {
    fromUuidSync(target.dataset.uuid)?.sheet.render({ force: true });
  }

  async place() {
    const { entry } = this.#choose(gathererActive() ? nodePages() : []);
    if ( !entry ) {
      ui.notifications.warn(L(gathererActive() ? "Nodes.NotImported" : "Nodes.NoGatherer"));
      return;
    }
    try {
      await placeNode(entry.page, this.app.element);
    } catch(err) {
      console.error(`${MOD} |`, err);
      ui.notifications.error(L("Nodes.Failed", { error: err.message }));
    }
  }
}
