import type { AccountProfile, ConnectedServiceId } from "@happier-dev/protocol";
import { ConnectedServiceIdSchema } from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import {
    isConnectedServiceCredentialMetadataV2,
    normalizeConnectedServiceCredentialMetadataV2,
} from "../connect/connectedServicesV2/credentialMetadataV2";
import {
    isConnectedServiceCredentialMetadataV3,
    normalizeConnectedServiceCredentialMetadataV3,
} from "../connect/connectedServicesV3/credentialMetadataV3";
import { deriveConnectedServiceCredentialStatus } from "../connect/credentialHealthMetadata";
import { resolveConnectedServiceCredentialRevision } from "../connect/credentials/credentialRevision";
import { listSharedConnectedServicePoolGrantsForGrantee } from "../connect/sharedPools/sharedConnectedServicePoolConfig";

export type AccountConnectedServicesProjection = Pick<
    AccountProfile,
    "connectedServices" | "connectedServicesV2" | "connectedServiceCredentialRevisionsV1"
>;
export type ConnectedServicesProjectionClient = Pick<Tx, "serviceAccountToken" | "connectedServiceAuthGroup">;

type ConnectedServiceProfile = AccountProfile["connectedServicesV2"][number]["profiles"][number];
type ConnectedServiceGroup = AccountProfile["connectedServicesV2"][number]["groups"][number];
type ConnectedServiceEntry = AccountProfile["connectedServicesV2"][number];

type ServiceAccountTokenProjectionRow = Readonly<{
    id: string;
    vendor: string;
    profileId: string;
    metadata: unknown;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
}>;

type ConnectedServiceAuthGroupProjectionRow = Readonly<{
    vendor: string;
    groupId: string;
    displayName: string | null;
    activeProfileId: string | null;
    generation: number;
    members: readonly Readonly<{
        profileId: string;
        enabled: boolean;
    }>[];
}>;

function projectConnectedServiceProfile(row: ServiceAccountTokenProjectionRow): ConnectedServiceProfile {
    const metadataV2 = isConnectedServiceCredentialMetadataV2(row.metadata)
        ? normalizeConnectedServiceCredentialMetadataV2(row.metadata)
        : null;
    const metadataV3 = !metadataV2 && isConnectedServiceCredentialMetadataV3(row.metadata)
        ? normalizeConnectedServiceCredentialMetadataV3(row.metadata)
        : null;
    const metadata = metadataV2 ?? metadataV3;

    return {
        profileId: row.profileId,
        status: deriveConnectedServiceCredentialStatus(metadata),
        kind: metadata?.kind ?? null,
        providerEmail: metadata?.providerEmail ?? null,
        providerAccountId: metadata?.providerAccountId ?? null,
        expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
        health: metadata?.health ?? null,
    };
}

function buildConnectedVendors(tokens: readonly ServiceAccountTokenProjectionRow[]): string[] {
    return Array.from(new Set(
        tokens
            .filter((token) => token.profileId === "default")
            .map((token) => token.vendor)
            .filter((vendor) => vendor === "openai" || vendor === "anthropic" || vendor === "gemini"),
    ));
}

function buildConnectedServicesV2FromTokens(tokens: readonly ServiceAccountTokenProjectionRow[]): ConnectedServiceEntry[] {
    const servicesById = new Map<ConnectedServiceId, ConnectedServiceProfile[]>();

    for (const row of tokens) {
        const parsedServiceId = ConnectedServiceIdSchema.safeParse(row.vendor);
        if (!parsedServiceId.success) continue;

        const serviceId = parsedServiceId.data;
        const profiles = servicesById.get(serviceId) ?? [];
        profiles.push(projectConnectedServiceProfile(row));
        servicesById.set(serviceId, profiles);
    }

    return Array.from(servicesById, ([serviceId, profiles]) => ({
        serviceId,
        profiles,
        groups: [],
    }));
}

