import { TrackerPanel } from "./tracker.mjs";
import { LookupPanel } from "./lookup.mjs";
import { NodePanel } from "./nodes.mjs";

const APP_ID = "ggcg-tools";
const PANELS = [TrackerPanel, LookupPanel, NodePanel];
const L = key => game.i18n.localize(`GGCG.${key}`);
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function panelActions() {
  const actions = {};
  for ( const Panel of PANELS ) {
    for ( const [action, method] of Object.entries(Panel.ACTIONS) ) {
      actions[action] = function(event, target) {
        return this.panels[Panel.TAB.id][method](event, target);
      };
    }
  }
  return actions;
}

export function registerGMTools(moduleApi) {
  Object.assign(moduleApi, {
    gmTools: tab => GMTools.open(tab),
    tracker: () => GMTools.open("tracker"),
    nodePlacer: () => GMTools.open("nodes"),
    lookup: async query => {
      const app = await GMTools.open("lookup");
      if ( !app ) return null;
      if ( query ) await app.panels.lookup.search(query);
      app.panels.lookup.focus();
      return app;
    }
  });
}

Hooks.on("renderItemDirectory", (app, html) => {
  if ( !game.user.isGM ) return;
  const container = html.querySelector(".header-actions.action-buttons");
  if ( !container || container.querySelector(".ggcg-open-tools") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("ggcg-open-tools");
  button.innerHTML = `<i class="fa-solid fa-book-atlas" inert></i><span>${L("Tools.Open")}</span>`;
  button.addEventListener("click", () => GMTools.open());
  container.appendChild(button);
});

class GMTools extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "form",
    classes: ["ggcg-tools"],
    window: { title: "GGCG.Tools.Title", icon: "fa-solid fa-book-atlas", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 880, height: "auto" },
    form: { closeOnSubmit: false },
    actions: panelActions()
  };

  static PARTS = {
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    ...Object.assign({}, ...PANELS.map(Panel => Panel.PARTS))
  };

  static TABS = {
    main: { tabs: PANELS.map(Panel => Panel.TAB), initial: TrackerPanel.TAB.id }
  };

  panels = Object.fromEntries(PANELS.map(Panel => [Panel.TAB.id, new Panel(this)]));

  static open(tab) {
    if ( !game.user.isGM ) return null;
    const app = foundry.applications.instances.get(APP_ID) ?? new GMTools();
    return app.show(tab);
  }

  async show(tab) {
    if ( !this.rendered ) return this.render({ force: true, tab });
    if ( tab ) this.changeTab(tab, "main");
    await this.maximize();
    this.bringToFront();
    return this;
  }

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    const Panel = PANELS.find(P => partId in P.PARTS);
    if ( !Panel ) return context;
    return this.panels[Panel.TAB.id].prepare(partId, { ...context, tab: context.tabs[Panel.TAB.id] });
  }

  changeTab(tab, group, options) {
    super.changeTab(tab, group, options);
    this.panels[tab]?.shown?.();
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    for ( const panel of Object.values(this.panels) ) panel.listen?.(this.element);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for ( const panel of Object.values(this.panels) ) panel.rendered?.(this.element);
  }

  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    for ( const panel of Object.values(this.panels) ) panel.change?.(event.target);
  }
}
