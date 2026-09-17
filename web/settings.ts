export const SETTINGS_BROWSER_COMMIT = "1a268c485380eafb4e233a24c5803db4ff1f9ed0";
export const SETTINGS_SOURCE_COMMIT = "4aff7dc2dbfcae0e245269bd3fe50f6afb8e19e8";
export const SETTINGS_BROWSER_MODULE_URL = `https://cdn.jsdelivr.net/gh/moritzbrantner/settings@${SETTINGS_BROWSER_COMMIT}/settings-browser.js`;

const SETTINGS_STORAGE_KEY = "dj-party.settings.user.v1";
const SETTINGS_API_VERSION = 1;

type SettingValue =
  | { type: "bool"; value: boolean }
  | { type: "integer"; value: number }
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "choice"; value: string };

type SettingDefinition = {
  id: string;
  kind:
    | { type: "bool" }
    | { type: "integer"; min: number; max: number }
    | { type: "number"; min: number; max: number }
    | { type: "text"; min_chars: number; max_chars: number }
    | { type: "choice"; options: string[] };
  default: SettingValue;
  scope: "session" | "save" | "device" | "user";
  apply_mode: "immediate" | "apply" | "restart" | "reconnect";
};

type PresentationEntry = {
  id: string;
  metadata: {
    label_key: string;
    description_key?: string;
    category_key: string;
    group_key?: string;
    order?: number;
    discoverability?: "primary" | "advanced" | "search_only";
    search_keys?: string[];
  };
};

type SettingsSession = {
  presentation(): PresentationEntry[];
  effectiveValues(): Record<string, SettingValue>;
  set(id: string, value: SettingValue): void;
  reset(id: string): void;
  importScope(scope: "user", snapshot: string): string[];
  exportScope(scope: "user"): string;
  dispose(): void;
};

type SettingsBrowserModule = {
  SETTINGS_BROWSER_API_VERSION: number;
  createSettingsSession(
    definitions: readonly SettingDefinition[],
    presentation?: readonly PresentationEntry[],
  ): Promise<SettingsSession>;
};

export const DJ_PARTY_SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    id: "appearance.color_scheme",
    kind: { type: "choice", options: ["system", "light", "dark"] },
    default: { type: "choice", value: "system" },
    scope: "user",
    apply_mode: "immediate",
  },
  {
    id: "appearance.contrast",
    kind: { type: "choice", options: ["system", "normal", "high", "low"] },
    default: { type: "choice", value: "normal" },
    scope: "user",
    apply_mode: "immediate",
  },
  {
    id: "appearance.color_vision",
    kind: {
      type: "choice",
      options: ["off", "protanopia", "deuteranopia", "tritanopia", "achromatopsia"],
    },
    default: { type: "choice", value: "off" },
    scope: "user",
    apply_mode: "immediate",
  },
  {
    id: "appearance.night_mode",
    kind: { type: "bool" },
    default: { type: "bool", value: false },
    scope: "user",
    apply_mode: "immediate",
  },
  {
    id: "accessibility.reduce_motion",
    kind: { type: "bool" },
    default: { type: "bool", value: false },
    scope: "user",
    apply_mode: "immediate",
  },
];

export const DJ_PARTY_SETTING_PRESENTATION: readonly PresentationEntry[] = [
  {
    id: "appearance.color_scheme",
    metadata: {
      label_key: "settings.appearance.color_scheme.label",
      description_key: "settings.appearance.color_scheme.description",
      category_key: "settings.category.appearance",
      group_key: "settings.group.theme",
      order: 10,
      discoverability: "primary",
      search_keys: ["settings.search.theme", "settings.search.dark_mode"],
    },
  },
  {
    id: "appearance.contrast",
    metadata: {
      label_key: "settings.appearance.contrast.label",
      description_key: "settings.appearance.contrast.description",
      category_key: "settings.category.appearance",
      group_key: "settings.group.theme",
      order: 20,
      discoverability: "primary",
      search_keys: ["settings.search.contrast"],
    },
  },
  {
    id: "appearance.color_vision",
    metadata: {
      label_key: "settings.appearance.color_vision.label",
      description_key: "settings.appearance.color_vision.description",
      category_key: "settings.category.appearance",
      group_key: "settings.group.color",
      order: 30,
      discoverability: "primary",
      search_keys: ["settings.search.color_vision", "settings.search.colorblind"],
    },
  },
  {
    id: "appearance.night_mode",
    metadata: {
      label_key: "settings.appearance.night_mode.label",
      description_key: "settings.appearance.night_mode.description",
      category_key: "settings.category.appearance",
      group_key: "settings.group.theme",
      order: 40,
      discoverability: "primary",
      search_keys: ["settings.search.night", "settings.search.low_light"],
    },
  },
  {
    id: "accessibility.reduce_motion",
    metadata: {
      label_key: "settings.accessibility.reduce_motion.label",
      description_key: "settings.accessibility.reduce_motion.description",
      category_key: "settings.category.accessibility",
      group_key: "settings.group.motion",
      order: 10,
      discoverability: "primary",
      search_keys: ["settings.search.animation", "settings.search.motion"],
    },
  },
];

