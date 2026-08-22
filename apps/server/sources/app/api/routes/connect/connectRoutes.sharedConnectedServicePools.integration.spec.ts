import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

const { emitUpdate } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
}));

vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<typeof import("@/app/events/eventRouter")>("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: { emitUpdate },
    };
});

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { buildAccountConnectedServicesProjection } from "../account/connectedServicesProfileProjection";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { connectRoutes } from "./connectRoutes";
import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    stringifyConnectedServiceAuthGroupPolicy,
} from "./connectedServicesV3/authGroupPolicy";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        (request as FastifyRequest & { userId: string }).userId = userId;
        return undefined;
    });

    return trackApp(typed);
}

async function createReadyApp() {
    const app = createTestApp();
    connectRoutes(app);
    await app.ready();
    return app;
}

async function createAccount(publicKey: string) {
    return db.account.create({ data: { publicKey }, select: { id: true } });
}

async function createConnectedProfile(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    credentialRevision: string;
}>) {
    return db.serviceAccountToken.create({
        data: {
            accountId: params.accountId,
            vendor: params.serviceId,
            profileId: params.profileId,
            token: Buffer.from(`sealed:${params.serviceId}:${params.profileId}`, "utf8"),
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "oauth",
                credentialRevision: params.credentialRevision,
            },
        },
    });
}

async function createGroup(params: Readonly<{
    accountId: string;
    serviceId: string;
    groupId: string;
    profileIds: readonly string[];
}>) {
    return db.connectedServiceAuthGroup.create({
        data: {
            accountId: params.accountId,
            vendor: params.serviceId,
            groupId: params.groupId,
            displayName: "Company Codex",
            policyJson: stringifyConnectedServiceAuthGroupPolicy(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1),
            activeProfileId: params.profileIds[0] ?? null,
            members: {
                create: params.profileIds.map((profileId, index) => ({
                    accountId: params.accountId,
                    vendor: params.serviceId,
                    groupId: params.groupId,
                    profileId,
                    priority: (index + 1) * 10,
                })),
            },
        },
    });
}

function authHeaders(accountId: string) {
    return { "content-type": "application/json", "x-test-user-id": accountId };
}

function createPlainCredentialRecord(params: Readonly<{
    profileId: string;
    accessToken: string;
    refreshToken: string;
    updatedAt?: number;
}>) {
    const now = params.updatedAt ?? Date.now();
    return {
        v: 1 as const,
        serviceId: "openai-codex" as const,
        profileId: params.profileId,
        kind: "oauth" as const,
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
        oauth: {
            accessToken: params.accessToken,
            refreshToken: params.refreshToken,
            idToken: null,
            scope: null,
            tokenType: null,
            providerAccountId: "company-openai-account",
            providerEmail: "company@example.com",
            raw: null,
        },
        token: null,
    };
}

