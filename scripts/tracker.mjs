const MOD = "the-great-guide-to-crafting-and-gathering";
const REFINING = "refining";
const TIERS = [1, 2, 3, 4];
const L = (key, data) => (data ? game.i18n.format(`GGCG.${key}`, data) : game.i18n.localize(`GGCG.${key}`));
const APP_ID = "ggcg-tools";

let api = {};
let rule = null;
let queue = Promise.resolve();

export function registerTracker(moduleApi) {
  api = moduleApi;
  game.settings.register(MOD, "unlockMode", {
    name: "GGCG.Settings.UnlockMode.Name", hint: "GGCG.Settings.UnlockMode.Hint",
    scope: "world", config: true, type: String, default: "manual",
    choices: { manual: "GGCG.Settings.UnlockMode.Manual", auto: "GGCG.Settings.UnlockMode.Auto" },
    onChange: () => {
      evaluateAll();
      refresh();
    }
  });
  Object.assign(moduleApi, {
    craftHistory, setTierUnlock, setRecipeUnlock, practiceProgress, reapplyUnlocks, evaluateUnlocks: evaluateAll, unlockRule: () => rule
  });
}

Hooks.on("mastercraftedCrafted", (recipe, data) => recordCraft(recipe, data));

Hooks.once("ready", async () => {
  if ( !game.user.isGM ) return;
  try {
    rule = (await api.getAdventure()).flags?.[MOD]?.unlockRule ?? null;
  } catch(err) {
    rule = null;
  }
  evaluateAll();
});

Hooks.on("updateActor", (actor, changes) => {
  if ( !game.user.isGM ) return;
  const ours = changes.flags?.[MOD];
  if ( ours ) refresh();
  if ( ours?.crafted || foundry.utils.hasProperty(changes, "system.details.level") ) evaluate(actor);
});

for ( const hook of ["createItem", "updateItem", "deleteItem"] ) {
  Hooks.on(hook, item => {
    if ( !game.user.isGM || (item.type !== "class") || !(item.parent instanceof Actor) ) return;
    evaluate(item.parent);
    refresh();
  });
}

function refresh() {
  foundry.applications.instances.get(APP_ID)?.panels.tracker.refresh();
}

function recipeInfo(page) {
  const f = page?.flags?.[MOD];
  const book = page?.parent?.getFlag?.(MOD, "book");
  if ( !f?.slug || !book ) return null;
  return { slug: f.slug, book, tier: Number(f.tier), unlockSingly: !!f.unlockSingly, page };
}

function characterOf(actor) {
  if ( actor?.isToken ) return game.actors.get(actor.id) ?? null;
  return actor ?? null;
}

async function recordCraft(recipe, { actor, count } = {}) {
  const info = recipeInfo(recipe?.document ?? fromUuidSync(recipe?.pageUuid ?? "", { strict: false }));
  const target = characterOf(actor);
  if ( !info || !target?.isOwner ) return;
  const previous = target.getFlag(MOD, "crafted")?.[info.slug];
  const now = Date.now();
  await target.update({ [`flags.${MOD}.crafted.${info.slug}`]: {
    book: info.book, tier: info.tier, count: (previous?.count ?? 0) + (Number(count) || 1),
    first: previous?.first ?? now, last: now, worldTime: game.time.worldTime, user: game.user.id
  } });
}

function craftHistory(actor) {
  return characterOf(actor)?.getFlag(MOD, "crafted") ?? {};
}

function distinctCrafted(actor, book, tier) {
  return Object.entries(craftHistory(actor)).filter(([, c]) => (c.book === book) && (Number(c.tier) === tier)).map(([slug]) => slug);
}

function unlocksOf(actor) {
  const u = actor.getFlag(MOD, "unlocks") ?? {};
  return { tiers: foundry.utils.deepClone(u.tiers ?? {}), recipes: [...(u.recipes ?? [])] };
}

function hasTier(actor, book, tier) {
  return (tier === 1) || !!unlocksOf(actor).tiers[book]?.includes(tier);
}

function canSee(actor, info) {
  const u = unlocksOf(actor);
  if ( u.recipes.includes(info.slug) ) return true;
  return !info.unlockSingly && ((info.tier === 1) || !!u.tiers[info.book]?.includes(info.tier));
}

function bookJournals() {
  return game.journal.filter(j => j.getFlag(MOD, "book")).sort((a, b) => a.sort - b.sort);
}

function recipesOf(book) {
  const journal = bookJournals().find(j => j.getFlag(MOD, "book") === book);
  return (journal?.pages.contents ?? []).map(recipeInfo).filter(Boolean).sort((a, b) => (a.tier - b.tier) || a.page.sort - b.page.sort);
}

function playerCharacters() {
  return game.actors.filter(a => (a.type === "character") && a.hasPlayerOwner).sort((a, b) => a.name.localeCompare(b.name));
}