export async function buildAccountConnectedServicesProjection(params: Readonly<{
    tx: ConnectedServicesProjectionClient;
    accountId: string;
    env?: NodeJS.ProcessEnv;
}>): Promise<AccountConnectedServicesProjection> {
    const env = params.env ?? process.env;
    const connectedServicesEnabled = isServerFeatureEnabledForRequest("connectedServices", env);
    if (!connectedServicesEnabled) {
        return { connectedServices: [], connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] };
    }

    const grants = listSharedConnectedServicePoolGrantsForGrantee({
        env,
        requesterAccountId: params.accountId,
    });
    const delegatedServiceIds = new Set(grants.map((grant) => grant.serviceId));

    const ownTokens = await params.tx.serviceAccountToken.findMany({
        where: { accountId: params.accountId },
        select: {
            id: true,
            vendor: true,
            profileId: true,
            metadata: true,
            expiresAt: true,
            lastUsedAt: true,
        },
        orderBy: [{ vendor: "asc" }, { profileId: "asc" }],
    });

    const tokens: ServiceAccountTokenProjectionRow[] = ownTokens.filter(
        (row) => !delegatedServiceIds.has(row.vendor as ConnectedServiceId),
    );
    const delegatedGroups: ConnectedServiceAuthGroupProjectionRow[] = [];

    for (const grant of grants) {
        const group = await params.tx.connectedServiceAuthGroup.findUnique({
            where: {
                accountId_vendor_groupId: {
                    accountId: grant.ownerAccountId,
                    vendor: grant.serviceId,
                    groupId: grant.groupId,
                },
            },
            select: {
                vendor: true,
                groupId: true,
                displayName: true,
                activeProfileId: true,
                generation: true,
                members: {
                    select: { profileId: true, enabled: true },
                    orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { profileId: "asc" }],
                },
            },
        });
        if (!group) continue;

        const memberProfileIds = group.members.map((member) => member.profileId);
        const sharedTokens = await params.tx.serviceAccountToken.findMany({
            where: {
                accountId: grant.ownerAccountId,
                vendor: grant.serviceId,
                profileId: { in: memberProfileIds },
            },
            select: {
                id: true,
                vendor: true,
                profileId: true,
                metadata: true,
                expiresAt: true,
                lastUsedAt: true,
            },
            orderBy: [{ vendor: "asc" }, { profileId: "asc" }],
        });
        tokens.push(...sharedTokens);
        delegatedGroups.push(group);
    }

    tokens.sort((left, right) => (
        left.vendor.localeCompare(right.vendor) || left.profileId.localeCompare(right.profileId)
    ));

    const connectedServices = buildConnectedVendors(tokens);
    const connectedServicesV2 = buildConnectedServicesV2FromTokens(tokens);
    const connectedServiceCredentialRevisionsV1 = tokens.flatMap((row) => {
        const serviceId = ConnectedServiceIdSchema.safeParse(row.vendor);
        return serviceId.success
            ? [{
                serviceId: serviceId.data,
                profileId: row.profileId,
                credentialRevision: resolveConnectedServiceCredentialRevision({
                    rowId: row.id,
                    metadata: row.metadata,
                }),
            }]
            : [];
    });

    if (!isServerFeatureEnabledForRequest("connectedServices.accountGroups", env)) {
        return { connectedServices, connectedServicesV2, connectedServiceCredentialRevisionsV1 };
    }

    const ownAuthGroups = await params.tx.connectedServiceAuthGroup.findMany({
        where: { accountId: params.accountId },
        select: {
            vendor: true,
            groupId: true,
            displayName: true,
            activeProfileId: true,
            generation: true,
            members: {
                select: { profileId: true, enabled: true },
                orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { profileId: "asc" }],
            },
        },
        orderBy: [{ vendor: "asc" }, { groupId: "asc" }],
    });
    const authGroups = [
        ...ownAuthGroups.filter((group) => !delegatedServiceIds.has(group.vendor as ConnectedServiceId)),
        ...delegatedGroups,
    ].sort((left, right) => (
        left.vendor.localeCompare(right.vendor) || left.groupId.localeCompare(right.groupId)
    ));

    const servicesById = new Map(connectedServicesV2.map((entry) => [entry.serviceId, entry]));
    for (const group of authGroups) {
        const parsedServiceId = ConnectedServiceIdSchema.safeParse(group.vendor);
        if (!parsedServiceId.success) continue;

        const serviceId = parsedServiceId.data;
        const existing = servicesById.get(serviceId) ?? {
            serviceId,
            profiles: [],
            groups: [] as ConnectedServiceGroup[],
        };
        const memberProfileIds = group.members
            .filter((member) => member.enabled)
            .map((member) => member.profileId);
        existing.groups.push({
            groupId: group.groupId,
            displayName: group.displayName,
            activeProfileId: group.activeProfileId && memberProfileIds.includes(group.activeProfileId)
                ? group.activeProfileId
                : null,
            generation: group.generation,
            memberProfileIds,
        });
        servicesById.set(serviceId, existing);
    }

    return {
        connectedServices,
        connectedServicesV2: Array.from(servicesById.values()),
        connectedServiceCredentialRevisionsV1,
    };
}
