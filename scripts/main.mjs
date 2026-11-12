import { registerTracker } from "./tracker.mjs";
import { registerNodePlacer } from "./nodes.mjs";
import { registerGMTools } from "./gm-tools.mjs";

const MOD = "the-great-guide-to-crafting-and-gathering";
const PACK = `${MOD}.ggcg-adventure`;
const { DialogV2 } = foundry.applications.api;
const L = (key, data) => (data ? game.i18n.format(`GGCG.${key}`, data) : game.i18n.localize(`GGCG.${key}`));

Hooks.once("init", () => {
  game.settings.register(MOD, "importedVersion", { scope: "world", config: false, type: String, default: "" });
  game.settings.register(MOD, "skipPromptVersion", { scope: "world", config: false, type: String, default: "" });
  game.settings.register(MOD, "noCraftTime", { scope: "world", config: false, type: Boolean, default: false });
  game.settings.register(MOD, "noCraftChecks", { scope: "world", config: false, type: Boolean, default: false });
  game.settings.register(MOD, "enforceStacking", {
    name: "GGCG.Settings.EnforceStacking.Name", hint: "GGCG.Settings.EnforceStacking.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.registerMenu(MOD, "importMenu", {
    name: "GGCG.Settings.ImportMenu.Name", label: "GGCG.Settings.ImportMenu.Label", hint: "GGCG.Settings.ImportMenu.Hint",
    icon: "fa-solid fa-file-import", type: ImportPrompt, restricted: true
  });
  game.settings.registerMenu(MOD, "harvestDrawsMenu", {
    name: "GGCG.Settings.HarvestDrawsMenu.Name", label: "GGCG.Settings.HarvestDrawsMenu.Label", hint: "GGCG.Settings.HarvestDrawsMenu.Hint",
    icon: "fa-solid fa-paw", type: HarvestDrawsPrompt, restricted: true
  });
  game.modules.get(MOD).api = {
    importContent, mergeHarvestMapping, unlockRecipes, getAdventure, setHarvestDraws, harvestDrawsFor,
    prompt: () => new ImportPrompt().render({ force: true }),
    harvestDrawsPrompt: () => new HarvestDrawsPrompt().render({ force: true })
  };
  registerTracker(game.modules.get(MOD).api);
  registerNodePlacer(game.modules.get(MOD).api);
  registerGMTools(game.modules.get(MOD).api);
});

const ACTOR_GROUPS = new Set(["drink", "food", "charm"]);

async function enforceStackGroup(effect, userId) {
  if ( userId !== game.user.id ) return;
  if ( !game.settings.get(MOD, "enforceStacking") ) return;
  const actor = effect.parent;
  if ( !(actor instanceof Actor) || effect.disabled ) return;
  const group = effect.getFlag(MOD, "stackGroup");
  if ( !ACTOR_GROUPS.has(group) ) return;
  const older = actor.effects.filter(e => (e.id !== effect.id) && (e.getFlag(MOD, "stackGroup") === group)).map(e => e.id);
  if ( !older.length ) return;
  await actor.deleteEmbeddedDocuments("ActiveEffect", older);
  ui.notifications.info(L("Stacking.Replaced", { actor: actor.name, effect: effect.name, group: L(`Stacking.Group.${group}`) }));
}

Hooks.on("createActiveEffect", (effect, options, userId) => enforceStackGroup(effect, userId));
Hooks.on("updateActiveEffect", (effect, changes, options, userId) => {
  if ( changes.disabled === false ) enforceStackGroup(effect, userId);
});

Hooks.once("ready", () => {
  if ( !game.user.isGM || game.users.activeGM !== game.user ) return;
  const version = game.modules.get(MOD).version;
  const imported = game.settings.get(MOD, "importedVersion");
  const skipped = game.settings.get(MOD, "skipPromptVersion");
  if ( imported === version || skipped === version ) return;
  new ImportPrompt().render({ force: true });
});

async function getAdventure() {
  const pack = game.packs.get(PACK);
  if ( !pack ) throw new Error(`${MOD} | pack ${PACK} not found`);
  const index = await pack.getIndex();
  const entry = index.contents[0];
  if ( !entry ) throw new Error(`${MOD} | the Adventure pack is empty`);
  return pack.getDocument(entry._id);
}

