import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';

export const CODEX_OPENROUTER_PROFILE_NAME = 'happier-openrouter';
export const CODEX_OPENROUTER_PROVIDER_ID = 'openrouter';
export const CODEX_OPENROUTER_PROVIDER_NAME = 'OpenRouter';
export const CODEX_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const CODEX_OPENROUTER_API_KEY_ENV_VAR = 'OPENROUTER_API_KEY';
export const CODEX_OPENROUTER_WIRE_API = 'responses';
export const CODEX_OPENROUTER_CATALOG_FILE_NAME = 'openrouter-models.json';
export const HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_KEY =
  'HAPPIER_CODEX_OPENROUTER_PROFILE';
const HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_VALUE = '1';

type OpenRouterCatalogDefaults = Readonly<{
  model: string;
  reasoningEffort: string | null;
}>;

function managedCatalogPath(processEnv: NodeJS.ProcessEnv): string {
  return join(resolveConfiguredCodexHome(processEnv), CODEX_OPENROUTER_CATALOG_FILE_NAME);
}

function readManagedCatalogDefaults(processEnv: NodeJS.ProcessEnv): OpenRouterCatalogDefaults | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(managedCatalogPath(processEnv), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { models?: unknown }).models)) {
      return null;
    }
    const first = (parsed as { models: unknown[] }).models[0];
    if (!first || typeof first !== 'object') return null;
    const rawModel = (first as { slug?: unknown }).slug;
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (!model) return null;
    const rawReasoningEffort = (first as { default_reasoning_level?: unknown }).default_reasoning_level;
    const reasoningEffort = typeof rawReasoningEffort === 'string' && rawReasoningEffort.trim()
      ? rawReasoningEffort.trim()
      : null;
    return { model, reasoningEffort };
  } catch {
    return null;
  }
}

function tomlStringOverride(key: string, value: string): string[] {
  return ['-c', `${key}=${JSON.stringify(value)}`];
}

function applyOpenRouterAppServerOverrides(
  args: readonly string[],
  processEnv: NodeJS.ProcessEnv,
): string[] {
  const defaults = readManagedCatalogDefaults(processEnv);
  return [
    ...args,
    ...(defaults ? tomlStringOverride('model', defaults.model) : []),
    ...(defaults?.reasoningEffort
      ? tomlStringOverride('model_reasoning_effort', defaults.reasoningEffort)
      : []),
    ...tomlStringOverride('preferred_auth_method', 'apikey'),
    ...tomlStringOverride('model_provider', CODEX_OPENROUTER_PROVIDER_ID),
    ...tomlStringOverride('model_catalog_json', managedCatalogPath(processEnv)),
    ...tomlStringOverride(
      `model_providers.${CODEX_OPENROUTER_PROVIDER_ID}.name`,
      CODEX_OPENROUTER_PROVIDER_NAME,
    ),
    ...tomlStringOverride(
      `model_providers.${CODEX_OPENROUTER_PROVIDER_ID}.base_url`,
      CODEX_OPENROUTER_BASE_URL,
    ),
    ...tomlStringOverride(
      `model_providers.${CODEX_OPENROUTER_PROVIDER_ID}.env_key`,
      CODEX_OPENROUTER_API_KEY_ENV_VAR,
    ),
    ...tomlStringOverride(
      `model_providers.${CODEX_OPENROUTER_PROVIDER_ID}.wire_api`,
      CODEX_OPENROUTER_WIRE_API,
    ),
  ];
}

export function isCodexOpenRouterProfileRequested(
  processEnv: NodeJS.ProcessEnv,
): boolean {
  return processEnv[HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_KEY] ===
    HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_VALUE;
}

export function markCodexOpenRouterProfileRequested(
  processEnv: NodeJS.ProcessEnv,
): void {
  processEnv[HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_KEY] =
    HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_VALUE;
}

export function applyCodexOpenRouterProfileArgs(
  args: readonly string[],
  processEnv: NodeJS.ProcessEnv,
): string[] {
  if (!isCodexOpenRouterProfileRequested(processEnv)) return [...args];
  if (args[0] === 'app-server') {
    return applyOpenRouterAppServerOverrides(args, processEnv);
  }
  return ['--profile', CODEX_OPENROUTER_PROFILE_NAME, ...args];
}