const LOCALIZATIONS: Record<string, string> = {
  "settings.category.appearance": "Appearance",
  "settings.category.accessibility": "Accessibility",
  "settings.group.theme": "Theme",
  "settings.group.color": "Color",
  "settings.group.motion": "Motion",
  "settings.appearance.color_scheme.label": "Color scheme",
  "settings.appearance.color_scheme.description": "Follow the system theme or choose a light or dark mixer surface.",
  "settings.appearance.contrast.label": "Contrast",
  "settings.appearance.contrast.description": "Use normal, higher, lower, or system contrast without changing the selected color scheme.",
  "settings.appearance.color_vision.label": "Color-vision assistance",
  "settings.appearance.color_vision.description": "Use an alternate accent palette while keeping redundant Deck A/B labels and controls.",
  "settings.appearance.night_mode.label": "Night mode",
  "settings.appearance.night_mode.description": "Reduce luminance for low-light environments without forcing dark mode or contrast changes.",
  "settings.accessibility.reduce_motion.label": "Reduce motion",
  "settings.accessibility.reduce_motion.description": "Disable non-essential platter animation and interface transitions.",
};

const OPTION_LABELS: Record<string, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  normal: "Normal",
  high: "High",
  low: "Low",
  off: "Off",
  protanopia: "Protanopia",
  deuteranopia: "Deuteranopia",
  tritanopia: "Tritanopia",
  achromatopsia: "Achromatopsia",
};

export function resolveColorScheme(preference: string, systemPrefersDark: boolean) {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

export async function installDjPartySettings() {
  if (typeof document === "undefined") {
    return null;
  }

  installStylesheet();

  const settingsModule = (await import(SETTINGS_BROWSER_MODULE_URL)) as unknown as SettingsBrowserModule;
  if (settingsModule.SETTINGS_BROWSER_API_VERSION !== SETTINGS_API_VERSION) {
    throw new Error(`Unsupported settings browser API ${settingsModule.SETTINGS_BROWSER_API_VERSION}`);
  }

  const session = await settingsModule.createSettingsSession(
    DJ_PARTY_SETTING_DEFINITIONS,
    DJ_PARTY_SETTING_PRESENTATION,
  );
  const restoreMessage = restoreUserScope(session);
  const ui = installSettingsUi(session, restoreMessage);

  const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const contrastMoreMedia = window.matchMedia("(prefers-contrast: more)");
  const contrastLessMedia = window.matchMedia("(prefers-contrast: less)");
  const apply = () => applyEffectiveSettings(session, darkMedia, contrastMoreMedia, contrastLessMedia);
  darkMedia.addEventListener("change", apply);
  contrastMoreMedia.addEventListener("change", apply);
  contrastLessMedia.addEventListener("change", apply);
  apply();

  const dispose = () => {
    darkMedia.removeEventListener("change", apply);
    contrastMoreMedia.removeEventListener("change", apply);
    contrastLessMedia.removeEventListener("change", apply);
    session.dispose();
  };
  window.addEventListener("beforeunload", dispose, { once: true });

  return { session, ui, dispose };
}

function installStylesheet() {
  if (document.querySelector("link[data-dj-party-settings-styles]")) {
    return;
  }
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("./settings.css", import.meta.url).href;
  stylesheet.dataset.djPartySettingsStyles = "true";
  document.head.append(stylesheet);
}

function restoreUserScope(session: SettingsSession) {
  try {
    const snapshot = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!snapshot) return "";
    const diagnostics = session.importScope("user", snapshot);
    if (diagnostics.length > 0) {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
      return "Stored settings were invalid and were reset to defaults.";
    }
    return "";
  } catch (error) {
    console.warn("Could not restore DJ Party settings", error);
    return "Stored settings could not be restored; defaults are active.";
  }
}

function persistUserScope(session: SettingsSession) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, session.exportScope("user"));
    return true;
  } catch (error) {
    console.warn("Could not persist DJ Party settings", error);
    return false;
  }
}

function applyEffectiveSettings(
  session: SettingsSession,
  darkMedia: MediaQueryList,
  contrastMoreMedia: MediaQueryList,
  contrastLessMedia: MediaQueryList,
) {
  const values = session.effectiveValues();
  const root = document.documentElement;
  const colorSchemePreference = choice(values["appearance.color_scheme"], "system");
  const contrastPreference = choice(values["appearance.contrast"], "normal");
  const colorVision = choice(values["appearance.color_vision"], "off");
  const nightMode = bool(values["appearance.night_mode"], false);
  const reduceMotion = bool(values["accessibility.reduce_motion"], false);

  root.dataset.colorSchemePreference = colorSchemePreference;
  root.dataset.colorScheme = resolveColorScheme(colorSchemePreference, darkMedia.matches);
  root.dataset.contrast =
    contrastPreference === "system"
      ? contrastMoreMedia.matches
        ? "high"
        : contrastLessMedia.matches
          ? "low"
          : "normal"
      : contrastPreference;
  root.dataset.colorVision = colorVision;
  root.dataset.nightMode = String(nightMode);
  root.dataset.reduceMotion = String(reduceMotion);
  root.style.colorScheme = root.dataset.colorScheme;
}

