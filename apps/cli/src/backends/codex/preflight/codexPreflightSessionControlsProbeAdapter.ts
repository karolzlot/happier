import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { withCodexAppServerControlClient } from '@/backends/codex/appServer/control/withCodexAppServerControlClient';
import { readCodexAppServerSessionControls } from '@/backends/codex/appServer/sessionControlsMetadata';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';
import type { Credentials } from '@/persistence';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveProfileForAgent } from '@/settings/profiles/resolveProfileForAgent';

async function buildCodexProbeProcessEnv(params: Readonly<{
    timeoutMs: number;
    profileId?: string | null;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    credentials?: Credentials | null;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<NodeJS.ProcessEnv> {
    const processEnv: NodeJS.ProcessEnv = {
        ...(params.processEnv ?? process.env),
    };
    const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';

    if (profileId) {
        if (!params.accountSettings) {
            throw new Error(`Cannot probe Codex profile "${profileId}" without account settings.`);
        }
        if (!params.credentials) {
            throw new Error(`Cannot probe Codex profile "${profileId}" without credentials.`);
        }

        const { customProfiles } = readProfilesFromAccountSettings(params.accountSettings);
        const profile = resolveProfileForAgent({
            agentId: 'codex',
            query: profileId,
            customProfiles,
        });
        const profileEnv = await buildProfileEnvOverlay({
            agentId: 'codex',
            profile,
            accountSettings: params.accountSettings,
            credentials: params.credentials,
            processEnv,
            promptSecretFn: null,
            startedBy: 'daemon',
        });
        Object.assign(processEnv, profileEnv.envOverlayExpanded);
    }

    // Ensure slow `model/list` does not silently downgrade the UI to static models (which have no model options).
    processEnv.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = String(
        Math.max(250, Math.min(60_000, Math.trunc(params.timeoutMs))),
    );
    return processEnv;
}

async function readControls(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    profileId?: string | null;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    credentials?: Credentials | null;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<Awaited<ReturnType<typeof readCodexAppServerSessionControls>> | null> {
    const processEnv = await buildCodexProbeProcessEnv(params);
    const authMethod = readCodexEnvironmentAuthState(processEnv).method;
    const result = await withCodexAppServerControlClient({
        processEnv,
        cwd: params.cwd,
        accountSettings: params.accountSettings ?? null,
        timeoutMs: params.timeoutMs,
        run: async (client) =>
            readCodexAppServerSessionControls({
                client,
                authMethod,
            }),
    });
    return result.ok ? result.value : null;
}

export const codexPreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
    connectedServiceAuth: 'materialized-env',
    modelProbeCachePolicy: 'provider-owned',
    failureCacheStrategy: 'retry',
    probeModelsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            profileId: params.profileId,
            accountSettings: params.accountSettings ?? null,
            credentials: params.credentials ?? null,
            processEnv: params.processEnv,
        });
        return controls ? controls.availableModels : null;
    },
    probeModesRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            profileId: params.profileId,
            accountSettings: params.accountSettings ?? null,
            credentials: params.credentials ?? null,
            processEnv: params.processEnv,
        });
        return controls ? controls.availableModes : null;
    },
    probeConfigOptionsRaw: async (params) => {
        const controls = await readControls({
            cwd: params.cwd,
            timeoutMs: params.timeoutMs,
            profileId: params.profileId,
            accountSettings: params.accountSettings ?? null,
            credentials: params.credentials ?? null,
            processEnv: params.processEnv,
        });
        return controls ? controls.configOptions : null;
    },
};
