import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { AIBackendProfileSchema } from '@happier-dev/protocol';

const {
  withCodexAppServerClientMock,
  readCodexAppServerSessionControlsMock,
} = vi.hoisted(() => ({
  withCodexAppServerClientMock: vi.fn(),
  readCodexAppServerSessionControlsMock: vi.fn(),
}));

vi.mock('@/backends/codex/appServer/client/withCodexAppServerClient', () => ({
  withCodexAppServerClient: withCodexAppServerClientMock,
}));

vi.mock('@/backends/codex/appServer/sessionControlsMetadata', () => ({
  readCodexAppServerSessionControls: readCodexAppServerSessionControlsMock,
}));

import { probeAgentModelsBestEffort } from './agentModelsProbe';
import { resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

function createProfileProbeContext() {
  const profile = AIBackendProfileSchema.parse({
    id: 'openrouter-free',
    name: 'Codex OpenRouter free',
    envVarRequirements: [
      { name: 'OPENROUTER_API_KEY', kind: 'secret', required: true },
    ],
    environmentVariables: [{ name: 'OPENROUTER_API_KEY', value: '' }],
    compatibilityByTargetKey: { 'agent:codex': true },
    isBuiltIn: false,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
  });
  const credentials: Credentials = {
    token: 'token-test',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
  return {
    profile,
    credentials,
    accountSettings: {
      codexBackendMode: 'appServer',
      profiles: [profile],
      secrets: [
        {
          id: 'openrouter-secret',
          name: 'OpenRouter',
          kind: 'apiKey',
          encryptedValue: {
            _isSecretValue: true,
            value: 'saved-openrouter-key',
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      secretBindingsByProfileId: {
        [profile.id]: { OPENROUTER_API_KEY: 'openrouter-secret' },
      },
    },
  };
}

describe('probeAgentModelsBestEffort (codex app-server)', () => {
  let previousCodexHome: string | undefined;
  let tempCodexHome: string | null = null;

  beforeEach(() => {
    withCodexAppServerClientMock.mockReset();
    readCodexAppServerSessionControlsMock.mockReset();
    resetAgentModelsProbeCacheForTests();
    previousCodexHome = process.env.CODEX_HOME;
    tempCodexHome = null;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (tempCodexHome) {
      rmSync(tempCodexHome, { recursive: true, force: true });
    }
  });

  it('publishes only provider-listed models for a selected profile', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ run }: any) => (
      await run({ request: vi.fn() })
    ));
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [
        { id: 'free/newest', name: 'Newest free' },
        { id: 'free/older', name: 'Older free' },
      ],
      currentModelId: 'free/newest',
      configOptions: [],
    });
    const { profile, credentials, accountSettings } =
      createProfileProbeContext();

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-profile',
      profileId: profile.id,
      accountSettings,
      credentials,
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'free/newest', name: 'Newest free' },
        { id: 'free/older', name: 'Older free' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
  });

  it('re-reads the Codex catalog after an external refresh instead of retaining the generic success cache', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ run }: any) => (
      await run({ request: vi.fn() })
    ));
    readCodexAppServerSessionControlsMock
      .mockResolvedValueOnce({
        availableModes: [],
        currentModeId: 'default',
        availableModels: [{ id: 'free/old', name: 'Old free model' }],
        currentModelId: 'free/old',
        configOptions: [],
      })
      .mockResolvedValueOnce({
        availableModes: [],
        currentModeId: 'default',
        availableModels: [{ id: 'free/new', name: 'New free model' }],
        currentModelId: 'free/new',
        configOptions: [],
      });
    const { profile, credentials, accountSettings } =
      createProfileProbeContext();
    const params = {
      agentId: 'codex' as const,
      cwd: '/repo-profile-refresh',
      profileId: profile.id,
      accountSettings,
      credentials,
    };

    const beforeRefresh = await probeAgentModelsBestEffort(params);
    const afterRefresh = await probeAgentModelsBestEffort(params);

    expect(beforeRefresh.availableModels.map((model) => model.id)).toEqual([
      'free/old',
    ]);
    expect(afterRefresh.availableModels.map((model) => model.id)).toEqual([
      'free/new',
    ]);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(2);
  });

  it('does not replace a failed selected-profile probe with static models', async () => {
    withCodexAppServerClientMock.mockRejectedValue(
      new Error('profile provider unavailable'),
    );
    const { profile, credentials, accountSettings } =
      createProfileProbeContext();

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-profile-failure',
      profileId: profile.id,
      accountSettings,
      credentials,
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [],
      supportsFreeform: false,
      source: 'static',
    });
  });

  it('retries a transient Codex app-server failure within the same probe so the first result is rich', async () => {
    withCodexAppServerClientMock
      .mockRejectedValueOnce(new Error('temporary codex app-server failure'))
      .mockImplementationOnce(async ({ cwd, run }: any) => {
        expect(cwd).toBe('/repo');
        return await run({ request: vi.fn() });
      });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      ],
      currentModelId: 'gpt-5.4',
      configOptions: [],
    });

    const first = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(first).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(2);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });

  it('uses Codex app-server session controls when account settings select appServer', async () => {
    tempCodexHome = mkdtempSync(join(tmpdir(), 'codex-probe-auth-'));
    mkdirSync(tempCodexHome, { recursive: true });
    writeFileSync(join(tempCodexHome, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: [
          'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0',
          'eyJleHAiIjo0MTAyNDQ0ODAwLCJlbWFpbCI6InFhQGV4YW1wbGUuY29tIn0',
          '',
        ].join('.'),
      },
    }));
    process.env.CODEX_HOME = tempCodexHome;

        withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
          expect(cwd).toBe('/repo');
          return await run({ request: vi.fn() });
        });
        readCodexAppServerSessionControlsMock.mockResolvedValue({
          availableModes: [],
          currentModeId: 'default',
          availableModels: [
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          description: 'Latest default',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
        { id: 'gpt-4.1', name: 'GPT-4.1' },
          ],
          currentModelId: 'gpt-5.4',
          configOptions: [],
        });

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

      expect(result).toEqual({
        provider: 'codex',
        availableModels: [
          { id: 'default', name: 'Default' },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          description: 'Latest default',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
        { id: 'gpt-4.1', name: 'GPT-4.1' },
        ],
        supportsFreeform: false,
        source: 'dynamic',
      });
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledWith({
      client: expect.objectContaining({ request: expect.any(Function) }),
      authMethod: 'credentials_file',
    });
  });

  it('uses Codex app-server session controls when the shared runtime defaults to appServer', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo-default');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [
        { id: 'gpt-5.4', name: 'GPT-5.4' },
      ],
      currentModelId: 'gpt-5.4',
      configOptions: [],
    });

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-default',
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });

  it('filters malformed dynamic model payload entries and normalizes invalid option values to null', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo-parse');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: { invalid: true },
              options: [
                { value: { invalid: true }, name: 'Auto' },
                { value: 'medium', name: 'Medium' },
                { value: 'skip-me' },
              ],
            },
            {
              id: 'missing-type',
              name: 'Broken option',
              currentValue: 'ignored',
            },
          ],
        },
        {
          id: 'missing-name',
          modelOptions: [],
        },
      ],
      currentModelId: 'gpt-5.4',
      configOptions: [],
    });

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-parse',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: null,
              options: [
                { value: null, name: 'Auto' },
                { value: 'medium', name: 'Medium' },
              ],
            },
          ],
        },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
  });
});