describe("shared connected service pool delegation (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-shared-connected-service-pools-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.clearAllMocks();
        await db.accountChange.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("projects only the configured owner group and member profiles to a grantee", async () => {
        const owner = await createAccount("pk-shared-owner");
        const employee = await createAccount("pk-shared-employee");
        const secondEmployee = await createAccount("pk-shared-second-employee");
        const unrelated = await createAccount("pk-shared-unrelated");

        await createConnectedProfile({
            accountId: owner.id,
            serviceId: "openai-codex",
            profileId: "company-primary",
            credentialRevision: "csr_1123456789ABCDEFGHJKMNPQRS",
        });
        await createConnectedProfile({
            accountId: owner.id,
            serviceId: "openai-codex",
            profileId: "owner-private",
            credentialRevision: "csr_2123456789ABCDEFGHJKMNPQRS",
        });
        await createConnectedProfile({
            accountId: owner.id,
            serviceId: "github",
            profileId: "owner-github",
            credentialRevision: "csr_3123456789ABCDEFGHJKMNPQRS",
        });
        await createConnectedProfile({
            accountId: employee.id,
            serviceId: "openai-codex",
            profileId: "employee-collision",
            credentialRevision: "csr_4123456789ABCDEFGHJKMNPQRS",
        });
        await createConnectedProfile({
            accountId: unrelated.id,
            serviceId: "openai-codex",
            profileId: "unrelated-own",
            credentialRevision: "csr_5123456789ABCDEFGHJKMNPQRS",
        });
        await createGroup({
            accountId: owner.id,
            serviceId: "openai-codex",
            groupId: "company-codex",
            profileIds: ["company-primary"],
        });
        await createGroup({
            accountId: owner.id,
            serviceId: "openai-codex",
            groupId: "owner-private-group",
            profileIds: ["owner-private"],
        });

        harness.resetEnv({
            HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON: JSON.stringify([{
                ownerAccountId: owner.id,
                serviceId: "openai-codex",
                groupId: "company-codex",
                granteeAccountIds: [employee.id, secondEmployee.id],
            }]),
        });
        const app = await createReadyApp();

        const profiles = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: authHeaders(employee.id),
        });
        expect(profiles.statusCode).toBe(200);
        expect(profiles.json()).toEqual({
            serviceId: "openai-codex",
            profiles: [expect.objectContaining({ profileId: "company-primary" })],
        });

        const groups = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(employee.id),
        });
        expect(groups.statusCode).toBe(200);
        expect(groups.json()).toEqual({
            groups: [expect.objectContaining({
                groupId: "company-codex",
                members: [expect.objectContaining({ profileId: "company-primary" })],
            })],
        });

        const secondEmployeeGroups = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(secondEmployee.id),
        });
        expect(secondEmployeeGroups.statusCode).toBe(200);
        expect(secondEmployeeGroups.json()).toEqual({
            groups: [expect.objectContaining({ groupId: "company-codex" })],
        });

        const configuredGroup = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/company-codex",
            headers: authHeaders(employee.id),
        });
        expect(configuredGroup.statusCode).toBe(200);

        const ownerPrivateGroup = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/owner-private-group",
            headers: authHeaders(employee.id),
        });
        expect(ownerPrivateGroup.statusCode).toBe(404);

        const projection = await buildAccountConnectedServicesProjection({
            tx: db,
            accountId: employee.id,
        });
        expect(projection.connectedServicesV2).toEqual([
            expect.objectContaining({
                serviceId: "openai-codex",
                profiles: [expect.objectContaining({ profileId: "company-primary" })],
                groups: [expect.objectContaining({
                    groupId: "company-codex",
                    memberProfileIds: ["company-primary"],
                })],
            }),
        ]);
        expect(projection.connectedServiceCredentialRevisionsV1).toEqual([{
            serviceId: "openai-codex",
            profileId: "company-primary",
            credentialRevision: "csr_1123456789ABCDEFGHJKMNPQRS",
        }]);

        const unrelatedProfiles = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: authHeaders(unrelated.id),
        });
        expect(unrelatedProfiles.statusCode).toBe(200);
        expect(unrelatedProfiles.json()).toEqual({
            serviceId: "openai-codex",
            profiles: [expect.objectContaining({ profileId: "unrelated-own" })],
        });

        const createAsEmployee = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups",
            headers: authHeaders(employee.id),
            payload: {
                groupId: "employee-created",
                members: [{ profileId: "employee-collision" }],
                activeProfileId: "employee-collision",
            },
        });
        expect(createAsEmployee.statusCode).toBe(404);
        expect(createAsEmployee.json()).toEqual({ error: "not_found" });
    });

    it("preserves account-owned discovery when no shared pool is configured", async () => {
        const account = await createAccount("pk-unconfigured-account");
        await createConnectedProfile({
            accountId: account.id,
            serviceId: "openai-codex",
            profileId: "own-profile",
            credentialRevision: "csr_6123456789ABCDEFGHJKMNPQRS",
        });
        const app = await createReadyApp();

        const profiles = await app.inject({
            method: "GET",
            url: "/v2/connect/openai-codex/profiles",
            headers: authHeaders(account.id),
        });
        expect(profiles.statusCode).toBe(200);
        expect(profiles.json()).toEqual({
            serviceId: "openai-codex",
            profiles: [expect.objectContaining({ profileId: "own-profile" })],
        });
    });

    it("shares one owner credential lifecycle with plain employees and an E2EE operator account", async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const employee = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const secondEmployee = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const operator = await db.account.create({
            data: { publicKey: "pk-shared-e2ee-operator", encryptionMode: "e2ee" },
            select: { id: true },
        });
        const unrelated = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await createConnectedProfile({
            accountId: operator.id,
            serviceId: "github",
            profileId: "operator-private-github",
            credentialRevision: "csr_7123456789ABCDEFGHJKMNPQRS",
        });

        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "server_sealed",
            HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON: JSON.stringify([{
                ownerAccountId: owner.id,
                serviceId: "openai-codex",
                groupId: "company-codex",
                granteeAccountIds: [employee.id, secondEmployee.id, operator.id],
            }]),
        });
        const app = await createReadyApp();

        const initialRecord = createPlainCredentialRecord({
            profileId: "company-primary",
            accessToken: "company-access-a",
            refreshToken: "company-refresh-a",
        });
        const register = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential",
            headers: authHeaders(owner.id),
            payload: { content: { t: "plain", v: initialRecord } },
        });
        expect(register.statusCode).toBe(200);
        const revisionA = (register.json() as { credentialRevision: string }).credentialRevision;

        const registerPrivate = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/owner-private/credential",
            headers: authHeaders(owner.id),
            payload: {
                content: {
                    t: "plain",
                    v: createPlainCredentialRecord({
                        profileId: "owner-private",
                        accessToken: "owner-private-access",
                        refreshToken: "owner-private-refresh",
                    }),
                },
            },
        });
        expect(registerPrivate.statusCode).toBe(200);

        await createGroup({
            accountId: owner.id,
            serviceId: "openai-codex",
            groupId: "company-codex",
            profileIds: ["company-primary"],
        });

        const operatorProjection = await buildAccountConnectedServicesProjection({
            tx: db,
            accountId: operator.id,
        });
        expect(operatorProjection.connectedServicesV2).toEqual(expect.arrayContaining([
            expect.objectContaining({
                serviceId: "openai-codex",
                profiles: [expect.objectContaining({ profileId: "company-primary" })],
            }),
            expect.objectContaining({
                serviceId: "github",
                profiles: [expect.objectContaining({ profileId: "operator-private-github" })],
            }),
        ]));

        for (const granteeAccountId of [employee.id, secondEmployee.id, operator.id]) {
            const read = await app.inject({
                method: "GET",
                url: "/v3/connect/openai-codex/profiles/company-primary/credential",
                headers: authHeaders(granteeAccountId),
            });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toEqual({
                credentialRevision: revisionA,
                content: { t: "plain", v: initialRecord },
            });
        }

        const privateRead = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/owner-private/credential",
            headers: authHeaders(employee.id),
        });
        expect(privateRead.statusCode).toBe(404);

        const unrelatedRead = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential",
            headers: authHeaders(unrelated.id),
        });
        expect(unrelatedRead.statusCode).toBe(404);

        const unfencedWrite = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential",
            headers: authHeaders(employee.id),
            payload: {
                content: {
                    t: "plain",
                    v: createPlainCredentialRecord({
                        profileId: "company-primary",
                        accessToken: "unfenced-access",
                        refreshToken: "unfenced-refresh",
                    }),
                },
            },
        });
        expect(unfencedWrite.statusCode).toBe(404);

        const employeeLease = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/company-primary/refresh-lease",
            headers: authHeaders(employee.id),
            payload: {
                machineId: "employee-machine",
                ownerId: "refresh-attempt-a",
                leaseMs: 60_000,
                expectedCredentialRevision: revisionA,
            },
        });
        expect(employeeLease.statusCode).toBe(200);
        expect(employeeLease.json()).toEqual(expect.objectContaining({
            acquired: true,
            ownerId: "refresh-attempt-a",
            credentialRevision: revisionA,
        }));

        const contendedLease = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/company-primary/refresh-lease",
            headers: authHeaders(secondEmployee.id),
            payload: {
                machineId: "second-employee-machine",
                ownerId: "refresh-attempt-b",
                leaseMs: 60_000,
                expectedCredentialRevision: revisionA,
            },
        });
        expect(contendedLease.statusCode).toBe(200);
        expect(contendedLease.json()).toEqual(expect.objectContaining({
            acquired: false,
            ownerId: "refresh-attempt-b",
            credentialRevision: revisionA,
        }));

        const refreshedRecord = createPlainCredentialRecord({
            profileId: "company-primary",
            accessToken: "company-access-b",
            refreshToken: "company-refresh-b",
            updatedAt: initialRecord.updatedAt + 1,
        });
        const refresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential",
            headers: authHeaders(employee.id),
            payload: {
                content: { t: "plain", v: refreshedRecord },
                expectedCredentialRevision: revisionA,
                refreshLeaseOwnerId: "refresh-attempt-a",
            },
        });
        expect(refresh.statusCode).toBe(200);
        const revisionB = (refresh.json() as { credentialRevision: string }).credentialRevision;
        expect(revisionB).not.toBe(revisionA);

        const replayRefresh = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential",
            headers: authHeaders(employee.id),
            payload: {
                content: { t: "plain", v: refreshedRecord },
                expectedCredentialRevision: revisionB,
                refreshLeaseOwnerId: "refresh-attempt-a",
            },
        });
        expect(replayRefresh.statusCode).toBe(409);
        expect(replayRefresh.json()).toEqual({
            error: "connect_credential_mutation_superseded",
            reason: "refresh_lease_lost",
            credentialRevision: revisionB,
        });

        const readAfterRefresh = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential",
            headers: authHeaders(secondEmployee.id),
        });
        expect(readAfterRefresh.statusCode).toBe(200);
        expect(readAfterRefresh.json()).toEqual({
            credentialRevision: revisionB,
            content: { t: "plain", v: refreshedRecord },
        });

        const health = {
            v: 1 as const,
            status: "needs_reauth" as const,
            reconnectRequired: true,
            lastRefreshFailureAt: Date.now(),
            lastRefreshFailureKind: "invalid_grant" as const,
        };
        const healthUpdate = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential/health",
            headers: authHeaders(operator.id),
            payload: { health, expectedCredentialRevision: revisionB },
        });
        expect(healthUpdate.statusCode).toBe(200);
        expect(healthUpdate.json()).toEqual({ success: true, credentialRevision: revisionB });

        const delegatedDelete = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/profiles/company-primary/credential",
            headers: { "x-test-user-id": employee.id },
        });
        expect(delegatedDelete.statusCode).toBe(404);

        const rows = await db.serviceAccountToken.findMany({
            where: { vendor: "openai-codex" },
            select: { accountId: true, profileId: true, token: true, metadata: true },
            orderBy: { profileId: "asc" },
        });
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => ({ accountId: row.accountId, profileId: row.profileId }))).toEqual([
            { accountId: owner.id, profileId: "company-primary" },
            { accountId: owner.id, profileId: "owner-private" },
        ]);
        const sharedRow = rows.find((row) => row.profileId === "company-primary");
        expect(sharedRow?.metadata).toEqual(expect.objectContaining({ health }));
        expect(Buffer.from(sharedRow!.token).toString("utf8")).not.toContain("company-access-b");
    });

    it("shares fenced group runtime state and publishes filtered changes to every grantee", async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const employee = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const secondEmployee = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const unrelated = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        for (const profileId of ["company-primary", "company-secondary", "owner-private"]) {
            await createConnectedProfile({
                accountId: owner.id,
                serviceId: "openai-codex",
                profileId,
                credentialRevision: profileId === "company-primary"
                    ? "csr_8123456789ABCDEFGHJKMNPQRS"
                    : profileId === "company-secondary"
                        ? "csr_9123456789ABCDEFGHJKMNPQRS"
                        : "csr_A123456789ABCDEFGHJKMNPQRS",
            });
        }
        await createGroup({
            accountId: owner.id,
            serviceId: "openai-codex",
            groupId: "company-codex",
            profileIds: ["company-primary", "company-secondary"],
        });
        await createGroup({
            accountId: owner.id,
            serviceId: "openai-codex",
            groupId: "owner-private-group",
            profileIds: ["owner-private"],
        });

        harness.resetEnv({
            HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON: JSON.stringify([{
                ownerAccountId: owner.id,
                serviceId: "openai-codex",
                groupId: "company-codex",
                granteeAccountIds: [employee.id, secondEmployee.id, "missing-grantee-account"],
            }]),
        });
        const app = await createReadyApp();

        const runtimeUpdate = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/company-codex/runtime-state",
            headers: authHeaders(employee.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                state: { status: "switching", lastSwitchReason: "usage_limit" },
                memberStates: [{
                    profileId: "company-primary",
                    state: {
                        quotaExhaustedUntilMs: 10,
                        lastFailureKind: "usage_limit",
                    },
                }],
            },
        });
        expect(runtimeUpdate.statusCode).toBe(200);
        expect(runtimeUpdate.json()).toEqual({
            group: expect.objectContaining({
                groupId: "company-codex",
                generation: 0,
                runtimeStateRevision: 1,
                state: expect.objectContaining({ status: "switching", lastSwitchReason: "usage_limit" }),
            }),
        });

        const staleRuntimeUpdate = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/company-codex/runtime-state",
            headers: authHeaders(secondEmployee.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                state: { status: "exhausted" },
            },
        });
        expect(staleRuntimeUpdate.statusCode).toBe(409);
        expect(staleRuntimeUpdate.json()).toEqual({
            error: "connect_group_runtime_state_revision_conflict",
            runtimeStateRevision: 1,
        });

        const switched = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/company-codex/active-profile",
            headers: authHeaders(secondEmployee.id),
            payload: { profileId: "company-secondary", expectedGeneration: 0 },
        });
        expect(switched.statusCode).toBe(200);
        expect(switched.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "company-secondary",
                generation: 1,
                runtimeStateRevision: 1,
            }),
        });

        const staleSwitch = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/company-codex/active-profile",
            headers: authHeaders(employee.id),
            payload: { profileId: "company-primary", expectedGeneration: 0 },
        });
        expect(staleSwitch.statusCode).toBe(409);
        expect(staleSwitch.json()).toEqual({
            error: "connect_group_generation_conflict",
            generation: 1,
        });

        const current = await app.inject({
            method: "GET",
            url: "/v3/connect/openai-codex/groups/company-codex",
            headers: authHeaders(employee.id),
        });
        expect(current.statusCode).toBe(200);
        expect(current.json()).toEqual({
            group: expect.objectContaining({
                activeProfileId: "company-secondary",
                generation: 1,
                runtimeStateRevision: 1,
                members: expect.arrayContaining([
                    expect.objectContaining({
                        profileId: "company-primary",
                        state: expect.objectContaining({ quotaExhaustedUntilMs: 10 }),
                    }),
                ]),
            }),
        });

        const privateRuntimeUpdate = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/owner-private-group/runtime-state",
            headers: authHeaders(employee.id),
            payload: {
                expectedGeneration: 0,
                expectedRuntimeStateRevision: 0,
                state: { status: "error" },
            },
        });
        expect(privateRuntimeUpdate.statusCode).toBe(404);

        const adminPatch = await app.inject({
            method: "PATCH",
            url: "/v3/connect/openai-codex/groups/company-codex",
            headers: authHeaders(employee.id),
            payload: { displayName: "Employee rename" },
        });
        expect(adminPatch.statusCode).toBe(404);

        const adminMember = await app.inject({
            method: "POST",
            url: "/v3/connect/openai-codex/groups/company-codex/members",
            headers: authHeaders(employee.id),
            payload: { profileId: "owner-private", expectedGeneration: 1 },
        });
        expect(adminMember.statusCode).toBe(404);

        const adminDelete = await app.inject({
            method: "DELETE",
            url: "/v3/connect/openai-codex/groups/company-codex",
            headers: { "x-test-user-id": employee.id },
        });
        expect(adminDelete.statusCode).toBe(404);

        const changes = await db.accountChange.findMany({
            where: { kind: "account", entityId: "self" },
            select: { accountId: true, hint: true },
        });
        expect(changes.map((change) => change.accountId).sort()).toEqual([
            employee.id,
            owner.id,
            secondEmployee.id,
        ].sort());
        expect(changes.every((change) => (change.hint as { connectedServices?: boolean })?.connectedServices === true)).toBe(true);

        for (const granteeAccountId of [employee.id, secondEmployee.id]) {
            const emitted = emitUpdate.mock.calls
                .map(([event]) => event)
                .find((event) => event.userId === granteeAccountId);
            expect(emitted).toEqual(expect.objectContaining({
                userId: granteeAccountId,
                payload: expect.objectContaining({
                    body: expect.objectContaining({
                        connectedServicesV2: [expect.objectContaining({
                            serviceId: "openai-codex",
                            groups: [expect.objectContaining({ groupId: "company-codex" })],
                        })],
                    }),
                }),
            }));
            expect(JSON.stringify(emitted)).not.toContain("owner-private");
        }
        expect(emitUpdate.mock.calls.some(([event]) => event.userId === unrelated.id)).toBe(false);
    });
});
