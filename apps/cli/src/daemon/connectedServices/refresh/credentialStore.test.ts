import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import {
  persistRefreshedCredential,
  readCredentialForRefresh,
} from './credentialStore';

const credentials: Credentials = {
  token: 'happier-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
};

function createRecord(params: Readonly<{
  serviceId: 'openai-codex' | 'github';
  profileId: string;
  accessToken: string;
}>) {
  return buildConnectedServiceCredentialRecord({
    now: Date.now(),
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    oauth: {
      accessToken: params.accessToken,
      refreshToken: `${params.accessToken}-refresh`,
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: 'provider-account',
      providerEmail: 'company@example.com',
    },
  });
}

describe('credentialStore delegated v3 selection', () => {
  it('reads and persists an E2EE account delegated credential through v3', async () => {
    const record = createRecord({
      serviceId: 'openai-codex',
      profileId: 'company-primary',
      accessToken: 'delegated-access-a',
    });
    const updated = createRecord({
      serviceId: 'openai-codex',
      profileId: 'company-primary',
      accessToken: 'delegated-access-b',
    });
    const registerPlain = vi.fn(async () => ({
      success: true as const,
      credentialRevision: 'csr_zyxwvutsrqponmlkjihgfe',
    }));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceCredentialPlain: registerPlain,
      registerConnectedServiceCredentialSealed: vi.fn(),
    };

    const source = await readCredentialForRefresh({
      api: api as unknown as ApiClient,
      credentials,
      binding: { serviceId: 'openai-codex', profileId: 'company-primary' },
    });
    expect(source).toEqual({
      mode: 'plain',
      record,
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });
    if (!source || source.revisionSemantics !== 'revisioned') throw new Error('expected revisioned source');

    await expect(persistRefreshedCredential({
      api: api as unknown as ApiClient,
      credentials,
      binding: { serviceId: 'openai-codex', profileId: 'company-primary' },
      source,
      updated,
      refreshLeaseOwnerId: 'refresh-attempt',
    })).resolves.toEqual({
      success: true,
      credentialRevision: 'csr_zyxwvutsrqponmlkjihgfe',
    });

    expect(registerPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'company-primary',
      content: { t: 'plain', v: updated },
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
      refreshLeaseOwnerId: 'refresh-attempt',
    });
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('falls back to a private sealed credential for an E2EE account when v3 is absent', async () => {
    const record = createRecord({
      serviceId: 'github',
      profileId: 'private',
      accessToken: 'private-access',
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.type === 'legacy'
        ? credentials.encryption.secret
        : new Uint8Array() },
      payload: record,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: { kind: 'oauth' as const },
      })),
    };

    await expect(readCredentialForRefresh({
      api: api as unknown as ApiClient,
      credentials,
      binding: { serviceId: 'github', profileId: 'private' },
    })).resolves.toEqual({
      mode: 'sealed',
      record,
      metadata: { kind: 'oauth' },
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });

    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'github',
      profileId: 'private',
    });
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'github',
      profileId: 'private',
    });
  });
});
