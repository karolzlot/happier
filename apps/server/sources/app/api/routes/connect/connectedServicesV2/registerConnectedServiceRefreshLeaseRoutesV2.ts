import { z } from "zod";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { ConnectedServiceIdSchema, type ConnectedServiceId } from "@happier-dev/protocol";

import { ConnectedServiceProfileIdSchema } from "./profileIdSchema";
import { NotFoundSchema } from "../../../schemas/notFoundSchema";
import { resolveConnectedServiceCredentialRevision } from "../credentials/credentialRevision";
import { resolveConnectedServiceProfileResourceScope } from "../sharedPools/sharedConnectedServicePoolAccess";

function registerConnectedServiceRefreshLeaseRoute(
  app: Fastify,
  params: Readonly<{ refreshLeaseMaxMs: number; routePrefix: "/v2" | "/v3" }>,
): void {
  const refreshLeaseMaxMs = params.refreshLeaseMaxMs;

  app.post(`${params.routePrefix}/connect/:serviceId/profiles/:profileId/refresh-lease`, {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema,
      }),
      body: z.object({
        machineId: z.string().min(1),
        ownerId: z.string().min(1).optional(),
        leaseMs: z.number().int().min(1),
        expectedCredentialRevision: z.string().trim().min(1).max(128).optional(),
      }),
      response: {
        200: z.object({
          acquired: z.boolean(),
          leaseUntil: z.number().int().nonnegative(),
          ownerId: z.string(),
          credentialRevision: z.string(),
        }),
        404: z.union([NotFoundSchema, z.object({ error: z.literal("connect_credential_not_found") })]),
      },
    },
  }, async (request, reply) => {
    const requesterAccountId = request.userId;
    const serviceId = request.params.serviceId satisfies ConnectedServiceId;
    const profileId = request.params.profileId;
    const { machineId } = request.body;
    const ownerId = request.body.ownerId?.trim() || machineId;
    const leaseMs = Math.min(request.body.leaseMs, refreshLeaseMaxMs);

    const now = Date.now();
    const nowDate = new Date(now);
    const nextExpiry = new Date(now + leaseMs);

    const result = await inTx(async (tx) => {
      const scope = await resolveConnectedServiceProfileResourceScope({
        client: tx,
        requesterAccountId,
        serviceId,
        profileId,
      });
      if (!scope) return null;
      const row = await tx.serviceAccountToken.findUnique({
        where: {
          accountId_vendor_profileId: {
            accountId: scope.resourceAccountId,
            vendor: serviceId,
            profileId,
          },
        },
        select: { id: true, metadata: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
      });
      if (!row) return null;
      const credentialRevision = resolveConnectedServiceCredentialRevision({ rowId: row.id, metadata: row.metadata });
      if (
        request.body.expectedCredentialRevision !== undefined
        && request.body.expectedCredentialRevision !== credentialRevision
      ) {
        return {
          acquired: false,
          leaseUntil: row.refreshLeaseExpiresAt?.getTime() ?? now,
          credentialRevision,
        };
      }
      const canAcquire = row.refreshLeaseExpiresAt === null
        || row.refreshLeaseExpiresAt.getTime() <= nowDate.getTime()
        || row.refreshLeaseOwnerMachineId === ownerId;
      if (!canAcquire) {
        return {
          acquired: false,
          leaseUntil: row.refreshLeaseExpiresAt?.getTime() ?? now,
          credentialRevision,
        };
      }
      await tx.serviceAccountToken.update({
        where: { id: row.id },
        data: { refreshLeaseOwnerMachineId: ownerId, refreshLeaseExpiresAt: nextExpiry },
      });
      return { acquired: true, leaseUntil: nextExpiry.getTime(), credentialRevision };
    });
    if (!result) return reply.code(404).send({ error: "connect_credential_not_found" });
    return reply.send({
      acquired: result.acquired,
      leaseUntil: result.leaseUntil,
      ownerId,
      credentialRevision: result.credentialRevision,
    });
  });
}

export function registerConnectedServiceRefreshLeaseRoutesV2(
  app: Fastify,
  params: Readonly<{ refreshLeaseMaxMs: number }>,
): void {
  registerConnectedServiceRefreshLeaseRoute(app, { ...params, routePrefix: "/v2" });
}

export function registerConnectedServiceRefreshLeaseRoutesV3(
  app: Fastify,
  params: Readonly<{ refreshLeaseMaxMs: number }>,
): void {
  registerConnectedServiceRefreshLeaseRoute(app, { ...params, routePrefix: "/v3" });
}