async function applyCraftOptions(adventure, { noTime, noChecks } = {}) {
  const was = { time: game.settings.get(MOD, "noCraftTime"), checks: game.settings.get(MOD, "noCraftChecks") };
  const now = { time: noTime ?? was.time, checks: noChecks ?? was.checks };
  let count = 0;
  if ( now.time || now.checks || was.time || was.checks ) {
    const shipped = new Map();
    const shippedChecks = new Map();
    for ( const j of adventure.toObject().journal ?? [] ) for ( const p of j.pages ?? [] ) {
      shipped.set(p._id, p.flags?.mastercrafted ?? {});
      if ( p.type === "gatherer.gatherer" ) shippedChecks.set(p._id, p.system?.checks ?? []);
    }
    for ( const journal of game.journal ) {
      if ( journal.getFlag(MOD, "activity") ) {
        const updates = [];
        for ( const page of journal.pages ) {
          const src = shippedChecks.get(page.id);
          if ( !src || (page.type !== "gatherer.gatherer") ) continue;
          const has = (page.system?.checks ?? []).filter(Boolean).length > 0;
          if ( now.checks ) { if ( has ) updates.push({ _id: page.id, "system.checks": [] }); }
          else if ( was.checks && !has && src.length ) updates.push({ _id: page.id, "system.checks": src });
        }
        if ( updates.length ) { await journal.updateEmbeddedDocuments("JournalEntryPage", updates); count += updates.length; }
        continue;
      }
      if ( !journal.getFlag(MOD, "book") ) continue;
      const updates = [];
      for ( const page of journal.pages ) {
        const mc = page.flags?.mastercrafted;
        const src = shipped.get(page.id);
        if ( !mc || !src || !page.flags?.[MOD]?.slug ) continue;
        const update = {};
        if ( now.time ) { if ( mc.time ) update["flags.mastercrafted.time"] = 0; }
        else if ( was.time && (mc.time !== src.time) ) update["flags.mastercrafted.time"] = src.time ?? null;
        if ( now.checks ) { if ( mc.checks?.length ) update["flags.mastercrafted.checks"] = []; }
        else if ( was.checks && !mc.checks?.length && src.checks?.length ) update["flags.mastercrafted.checks"] = src.checks;
        if ( Object.keys(update).length ) updates.push({ _id: page.id, ...update });
      }
      if ( updates.length ) { await journal.updateEmbeddedDocuments("JournalEntryPage", updates); count += updates.length; }
    }
  }
  await game.settings.set(MOD, "noCraftTime", !!now.time);
  await game.settings.set(MOD, "noCraftChecks", !!now.checks);
  return count;
}

async function importContent({ overwrite = false, harvest = true, noTime, noChecks } = {}) {
  const adventure = await getAdventure();
  const { toCreate, toUpdate, documentCount } = await adventure.prepareImport({ importFields: [] });
  const result = { created: 0, pagesAdded: 0, updated: 0, harvestTypes: [] };

  const imported = await adventure.importContent({ toCreate, toUpdate: overwrite ? toUpdate : {}, documentCount });
  for ( const docs of Object.values(imported.created ?? {}) ) result.created += docs.length;
  for ( const docs of Object.values(imported.updated ?? {}) ) result.updated += docs.length;

  if ( !overwrite ) {
    for ( const data of toUpdate.JournalEntry ?? [] ) {
      const journal = game.journal.get(data._id);
      if ( !journal ) continue;
      const categories = (data.categories ?? []).filter(c => !journal.categories?.has(c._id));
      if ( categories.length ) await journal.createEmbeddedDocuments("JournalEntryCategory", categories, { keepId: true });
      const pages = (data.pages ?? []).filter(p => !journal.pages.has(p._id));
      if ( pages.length ) {
        await journal.createEmbeddedDocuments("JournalEntryPage", pages, { keepId: true });
        result.pagesAdded += pages.length;
      }
    }
  }

  if ( harvest ) result.harvestTypes = await mergeHarvestMapping(adventure);
  result.craftPages = await applyCraftOptions(adventure, { noTime, noChecks });
  await game.modules.get(MOD).api.reapplyUnlocks();
  await game.settings.set(MOD, "importedVersion", game.modules.get(MOD).version);
  ui.notifications.info(L("Import.Done", { created: result.created, pages: result.pagesAdded, updated: result.updated }));
  return result;
}