function playersOf(actor) {
  return game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
}

async function applyToPlayers(actors, infos, { closeOthers = true } = {}) {
  infos = infos.filter(i => (i.tier > 1) || i.unlockSingly);
  if ( !infos.length ) return;
  const users = new Set(actors.flatMap(playersOf));
  for ( const user of users ) {
    const characters = game.actors.filter(a => (a.type === "character") && a.testUserPermission(user, "OWNER"));
    const open = [];
    const close = [];
    for ( const info of infos ) (characters.some(c => canSee(c, info)) ? open : close).push(info.slug);
    if ( open.length ) await api.unlockRecipes([user.id], { recipes: open });
    if ( close.length && closeOthers ) await api.unlockRecipes([user.id], { recipes: close, level: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE });
  }
}

async function setTierUnlock(actors, book, tier, unlocked) {
  tier = Number(tier);
  if ( tier < 2 ) return;
  actors = actors.map(characterOf).filter(Boolean);
  const books = (unlocked && (book !== REFINING) && bookJournals().some(j => j.getFlag(MOD, "book") === REFINING)) ? [book, REFINING] : [book];
  for ( const actor of actors ) {
    const u = unlocksOf(actor);
    for ( const b of books ) {
      const set = new Set(u.tiers[b] ?? []);
      if ( unlocked ) set.add(tier);
      else if ( b === book ) set.delete(tier);
      u.tiers[b] = [...set].sort();
    }
    await actor.update({ [`flags.${MOD}.unlocks`]: u });
  }
  await applyToPlayers(actors, books.flatMap(b => recipesOf(b).filter(i => i.tier === tier)));
}

async function setRecipeUnlock(actors, slug, unlocked) {
  actors = actors.map(characterOf).filter(Boolean);
  const info = bookJournals().flatMap(j => j.pages.contents).map(recipeInfo).find(i => i?.slug === slug);
  if ( !info ) return;
  for ( const actor of actors ) {
    const u = unlocksOf(actor);
    const set = new Set(u.recipes);
    if ( unlocked ) set.add(slug);
    else set.delete(slug);
    u.recipes = [...set].sort();
    await actor.update({ [`flags.${MOD}.unlocks`]: u });
  }
  await applyToPlayers(actors, [info]);
}

async function reapplyUnlocks() {
  const infos = bookJournals().flatMap(j => j.pages.contents).map(recipeInfo).filter(Boolean);
  await applyToPlayers(playerCharacters(), infos, { closeOthers: false });
}

function practiceProgress(actor, book) {
  const tier = [2, 3, 4].find(t => !hasTier(actor, book, t));
  if ( !tier ) return null;
  const crafted = distinctCrafted(actor, book, tier - 1).length;
  const need = rule?.distinctRecipes ?? null;
  const level = Number(actor.system?.details?.level ?? 0);
  const needLevel = rule?.levels?.[tier] ?? null;
  const met = (need !== null) && (needLevel !== null) && (crafted >= need) && (level >= needLevel);
  return { tier, crafted, need, level, needLevel, met };
}

function evaluate(actor) {
  queue = queue.then(() => autoUnlock(actor)).catch(err => console.error(`${MOD} |`, err));
  return queue;
}

function evaluateAll() {
  if ( !game.user.isGM ) return queue;
  for ( const actor of playerCharacters() ) evaluate(actor);
  return queue;
}

async function autoUnlock(actor) {
  if ( (game.users.activeGM !== game.user) || (game.settings.get(MOD, "unlockMode") !== "auto") || !rule?.distinctRecipes ) return;
  actor = characterOf(actor);
  if ( (actor?.type !== "character") || !actor.hasPlayerOwner ) return;
  for ( const journal of bookJournals() ) {
    const book = journal.getFlag(MOD, "book");
    if ( book === REFINING ) continue;
    let progress = practiceProgress(actor, book);
    while ( progress?.met ) {
      await setTierUnlock([actor], book, progress.tier, true);
      await announce(actor, journal, progress.tier);
      progress = practiceProgress(actor, book);
    }
  }
}

async function announce(actor, journal, tier) {
  const content = `<p>${L("Tracker.AutoUnlocked", { actor: actor.name, book: journal.name, tier })}</p>`;
  const whisper = [...playersOf(actor), ...game.users.filter(u => u.isGM)].map(u => u.id);
  await ChatMessage.implementation.create({ content, whisper, speaker: { alias: L("Tracker.Title") } });
  ui.notifications.info(L("Tracker.AutoUnlocked", { actor: actor.name, book: journal.name, tier }));
}

export class TrackerPanel {
  static TAB = { id: "tracker", icon: "fa-solid fa-list-check", label: "GGCG.Tracker.Title" };

  static PARTS = {
    trackerControls: { template: `modules/${MOD}/templates/tracker-controls.hbs` },
    trackerBook: { template: `modules/${MOD}/templates/tracker-book.hbs`, scrollable: [""] }
  };

