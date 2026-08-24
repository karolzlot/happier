import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexOpenRouterConfigurationError,
  configureCodexOpenRouterMachine,
  inspectCodexOpenRouterMachineConfiguration,
  refreshCodexOpenRouterCatalogIfStale,
  transformCodexOpenRouterCatalog,
} from './codexOpenRouterMachineConfiguration';
import {
  CODEX_OPENROUTER_PROFILE_NAME,
  HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_KEY,
  markCodexOpenRouterProfileRequested,
  prependCodexOpenRouterProfileArgs,
} from './openrouterProfile';

const createdDirectories: string[] = [];

async function createCodexHome(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-openrouter-'));
  createdDirectories.push(root);
  return root;
}

function codexModel(slug: string, effort: string = 'xhigh'): Record<string, unknown> {
  return {
    slug,
    supported_in_api: true,
    visibility: 'list',
    base_instructions: 'Base instructions',
    default_reasoning_level: effort,
    supported_reasoning_levels: [{ effort }],
  };
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codex OpenRouter machine configuration', () => {
  it('reports a missing isolated profile as configurable', async () => {
    const codexHome = await createCodexHome();

    await expect(
      inspectCodexOpenRouterMachineConfiguration({ processEnv: { CODEX_HOME: codexHome } }),
    ).resolves.toMatchObject({
      state: 'needs_configuration',
      code: 'openrouter-profile-missing',
      canConfigure: true,
      profileName: CODEX_OPENROUTER_PROFILE_NAME,
    });
  });

  it('creates a dedicated profile, preserves its unrelated settings, and publishes only free models newest first', async () => {
    const codexHome = await createCodexHome();
    const baseConfig = 'model_provider = "openai"\nmodel = "gpt-5.6"\n';
    await writeFile(join(codexHome, 'config.toml'), baseConfig, 'utf8');
    await writeFile(
      join(codexHome, `${CODEX_OPENROUTER_PROFILE_NAME}.config.toml`),
      'approval_policy = "on-request"\nmodel_provider = "openai"\n',
      'utf8',
    );
    const publicCatalog = {
      data: [
        { id: 'free/older', created: 10, pricing: { prompt: '0', completion: '0' } },
        { id: 'paid/model', created: 99, pricing: { prompt: '0', completion: '0.0001' } },
        { id: 'free/newer', created: 20, pricing: { prompt: 0, completion: 0 } },
      ],
    };
    const codexCatalog = {
      models: [codexModel('free/older', 'medium'), codexModel('free/newer')],
    };

    const configured = await configureCodexOpenRouterMachine({
      processEnv: { CODEX_HOME: codexHome },
      resolveCodexVersion: async () => '0.80.9',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () => (url.includes('client_version=0.80.9') ? codexCatalog : publicCatalog),
      }),
    });

    expect(configured).toMatchObject({ state: 'ready', modelCount: 2, canConfigure: false });
    const profile = await readFile(
      join(codexHome, `${CODEX_OPENROUTER_PROFILE_NAME}.config.toml`),
      'utf8',
    );
    expect(profile).toContain('approval_policy = "on-request"');
    expect(profile).toContain('model_provider = "openrouter"');
    expect(profile).toContain('env_key = "OPENROUTER_API_KEY"');
    expect(profile).not.toContain('sk-or-');
    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).resolves.toBe(baseConfig);

    const catalog = JSON.parse(await readFile(join(codexHome, 'openrouter-models.json'), 'utf8'));
    expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual([
      'free/newer',
      'free/older',
    ]);
    expect(catalog.models[0].default_reasoning_level).toBe('max');
    expect(catalog.models[0].supported_reasoning_levels).toEqual([{ effort: 'max' }]);
    expect(catalog.models.map((model: { priority: number }) => model.priority)).toEqual([0, 1]);
  });

  it('defaults a free model to its highest published effort', () => {
    const catalog = transformCodexOpenRouterCatalog(
      {
        data: [
          { id: 'free/deep', created: 10, pricing: { prompt: 0, completion: 0 } },
        ],
      },
      {
        models: [
          {
            ...codexModel('free/deep', 'low'),
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'max' },
              { effort: 'ultra' },
            ],
          },
        ],
      },
    );

    expect(catalog.models[0]?.default_reasoning_level).toBe('ultra');
  });

  it('refuses to rewrite a profile containing a plaintext OpenRouter key', async () => {
    const codexHome = await createCodexHome();
    const profilePath = join(codexHome, `${CODEX_OPENROUTER_PROFILE_NAME}.config.toml`);
    const unsafeProfile = 'OPENROUTER_API_KEY = "sk-or-abcdefghijklmnopqrstuvwxyz"\n';
    await writeFile(profilePath, unsafeProfile, 'utf8');

    await expect(
      configureCodexOpenRouterMachine({
        processEnv: { CODEX_HOME: codexHome },
        resolveCodexVersion: async () => '0.80.9',
      }),
    ).rejects.toMatchObject<CodexOpenRouterConfigurationError>({
      code: 'openrouter-profile-contains-plaintext-secret',
    });
    await expect(readFile(profilePath, 'utf8')).resolves.toBe(unsafeProfile);
  });

  it('refreshes an already configured catalog before a later model probe without changing the profile', async () => {
    const codexHome = await createCodexHome();
    const initialPublic = {
      data: [
        { id: 'free/old', created: 1, pricing: { prompt: 0, completion: 0 } },
      ],
    };
    const refreshedPublic = {
      data: [
        { id: 'free/new', created: 2, pricing: { prompt: 0, completion: 0 } },
      ],
    };
    await configureCodexOpenRouterMachine({
      processEnv: { CODEX_HOME: codexHome },
      resolveCodexVersion: async () => '0.80.9',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () =>
            url.includes('client_version=')
                ? { models: [codexModel('free/old')] }
                : initialPublic,
      }),
    });
    const profileBefore = await readFile(
      join(codexHome, `${CODEX_OPENROUTER_PROFILE_NAME}.config.toml`),
      'utf8',
    );

    await expect(
      refreshCodexOpenRouterCatalogIfStale({
        processEnv: { CODEX_HOME: codexHome },
        maxAgeMs: 0,
        resolveCodexVersion: async () => '0.80.9',
        fetchImpl: async (url) => ({
          ok: true,
          status: 200,
          json: async () =>
              url.includes('client_version=')
                  ? { models: [codexModel('free/new')] }
                  : refreshedPublic,
        }),
      }),
    ).resolves.toBe(true);

    const catalog = JSON.parse(await readFile(join(codexHome, 'openrouter-models.json'), 'utf8'));
    expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(['free/new']);
    await expect(
      readFile(join(codexHome, `${CODEX_OPENROUTER_PROFILE_NAME}.config.toml`), 'utf8'),
    ).resolves.toBe(profileBefore);
  });

  it('requires an exact Codex-compatible entry for every free OpenRouter model', () => {
    expect(() =>
      transformCodexOpenRouterCatalog(
        {
          data: [
            { id: 'free/missing', created: 10, pricing: { prompt: 0, completion: 0 } },
          ],
        },
        { models: [] },
      ),
    ).toThrow(/free\/missing/);
  });

  it('injects the dedicated Codex profile only when the OpenRouter marker is set', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(prependCodexOpenRouterProfileArgs(['app-server'], env)).toEqual(['app-server']);
    markCodexOpenRouterProfileRequested(env);
    expect(env[HAPPIER_CODEX_OPENROUTER_PROFILE_ENV_KEY]).toBe('1');
    expect(prependCodexOpenRouterProfileArgs(['app-server'], env)).toEqual([
      '--profile',
      CODEX_OPENROUTER_PROFILE_NAME,
      'app-server',
    ]);
  });
});
