import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

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

describe("shared connected service pool delegation (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-shared-connected-service-pools-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
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
});
