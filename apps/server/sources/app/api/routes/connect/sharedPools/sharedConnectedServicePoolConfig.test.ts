import { describe, expect, it } from "vitest";

import {
    SharedConnectedServicePoolConfigError,
    listSharedConnectedServicePoolGranteeAccountIdsForOwner,
    readSharedConnectedServicePoolConfig,
    resolveSharedConnectedServicePoolGrant,
} from "./sharedConnectedServicePoolConfig";

const validConfig = JSON.stringify([
    {
        ownerAccountId: " owner-account ",
        serviceId: "openai-codex",
        groupId: "company-codex",
        granteeAccountIds: [" employee-a ", "employee-b"],
    },
]);

describe("shared connected service pool configuration", () => {
    it("treats an absent or blank policy as no delegation", () => {
        expect(readSharedConnectedServicePoolConfig({})).toEqual([]);
        expect(readSharedConnectedServicePoolConfig({
            HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON: "   ",
        })).toEqual([]);
    });

    it("normalizes one resource-scoped pool and resolves only its named grantees", () => {
        const env = { HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON: validConfig };

        expect(readSharedConnectedServicePoolConfig(env)).toEqual([
            {
                ownerAccountId: "owner-account",
                serviceId: "openai-codex",
                groupId: "company-codex",
                granteeAccountIds: ["employee-a", "employee-b"],
            },
        ]);
        expect(resolveSharedConnectedServicePoolGrant({
            env,
            requesterAccountId: "employee-a",
            serviceId: "openai-codex",
        })).toEqual({
            ownerAccountId: "owner-account",
            serviceId: "openai-codex",
            groupId: "company-codex",
            granteeAccountIds: ["employee-a", "employee-b"],
        });
        expect(resolveSharedConnectedServicePoolGrant({
            env,
            requesterAccountId: "unrelated",
            serviceId: "openai-codex",
        })).toBeNull();
        expect(resolveSharedConnectedServicePoolGrant({
            env,
            requesterAccountId: "employee-a",
            serviceId: "claude-subscription",
        })).toBeNull();
        expect(listSharedConnectedServicePoolGranteeAccountIdsForOwner({
            env,
            ownerAccountId: "owner-account",
        })).toEqual(["employee-a", "employee-b"]);
    });

    it.each([
        ["invalid JSON", "{"],
        ["non-array root", JSON.stringify({})],
        ["empty grantee list", JSON.stringify([{ ownerAccountId: "owner", serviceId: "openai-codex", groupId: "company", granteeAccountIds: [] }])],
        ["owner listed as grantee", JSON.stringify([{ ownerAccountId: "owner", serviceId: "openai-codex", groupId: "company", granteeAccountIds: ["owner"] }])],
        ["duplicate grantee", JSON.stringify([{ ownerAccountId: "owner", serviceId: "openai-codex", groupId: "company", granteeAccountIds: ["worker", "worker"] }])],
        ["reserved group id", JSON.stringify([{ ownerAccountId: "owner", serviceId: "openai-codex", groupId: "__groups", granteeAccountIds: ["worker"] }])],
    ])("fails closed for %s", (_label, raw) => {
        expect(() => readSharedConnectedServicePoolConfig({
            HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON: raw,
        })).toThrow(SharedConnectedServicePoolConfigError);
    });

    it("rejects ambiguous employee and service assignments across pools", () => {
        expect(() => readSharedConnectedServicePoolConfig({
            HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON: JSON.stringify([
                {
                    ownerAccountId: "owner-a",
                    serviceId: "openai-codex",
                    groupId: "company-a",
                    granteeAccountIds: ["employee"],
                },
                {
                    ownerAccountId: "owner-b",
                    serviceId: "openai-codex",
                    groupId: "company-b",
                    granteeAccountIds: ["employee"],
                },
            ]),
        })).toThrow(/more than one shared pool/i);
    });
});
