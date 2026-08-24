export const CODEX_OPENROUTER_PROFILE_NAME = 'happier-openrouter';
export const HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_KEY =
  'HAPPIER_CODEX_OPENROUTER_PROFILE';
const HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_VALUE = '1';

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

export function prependCodexOpenRouterProfileArgs(
  args: readonly string[],
  processEnv: NodeJS.ProcessEnv,
): string[] {
  if (!isCodexOpenRouterProfileRequested(processEnv)) return [...args];
  return ['--profile', CODEX_OPENROUTER_PROFILE_NAME, ...args];
}
