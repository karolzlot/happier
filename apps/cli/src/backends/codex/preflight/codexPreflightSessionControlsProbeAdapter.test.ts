import { afterEach, describe, expect, it } from 'vitest';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { AIBackendProfileSchema } from '@happier-dev/protocol';

import { codexPreflightSessionControlsProbeAdapter } from './codexPreflightSessionControlsProbeAdapter';

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function writeReadyOpenRouterProfile(codexHome: string): void {
    mkdirSync(codexHome, { recursive: true });
    const catalogPath = join(codexHome, 'openrouter-models.json');
    writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: 'free/test' }] }), 'utf8');
    writeFileSync(
        join(codexHome, 'happier-openrouter.config.toml'),
        [
            'model = "free/test"',
            'model_provider = "openrouter"',
            `model_catalog_json = ${JSON.stringify(catalogPath)}`,
            '',
            '[model_providers.openrouter]',
            'name = "OpenRouter"',
            'base_url = "https://openrouter.ai/api/v1"',
            'env_key = "OPENROUTER_API_KEY"',
            'wire_api = "responses"',
            '',
        ].join('\n'),
        'utf8',
    );
}

const envKeys = [
    'HAPPIER_CODEX_APP_SERVER_BIN',
    'HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS',
    'HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS',
    'HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE',
    'HAPPIER_HOME_DIR',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENROUTER_API_KEY',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
] as const;

let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    envScope = createEnvKeyScope(envKeys);
});

describe('codexPreflightSessionControlsProbeAdapter', () => {
    let tempDir: string | null = null;

    afterEach(() => {
        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
    });

    for (const authEnvVar of ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const) {
        it(`uses the probe timeout when spawning Codex app-server so model-scoped options do not disappear on slow model/list calls (${authEnvVar})`, async () => {
            tempDir = makeTempDir('happier-codex-preflight-controls-');

            const fakeAppServerPath = fileURLToPath(new URL('./__fixtures__/fakeCodexAppServer.mjs', import.meta.url));
            process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServerPath;
            process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '600';

            // Set an artificially small RPC timeout so the test proves the adapter overrides it.
            process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '250';
            // Force Speed to be ineligible (the real gating hides it when auth is API-key based).
            process.env.OPENAI_API_KEY = undefined;
            process.env.CODEX_API_KEY = undefined;
            process.env[authEnvVar] = 'test';

            const raw = await codexPreflightSessionControlsProbeAdapter.probeModelsRaw?.({
                cwd: tempDir,
                timeoutMs: 2_000,
                backendTarget: undefined,
                accountSettings: null,
            });

            expect(Array.isArray(raw)).toBe(true);
            expect(raw).toEqual([
                {
                    id: 'gpt-5.4',
                    name: 'GPT 5.4',
                    description: 'Latest frontier agentic coding model.',
                    modelOptions: [
                        {
                            id: 'reasoning_effort',
                            name: 'Thinking',
                            type: 'select',
                            currentValue: 'medium',
                            options: [
                                { value: 'low', name: 'Low', description: 'Low' },
                                { value: 'medium', name: 'Medium', description: 'Medium' },
                                { value: 'high', name: 'High', description: 'High' },
                            ],
                        },
                    ],
                },
            ]);
        });
    }

    it('uses the materialized process environment supplied by the connected-service preflight owner', async () => {
        tempDir = makeTempDir('happier-codex-preflight-materialized-home-');
        process.env.HAPPIER_HOME_DIR = tempDir;
        reloadConfiguration();

        const codexHome = join(
            tempDir,
            'daemon',
            'connected-services',
            'materialized',
            'csm_probe',
            'codex',
            'codex-home',
        );
        mkdirSync(codexHome, { recursive: true });

        const captureFile = join(tempDir, 'captured-env.json');
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fileURLToPath(new URL('./__fixtures__/fakeCodexAppServer.mjs', import.meta.url));
        process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '1';
        process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE = captureFile;

        const raw = await codexPreflightSessionControlsProbeAdapter.probeModelsRaw?.({
            cwd: tempDir,
            timeoutMs: 2_000,
            backendTarget: undefined,
            accountSettings: { codexBackendMode: 'appServer' },
            processEnv: {
                ...process.env,
                CODEX_HOME: codexHome,
                CODEX_SQLITE_HOME: codexHome,
            },
        });

        expect(raw).toEqual(expect.any(Array));
        expect(existsSync(captureFile)).toBe(true);
        expect(JSON.parse(readFileSync(captureFile, 'utf8'))).toEqual({
            CODEX_HOME: codexHome,
            CODEX_SQLITE_HOME: codexHome,
            OPENROUTER_API_KEY: null,
            CODEX_AUTH_FILE_PRESENT: false,
        });
    });

    it('materializes the selected profile saved secret before spawning Codex app-server', async () => {
        tempDir = makeTempDir('happier-codex-preflight-profile-');
        const codexHome = join(tempDir, 'codex-home');
        writeReadyOpenRouterProfile(codexHome);

        const captureFile = join(tempDir, 'captured-env.json');
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fileURLToPath(new URL('./__fixtures__/fakeCodexAppServer.mjs', import.meta.url));
        process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '1';
        process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE = captureFile;

        const profile = AIBackendProfileSchema.parse({
            id: 'openrouter-free',
            name: 'Codex OpenRouter free',
            envVarRequirements: [{ name: 'OPENROUTER_API_KEY', kind: 'secret', required: true }],
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

        const raw = await codexPreflightSessionControlsProbeAdapter.probeModelsRaw?.({
            cwd: tempDir,
            timeoutMs: 2_000,
            backendTarget: undefined,
            profileId: profile.id,
            accountSettings: {
                profiles: [profile],
                secrets: [
                    {
                        id: 'openrouter-secret',
                        name: 'OpenRouter',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, value: 'saved-openrouter-key' },
                        createdAt: 0,
                        updatedAt: 0,
                    },
                ],
                secretBindingsByProfileId: {
                    [profile.id]: { OPENROUTER_API_KEY: 'openrouter-secret' },
                },
            },
            credentials,
            processEnv: {
                ...process.env,
                CODEX_HOME: codexHome,
                OPENROUTER_API_KEY: undefined,
            },
        });

        expect(raw).toEqual(expect.any(Array));
        expect(JSON.parse(readFileSync(captureFile, 'utf8'))).toMatchObject({
            CODEX_HOME: codexHome,
            OPENROUTER_API_KEY: 'saved-openrouter-key',
        });
    });

    it('fails closed before spawning app-server when the selected profile cannot be resolved', async () => {
        tempDir = makeTempDir('happier-codex-preflight-missing-profile-');

        const captureFile = join(tempDir, 'captured-env.json');
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fileURLToPath(new URL('./__fixtures__/fakeCodexAppServer.mjs', import.meta.url));
        process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '1';
        process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE = captureFile;

        const credentials: Credentials = {
            token: 'token-test',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        };

        await expect(codexPreflightSessionControlsProbeAdapter.probeModelsRaw?.({
            cwd: tempDir,
            timeoutMs: 2_000,
            backendTarget: undefined,
            profileId: 'missing-profile',
            accountSettings: { profiles: [] },
            credentials,
            processEnv: {
                ...process.env,
                OPENROUTER_API_KEY: 'ambient-key-that-must-not-be-used',
            },
        })).rejects.toThrow(/Unknown profile/);
        expect(existsSync(captureFile)).toBe(false);
    });
});
