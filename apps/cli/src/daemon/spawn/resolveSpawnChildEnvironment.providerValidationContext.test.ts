import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('resolveSpawnChildEnvironment provider validation context', () => {
  it('validates against the effective session directory and child environment', async () => {
    const validateSpawn = vi.fn(async () => ({ ok: true as const }));

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: 'C:\\workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      },
      profileEnvironmentVariables: { ProgramFiles: 'C:\\Program Files' },
      daemonSpawnHooks: { validateSpawn },
      processEnv: { PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\alice' },
      connectedServiceAuth: {
        env: { PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
    });

    expect(result.ok).toBe(true);
    expect(validateSpawn).toHaveBeenCalledWith(expect.objectContaining({
      directory: 'C:\\workspace',
      environmentVariables: expect.objectContaining({
        PATH: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\alice',
        ProgramFiles: 'C:\\Program Files',
        PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent',
      }),
    }));
  });

  it('fails closed before a Codex OpenRouter spawn when the selected machine has no local profile', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-missing-openrouter-profile-'));
    try {
      const result = await resolveSpawnChildEnvironment({
        options: {
          directory: '/workspace',
          profileId: 'openrouter-profile',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        },
        profileEnvironmentVariables: { OPENROUTER_API_KEY: 'saved-secret' },
        daemonSpawnHooks: null,
        processEnv: { CODEX_HOME: codexHome },
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected OpenRouter configuration refusal');
      expect(result.errorCode).toBe('spawn_validation_failed');
      expect(result.errorMessage).toContain('nie ma jeszcze profilu OpenRoutera');
      expect(result.errorMessage).not.toContain('saved-secret');
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