async function mergeHarvestMapping(adventure) {
  adventure ??= await getAdventure();
  const ours = adventure.flags?.[MOD]?.harvestMapping ?? {};
  const ourJournals = new Set(adventure.journal.map(j => j.id ?? j._id));
  const isOurs = uuid => ourJournals.has(String(uuid).split(".")[1]);
  const current = foundry.utils.deepClone(game.settings.get("gatherer", "creatureTypes") ?? {});
  const written = [];
  for ( const [type, entry] of Object.entries(ours) ) {
    const existing = current[type] ?? {};
    const mapped = existing.pages ?? (existing.page ? [{ page: existing.page }] : []);
    const pages = entry.pages.filter(p => fromUuidSync(p.page, { strict: false }))
      .map(p => ({ ...p, weight: mapped.find(m => m.page === p.page)?.weight ?? p.weight }));
    if ( !pages.length ) continue;
    const shipped = new Set(pages.map(p => p.page));
    const theirs = mapped.filter(p => p.page && !shipped.has(p.page) && (!isOurs(p.page) || fromUuidSync(p.page, { strict: false })));
    current[type] = { ...existing, pages: [...theirs, ...pages], draws: existing.draws ?? entry.draws ?? null };
    delete current[type].page;
    written.push(type);
  }
  await game.settings.set("gatherer", "creatureTypes", current);
  return written;
}

async function unlockRecipes(userIds, { tiers = [], books = null, recipes = null, level = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER } = {}) {
  let count = 0;
  for ( const journal of game.journal ) {
    const book = journal.getFlag(MOD, "book");
    const processes = !!journal.getFlag(MOD, "processBook");
    if ( processes ? !recipes : (!book || (books && !books.includes(book))) ) continue;
    const updates = [];
    for ( const page of journal.pages ) {
      const f = page.flags?.[MOD] ?? {};
      const match = processes ? recipes.includes(f.process) : recipes ? recipes.includes(f.slug) : (tiers.includes(f.tier) && !f.unlockSingly);
      if ( !match ) continue;
      const users = userIds.filter(u => (page.ownership[u] ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE) !== level);
      if ( !users.length ) continue;
      const ownership = {};
      for ( const u of users ) ownership[u] = level;
      updates.push({ _id: page.id, ownership });
    }
    if ( updates.length ) {
      await journal.updateEmbeddedDocuments("JournalEntryPage", updates);
      if ( !processes ) count += updates.length;
    }
  }
  return count;
}

async function harvestDrawsTable() {
  const adventure = await getAdventure();
  return [...(adventure.flags?.[MOD]?.drawsByChallenge ?? [])].sort((a, b) => Number(a.maxCr) - Number(b.maxCr));
}

function harvestDrawsFor(cr, table) {
  if ( !Number.isFinite(cr) || !table?.length ) return null;
  return Number((table.find(e => cr <= Number(e.maxCr)) ?? table.at(-1)).draws);
}

async function setHarvestDraws(actors, { overwrite = false } = {}) {
  const table = await harvestDrawsTable();
  if ( !table.length ) throw new Error(`${MOD} | the Adventure has no drawsByChallenge table; rebuild the module`);
  const result = { updated: 0, skipped: 0 };
  const worldUpdates = [];
  for ( const actor of new Set(actors) ) {
    if ( actor?.type !== "npc" ) { result.skipped++; continue; }
    const current = actor.getFlag("gatherer", "draws");
    const draws = harvestDrawsFor(Number(actor.system.details?.cr), table);
    const hasValue = (current !== undefined) && (current !== null) && (current !== "");
    if ( (draws === null) || (hasValue && !overwrite) || (current === draws) ) { result.skipped++; continue; }
    if ( actor.isToken ) await actor.setFlag("gatherer", "draws", draws);
    else worldUpdates.push({ _id: actor.id, "flags.gatherer.draws": draws });
    result.updated++;
  }
  if ( worldUpdates.length ) await Actor.implementation.updateDocuments(worldUpdates);
  return result;
}