  static ACTIONS = { trackerToggleTier: "toggleTier", trackerAddSingle: "addSingle" };

  constructor(app) {
    this.app = app;
  }

  book = null;

  added = new Set();

  refresh() {
    if ( this.app.rendered ) this.app.render({ parts: Object.keys(TrackerPanel.PARTS) });
  }

  prepare(partId, context) {
    const journals = bookJournals();
    if ( !journals.some(j => j.getFlag(MOD, "book") === this.book) ) this.book = journals[0]?.getFlag(MOD, "book") ?? null;
    if ( partId === "trackerControls" ) return Object.assign(context, {
      bookField: new foundry.data.fields.StringField({ label: L("Tracker.Book"), required: true, blank: false }),
      book: this.book,
      books: journals.map(j => ({ value: j.getFlag(MOD, "book"), label: j.name })),
      mode: L(`Settings.UnlockMode.${game.settings.get(MOD, "unlockMode") === "auto" ? "Auto" : "Manual"}`),
      rule: rule?.distinctRecipes ? L("Tracker.Rule", { count: rule.distinctRecipes, levels: [2, 3, 4].map(t => rule.levels?.[t]).join(", ") }) : null
    });
    const recipes = this.book ? recipesOf(this.book) : [];
    const characters = playerCharacters();
    const nameOf = slug => recipes.find(r => r.slug === slug)?.page.name ?? slug;
    const rows = characters.map(actor => {
      const progress = practiceProgress(actor, this.book);
      return {
        id: actor.id, name: actor.name,
        level: actor.system?.details?.level ?? 0,
        players: playersOf(actor).map(u => u.name).join(", "),
        tiers: TIERS.map(tier => {
          const crafted = distinctCrafted(actor, this.book, tier);
          const unlocked = hasTier(actor, this.book, tier);
          return { tier, crafted: crafted.length, unlocked, toggle: tier > 1,
            countTooltip: crafted.length ? L("Tracker.Crafted", { names: crafted.map(nameOf).join(", ") }) : L("Tracker.NoneCrafted"),
            tooltip: L(unlocked ? "Tracker.LockTier" : "Tracker.UnlockTier", { tier }) };
        }),
        progress: progress ? { ...progress, need: progress.need ?? "?", needLevel: progress.needLevel ?? "?" } : null
      };
    });
    const listed = r => r.unlockSingly || this.added.has(r.slug) || characters.some(a => unlocksOf(a).recipes.includes(r.slug));
    const singles = recipes.filter(listed);
    return Object.assign(context, {
      rows,
      tiers: TIERS,
      singles: singles.map(r => ({
        slug: r.slug, name: r.page.name, tier: r.tier, legendary: r.unlockSingly,
        unlocked: characters.filter(a => unlocksOf(a).recipes.includes(r.slug)).map(a => a.id)
      })),
      characters: characters.map(a => ({ value: a.id, label: a.name })),
      singleField: new foundry.data.fields.StringField({ label: L("Tracker.AddSingle") }),
      singleOptions: recipes.filter(r => (r.tier > 1) && !listed(r))
        .map(r => ({ value: r.slug, label: `${L("Tracker.TierN", { tier: r.tier })}: ${r.page.name}` }))
    });
  }

  change(target) {
    if ( target.name === "trackerSingle" ) {
      this.app.element.querySelector(".ggcg-tracker-add").disabled = !target.value;
      return;
    }
    if ( target.name === "trackerRecipe" ) return this.#setRecipe(target.dataset.recipe, target.value);
    if ( target.name !== "trackerBook" ) return;
    this.book = target.value;
    this.refresh();
  }

  async toggleTier(event, target) {
    const actor = game.actors.get(target.closest("[data-actor]").dataset.actor);
    const tier = Number(target.dataset.tier);
    await setTierUnlock([actor], this.book, tier, !hasTier(actor, this.book, tier));
    this.refresh();
  }

  async #setRecipe(slug, ids) {
    const chosen = new Set(ids);
    const characters = playerCharacters();
    const has = a => unlocksOf(a).recipes.includes(slug);
    const add = characters.filter(a => chosen.has(a.id) && !has(a));
    const remove = characters.filter(a => !chosen.has(a.id) && has(a));
    if ( add.length ) await setRecipeUnlock(add, slug, true);
    if ( remove.length ) await setRecipeUnlock(remove, slug, false);
    this.refresh();
  }

  rendered(element) {
    for ( const blank of element.querySelectorAll("multi-select[name=trackerRecipe] option[value='']") ) blank.textContent = L("Tracker.AddCharacter");
  }

  addSingle() {
    const slug = this.app.element.querySelector("select[name=trackerSingle]")?.value;
    if ( !slug ) return;
    this.added.add(slug);
    this.refresh();
  }
}
