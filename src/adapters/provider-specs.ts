import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { ProviderAdapterId, ProviderSpec } from "../rules/provider.js";
import { codexRuleset } from "../rules/codex/inventory.js";
import { claudeRuleset } from "../rules/claude/inventory.js";
import { cursorRuleset } from "../rules/cursor/inventory.js";
import { copilotRuleset } from "../rules/copilot/inventory.js";
import { zedRuleset } from "../rules/zed/inventory.js";
import { opencodeRuleset } from "../rules/opencode/inventory.js";
import { grokRuleset } from "../rules/grok/inventory.js";
import { openclawRuleset } from "../rules/openclaw/inventory.js";
export type { ProviderAdapterId, ProviderSpec } from "../rules/provider.js";

export const PROVIDER_SPECS: Record<ProviderAdapterId, ProviderSpec> = {
  codex: codexRuleset,
  claude: claudeRuleset,
  cursor: cursorRuleset,
  copilot: copilotRuleset,
  zed: zedRuleset,
  opencode: opencodeRuleset,
  grok: grokRuleset,
  openclaw: openclawRuleset,
};

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_SPECS) as ProviderAdapterId[]);

export function isProviderEnabled(config: AgentRinseConfig, id: ProviderAdapterId): boolean {
  return config.adapters[id]?.enabled ?? DEFAULT_CONFIG.adapters[id]?.enabled ?? false;
}