function installSettingsUi(session: SettingsSession, initialMessage: string) {
  const topbar = document.querySelector(".topbar");
  const sessionStatus = topbar?.querySelector(".session-status");
  if (!topbar || !sessionStatus) {
    return null;
  }

  let actions = topbar.querySelector(".topbar-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "topbar-actions";
    topbar.insertBefore(actions, sessionStatus);
    actions.append(sessionStatus);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-button";
  button.textContent = "Settings";
  button.setAttribute("aria-haspopup", "dialog");
  actions.append(button);

  const dialog = document.createElement("dialog");
  dialog.className = "settings-dialog";
  dialog.setAttribute("aria-labelledby", "settings-title");
  dialog.innerHTML = `
    <div class="settings-dialog-header">
      <div>
        <p class="settings-eyebrow">Local preferences</p>
        <h2 id="settings-title">Settings</h2>
      </div>
      <button class="settings-close" type="button" aria-label="Close settings">×</button>
    </div>
    <p class="settings-foundation-note">Validated by the shared settings foundation. These preferences stay on this device and are not synchronized with the DJ session.</p>
    <output class="settings-status" aria-live="polite"></output>
    <div class="settings-fields"></div>
  `;
  document.body.append(dialog);

  const close = dialog.querySelector<HTMLButtonElement>(".settings-close");
  const status = dialog.querySelector<HTMLOutputElement>(".settings-status");
  const fields = dialog.querySelector<HTMLDivElement>(".settings-fields");
  if (!close || !status || !fields) {
    dialog.remove();
    button.remove();
    return null;
  }

  status.textContent = initialMessage;

  const render = () => {
    fields.replaceChildren();
    const values = session.effectiveValues();
    const definitions = new Map(DJ_PARTY_SETTING_DEFINITIONS.map((definition) => [definition.id, definition]));
    const categories = new Map<string, PresentationEntry[]>();

    for (const entry of session.presentation()) {
      const category = entry.metadata.category_key;
      const entries = categories.get(category) ?? [];
      entries.push(entry);
      categories.set(category, entries);
    }

    for (const [categoryKey, entries] of categories) {
      const section = document.createElement("section");
      section.className = "settings-section";
      const heading = document.createElement("h3");
      heading.textContent = localize(categoryKey);
      section.append(heading);

      for (const entry of entries) {
        const definition = definitions.get(entry.id);
        const value = values[entry.id];
        if (!definition || !value) continue;
        section.append(renderSettingField(session, definition, entry, value, () => {
          const saved = persistUserScope(session);
          applyEffectiveSettings(
            session,
            window.matchMedia("(prefers-color-scheme: dark)"),
            window.matchMedia("(prefers-contrast: more)"),
            window.matchMedia("(prefers-contrast: less)"),
          );
          status.textContent = saved ? "Settings saved locally." : "Setting applied for this tab but could not be saved.";
          render();
        }));
      }
      fields.append(section);
    }
  };

  render();
  button.addEventListener("click", () => dialog.showModal());
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  return { button, dialog, render };
}

function renderSettingField(
  session: SettingsSession,
  definition: SettingDefinition,
  entry: PresentationEntry,
  value: SettingValue,
  changed: () => void,
) {
  const row = document.createElement("div");
  row.className = "settings-field";

  const copy = document.createElement("div");
  copy.className = "settings-field-copy";
  const label = document.createElement("strong");
  label.textContent = localize(entry.metadata.label_key);
  const description = document.createElement("span");
  description.textContent = localize(entry.metadata.description_key ?? "");
  copy.append(label, description);

  const controls = document.createElement("div");
  controls.className = "settings-field-controls";

  if (definition.kind.type === "bool" && value.type === "bool") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value.value;
    input.setAttribute("aria-label", label.textContent ?? definition.id);
    input.addEventListener("change", () => {
      session.set(definition.id, { type: "bool", value: input.checked });
      changed();
    });
    controls.append(input);
  } else if (definition.kind.type === "choice" && value.type === "choice") {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label.textContent ?? definition.id);
    for (const optionValue of definition.kind.options) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = OPTION_LABELS[optionValue] ?? optionValue;
      option.selected = optionValue === value.value;
      select.append(option);
    }
    select.addEventListener("change", () => {
      session.set(definition.id, { type: "choice", value: select.value });
      changed();
    });
    controls.append(select);
  }

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "settings-reset";
  reset.textContent = "Reset";
  reset.addEventListener("click", () => {
    session.reset(definition.id);
    changed();
  });
  controls.append(reset);

  row.append(copy, controls);
  return row;
}

function localize(key: string) {
  return LOCALIZATIONS[key] ?? key;
}

function choice(value: SettingValue | undefined, fallback: string) {
  return value?.type === "choice" ? value.value : fallback;
}

function bool(value: SettingValue | undefined, fallback: boolean) {
  return value?.type === "bool" ? value.value : fallback;
}
