import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceIdSchema,
    type ConnectedServiceAuthGroupId,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { z } from "zod";

export const SHARED_CONNECTED_SERVICE_POOLS_ENV_NAME = "HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON";

const AccountIdSchema = z.string().trim().min(1).max(256);

const SharedConnectedServicePoolGrantSchema = z.object({
    ownerAccountId: AccountIdSchema,
    serviceId: ConnectedServiceIdSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    granteeAccountIds: z.array(AccountIdSchema).min(1),
}).strict().superRefine((grant, context) => {
    if (grant.granteeAccountIds.includes(grant.ownerAccountId)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A shared pool owner cannot also be its grantee",
            path: ["granteeAccountIds"],
        });
    }

    if (new Set(grant.granteeAccountIds).size !== grant.granteeAccountIds.length) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A shared pool cannot contain duplicate grantees",
            path: ["granteeAccountIds"],
        });
    }
});

const SharedConnectedServicePoolConfigSchema = z.array(SharedConnectedServicePoolGrantSchema).superRefine(
    (grants, context) => {
        const configuredResources = new Set<string>();
        const granteeServices = new Set<string>();

        grants.forEach((grant, grantIndex) => {
            const resourceKey = `${grant.ownerAccountId}\u0000${grant.serviceId}\u0000${grant.groupId}`;
            if (configuredResources.has(resourceKey)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "The same shared pool is configured more than once",
                    path: [grantIndex],
                });
            }
            configuredResources.add(resourceKey);

            grant.granteeAccountIds.forEach((granteeAccountId) => {
                const granteeServiceKey = `${granteeAccountId}\u0000${grant.serviceId}`;
                if (granteeServices.has(granteeServiceKey)) {
                    context.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "An account and service cannot be assigned to more than one shared pool",
                        path: [grantIndex, "granteeAccountIds"],
                    });
                }
                granteeServices.add(granteeServiceKey);
            });
        });
    },
);

export type SharedConnectedServicePoolGrant = Readonly<{
    ownerAccountId: string;
    serviceId: ConnectedServiceId;
    groupId: ConnectedServiceAuthGroupId;
    granteeAccountIds: readonly string[];
}>;

type SharedConnectedServicePoolEnvironment = Readonly<Record<string, string | undefined>>;

export class SharedConnectedServicePoolConfigError extends Error {
    constructor(reason?: string) {
        super([
            `Invalid ${SHARED_CONNECTED_SERVICE_POOLS_ENV_NAME} configuration`,
            reason,
        ].filter(Boolean).join(": "));
        this.name = "SharedConnectedServicePoolConfigError";
    }
}

export function readSharedConnectedServicePoolConfig(
    env: SharedConnectedServicePoolEnvironment = process.env,
): readonly SharedConnectedServicePoolGrant[] {
    const raw = env[SHARED_CONNECTED_SERVICE_POOLS_ENV_NAME];
    if (raw == null || raw.trim().length === 0) return [];

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch {
        throw new SharedConnectedServicePoolConfigError("invalid JSON");
    }

    const parsedConfig = SharedConnectedServicePoolConfigSchema.safeParse(parsedJson);
    if (!parsedConfig.success) {
        throw new SharedConnectedServicePoolConfigError(parsedConfig.error.issues[0]?.message);
    }
    return parsedConfig.data;
}

export function resolveSharedConnectedServicePoolGrant(params: Readonly<{
    env?: SharedConnectedServicePoolEnvironment;
    requesterAccountId: string;
    serviceId: ConnectedServiceId;
}>): SharedConnectedServicePoolGrant | null {
    return readSharedConnectedServicePoolConfig(params.env).find((grant) => (
        grant.serviceId === params.serviceId
        && grant.granteeAccountIds.includes(params.requesterAccountId)
    )) ?? null;
}

export function listSharedConnectedServicePoolGrantsForGrantee(params: Readonly<{
    env?: SharedConnectedServicePoolEnvironment;
    requesterAccountId: string;
}>): readonly SharedConnectedServicePoolGrant[] {
    return readSharedConnectedServicePoolConfig(params.env).filter((grant) => (
        grant.granteeAccountIds.includes(params.requesterAccountId)
    ));
}

export function listSharedConnectedServicePoolGranteeAccountIdsForOwner(params: Readonly<{
    env?: SharedConnectedServicePoolEnvironment;
    ownerAccountId: string;
}>): readonly string[] {
    return [...new Set(
        readSharedConnectedServicePoolConfig(params.env)
            .filter((grant) => grant.ownerAccountId === params.ownerAccountId)
            .flatMap((grant) => grant.granteeAccountIds),
    )];
}