class HarvestDrawsPrompt extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ggcg-harvest-draws",
    tag: "form",
    window: { title: "GGCG.HarvestDraws.Title", icon: "fa-solid fa-paw" },
    position: { width: 460 },
    form: { handler: HarvestDrawsPrompt.#onSubmit, closeOnSubmit: true }
  };

  async _renderHTML() {
    let table = [];
    try {
      table = await harvestDrawsTable();
    } catch(err) {
      console.error(err);
    }
    let lower = 0;
    const rows = table.map(e => {
      const row = `<li>${L("HarvestDraws.Row", { from: lower, to: e.maxCr, draws: e.draws })}</li>`;
      lower = Number(e.maxCr) + 1;
      return row;
    }).join("");
    const div = document.createElement("div");
    div.classList.add("standard-form");
    div.innerHTML = `
      <p>${L("HarvestDraws.Intro")}</p>
      ${rows ? `<ul>${rows}</ul>` : `<p>${L("HarvestDraws.NoTable")}</p>`}
      <div class="form-group">
        <label>${L("HarvestDraws.Scope")}</label>
        <div class="form-fields">
          <select name="scope">
            <option value="selected">${L("HarvestDraws.ScopeSelected")}</option>
            <option value="scene">${L("HarvestDraws.ScopeScene")}</option>
            <option value="world">${L("HarvestDraws.ScopeWorld")}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="overwrite"> ${L("HarvestDraws.Overwrite")}</label>
        <p class="hint">${L("HarvestDraws.OverwriteHint")}</p>
      </div>
      <footer class="form-footer">
        <button type="submit" ${rows ? "" : "disabled"}><i class="fa-solid fa-paw"></i> ${L("HarvestDraws.Apply")}</button>
      </footer>`;
    return div;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  static async #onSubmit(event, form, formData) {
    const { scope, overwrite } = formData.object;
    let actors = [];
    if ( scope === "selected" ) actors = (canvas.tokens?.controlled ?? []).map(t => t.actor);
    else if ( scope === "scene" ) actors = (canvas.scene?.tokens ?? []).map(t => t.actor);
    else actors = game.actors.filter(a => a.type === "npc");
    actors = actors.filter(Boolean);
    if ( !actors.length ) {
      ui.notifications.warn(L("HarvestDraws.NoActors"));
      return;
    }
    try {
      const { updated, skipped } = await setHarvestDraws(actors, { overwrite: !!overwrite });
      ui.notifications.info(L("HarvestDraws.Done", { updated, skipped }));
    } catch(err) {
      console.error(err);
      ui.notifications.error(L("HarvestDraws.Failed", { error: err.message }));
    }
  }
}

class ImportPrompt extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ggcg-import-prompt",
    tag: "form",
    window: { title: "GGCG.Import.Title", icon: "fa-solid fa-book-atlas" },
    position: { width: 480 },
    form: { handler: ImportPrompt.#onSubmit, closeOnSubmit: true },
    actions: { later: ImportPrompt.#onLater, skip: ImportPrompt.#onSkip }
  };

  async _renderHTML() {
    const version = game.modules.get(MOD).version;
    const imported = game.settings.get(MOD, "importedVersion");
    const div = document.createElement("div");
    div.classList.add("standard-form");
    div.innerHTML = `
      <p>${L("Import.Intro", { version })}</p>
      ${imported ? `<p>${L("Import.Previous", { version: imported })}</p>` : ""}
      <div class="form-group">
        <label><input type="checkbox" name="harvest" checked> ${L("Import.Harvest")}</label>
        <p class="hint">${L("Import.HarvestHint")}</p>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="overwrite"> ${L("Import.Overwrite")}</label>
        <p class="hint">${L("Import.OverwriteHint")}</p>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="noTime" ${game.settings.get(MOD, "noCraftTime") ? "checked" : ""}> ${L("Import.NoTime")}</label>
        <p class="hint">${L("Import.NoTimeHint")}</p>
      </div>
      <div class="form-group">
        <label><input type="checkbox" name="noChecks" ${game.settings.get(MOD, "noCraftChecks") ? "checked" : ""}> ${L("Import.NoChecks")}</label>
        <p class="hint">${L("Import.NoChecksHint")}</p>
      </div>
      <footer class="form-footer">
        <button type="submit"><i class="fa-solid fa-file-import"></i> ${L("Import.Import")}</button>
        <button type="button" data-action="later">${L("Import.Later")}</button>
        <button type="button" data-action="skip">${L("Import.Skip")}</button>
      </footer>`;
    return div;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    try {
      await importContent({ overwrite: !!data.overwrite, harvest: !!data.harvest, noTime: !!data.noTime, noChecks: !!data.noChecks });
    } catch(err) {
      console.error(err);
      ui.notifications.error(L("Import.Failed", { error: err.message }));
    }
  }

  static #onLater() {
    this.close();
  }

  static async #onSkip() {
    await game.settings.set(MOD, "skipPromptVersion", game.modules.get(MOD).version);
    this.close();
  }
}
