import type {
    ConnectedServiceId,
    ConnectedServiceUsageSourceV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import {
    resolveSharedConnectedServicePoolGrant,
    type SharedConnectedServicePoolGrant,
} from "./sharedConnectedServicePoolConfig";

type SharedConnectedServicePoolAccessClient = Pick<
    Tx,
    "connectedServiceAuthGroup" | "connectedServiceAuthGroupMember"
>;

export type ConnectedServiceResourceScope =
    | Readonly<{
        kind: "owned";
        requesterAccountId: string;
        resourceAccountId: string;
        serviceId: ConnectedServiceId;
      }>
    | Readonly<{
        kind: "shared";
        requesterAccountId: string;
        resourceAccountId: string;
        serviceId: ConnectedServiceId;
        groupId: string;
        grant: SharedConnectedServicePoolGrant;
      }>;

export function resolveConnectedServiceOwnerOnlyAccountId(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    requesterAccountId: string;
    serviceId: ConnectedServiceId;
}>): string | null {
    const grant = resolveSharedConnectedServicePoolGrant(params);
    return grant ? null : params.requesterAccountId;
}

export async function resolveConnectedServiceResourceScope(params: Readonly<{
    client?: SharedConnectedServicePoolAccessClient;
    env?: NodeJS.ProcessEnv;
    requesterAccountId: string;
    serviceId: ConnectedServiceId;
}>): Promise<ConnectedServiceResourceScope | null> {
    const grant = resolveSharedConnectedServicePoolGrant(params);
    if (!grant) {
        return {
            kind: "owned",
            requesterAccountId: params.requesterAccountId,
            resourceAccountId: params.requesterAccountId,
            serviceId: params.serviceId,
        };
    }

    const client = params.client ?? db;
    const group = await client.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: grant.ownerAccountId,
                vendor: grant.serviceId,
                groupId: grant.groupId,
            },
        },
        select: { id: true },
    });
    if (!group) return null;

    return {
        kind: "shared",
        requesterAccountId: params.requesterAccountId,
        resourceAccountId: grant.ownerAccountId,
        serviceId: grant.serviceId,
        groupId: grant.groupId,
        grant,
    };
}

export async function resolveConnectedServiceGroupResourceScope(params: Readonly<{
    client?: SharedConnectedServicePoolAccessClient;
    env?: NodeJS.ProcessEnv;
    requesterAccountId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
}>): Promise<ConnectedServiceResourceScope | null> {
    const scope = await resolveConnectedServiceResourceScope(params);
    if (scope?.kind === "shared" && scope.groupId !== params.groupId) return null;
    return scope;
}

export async function resolveConnectedServiceProfileResourceScope(params: Readonly<{
    client?: SharedConnectedServicePoolAccessClient;
    env?: NodeJS.ProcessEnv;
    requesterAccountId: string;
    serviceId: ConnectedServiceId;
    profileId: string;
}>): Promise<ConnectedServiceResourceScope | null> {
    const client = params.client ?? db;
    const scope = await resolveConnectedServiceResourceScope({ ...params, client });
    if (scope?.kind !== "shared") return scope;

    const member = await client.connectedServiceAuthGroupMember.findUnique({
        where: {
            accountId_vendor_groupId_profileId: {
                accountId: scope.resourceAccountId,
                vendor: scope.serviceId,
                groupId: scope.groupId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    return member ? scope : null;
}

export async function resolveConnectedServiceUsageSourceResourceScope(params: Readonly<{
    client?: SharedConnectedServicePoolAccessClient;
    env?: NodeJS.ProcessEnv;
    requesterAccountId: string;
    source: ConnectedServiceUsageSourceV1;
}>): Promise<ConnectedServiceResourceScope | null> {
    const scope = await resolveConnectedServiceProfileResourceScope({
        client: params.client,
        env: params.env,
        requesterAccountId: params.requesterAccountId,
        serviceId: params.source.serviceId,
        profileId: params.source.profileId,
    });
    if (
        scope?.kind === "shared"
        && params.source.bindingKind === "group_member"
        && params.source.groupId !== scope.groupId
    ) {
        return null;
    }
    return scope;
}
