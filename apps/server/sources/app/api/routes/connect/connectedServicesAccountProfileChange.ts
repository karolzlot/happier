import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { buildAccountConnectedServicesProjection } from "../account/connectedServicesProfileProjection";
import { listSharedConnectedServicePoolGranteeAccountIdsForOwner } from "./sharedPools/sharedConnectedServicePoolConfig";

export async function recordConnectedServiceAccountProfileChange(
    tx: Tx,
    params: Readonly<{ accountId: string }>,
): Promise<number> {
    const candidateAccountIds = [
        params.accountId,
        ...listSharedConnectedServicePoolGranteeAccountIdsForOwner({
            ownerAccountId: params.accountId,
        }),
    ];
    const existingAccounts = await tx.account.findMany({
        where: { id: { in: candidateAccountIds } },
        select: { id: true },
    });
    const existingAccountIds = new Set(existingAccounts.map((account) => account.id));
    if (!existingAccountIds.has(params.accountId)) {
        throw new Error("Connected Services change owner account does not exist");
    }

    const changes: Array<Readonly<{
        accountId: string;
        cursor: number;
        projection: Awaited<ReturnType<typeof buildAccountConnectedServicesProjection>>;
    }>> = [];
    for (const accountId of candidateAccountIds) {
        if (!existingAccountIds.has(accountId)) continue;
        const projection = await buildAccountConnectedServicesProjection({ tx, accountId });
        const cursor = await markAccountChanged(tx, {
            accountId,
            kind: "account",
            entityId: "self",
            hint: { connectedServices: true },
        });
        changes.push({ accountId, cursor, projection });
    }

    afterTx(tx, () => {
        for (const change of changes) {
            const payload = buildUpdateAccountUpdate(
                change.accountId,
                change.projection,
                change.cursor,
                randomKeyNaked(12),
            );
            // Machine-scoped daemons are the canonical consumers that apply committed
            // group generations to live runtimes. UI-only projection left settings
            // changes invisible until each session independently encountered a failure.
            eventRouter.emitUpdate({
                userId: change.accountId,
                payload,
                recipientFilter: { type: "user-machine-scoped-only" },
            });
            eventRouter.emitUpdate({
                userId: change.accountId,
                payload,
                recipientFilter: { type: "user-scoped-only" },
            });
        }
    });

    return changes.find((change) => change.accountId === params.accountId)!.cursor;
}
