# Shared connected-service pools

This fork can delegate one exact owner-managed connected-service pool to several Happier accounts without sharing the owner's Happier login or copying credential state.

## Scope

- The validated first deployment uses one `openai-codex` pool for all employees and the operator's personal account.
- The vault owner is a dedicated `plain` account.
- Employee accounts are separate `plain` accounts with separate machines, settings, and sessions.
- The operator's personal account may remain E2EE. Its session text stays E2EE while its daemon reads the delegated V3 credential.
- The grant affects only Connected Services. Sessions, machines, messages, account settings, prompts, KV data, and other account-owned resources keep their existing account boundary.
- No database schema or data migration is added.

## Ownership model

The vault account is the only persistence owner for:

- connected-service credential rows and credential revisions
- refresh leases and credential health
- pool membership, generation, runtime state, and active profile
- quota and provider-account usage records

Grantee daemons resolve those resources to the vault account only after the server has matched the authenticated grantee, service, configured group, and current group membership. The authenticated request identity is never replaced with the owner identity.

The vault credential uses the existing plain-account V3 path. With `HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST=server_sealed`, the database stores the credential sealed under the server master secret, but this is not E2EE because the server can decrypt it for an authorized grantee.

## Configuration contract

`HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON` is a JSON array with this shape:

```json
[
  {
    "ownerAccountId": "vault-account-id",
    "serviceId": "openai-codex",
    "groupId": "company-codex",
    "granteeAccountIds": [
      "employee-account-id",
      "operator-account-id"
    ]
  }
]
```

The parser trims identifiers and rejects:

- malformed JSON or unknown fields
- an empty grantee list
- the owner listed as a grantee
- duplicate grantee IDs in one grant
- duplicate definitions of the same owner, service, and group
- more than one delegated pool for the same grantee and service

An absent or blank variable disables delegation and preserves normal account-owned Connected Services behavior. A malformed configured value fails closed rather than retaining an older valid grant.

The configured owner group must exist. A delegated profile must still be a member of that group at request time.

## Provisioning

1. Run the server with `HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=optional` and keep `HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST=server_sealed`.
2. Create a dedicated plain vault account and a separate account for every employee.
3. On each authenticated installation, run `happier doctor --json` and record the reported `accountId` outside Git-tracked secret files.
4. Sign in as the vault owner, connect the Codex profile or profiles, create the pool, and add only the profiles intended for company use.
5. Set `HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON` in the server secret manager or deployment environment. Do not put live provider tokens in this JSON.
6. Restart the server.
7. Deploy the fork CLI to each grantee machine. The released CLI is not required to support delegated resources.
8. Run `happier connect status` as every grantee and verify that the configured pool is visible while owner-private profiles and pools are absent.

## Authorization matrix

| Operation | Vault owner | Grantee | Unrelated account |
| --- | --- | --- | --- |
| Discover configured pool and member profiles | Yes | Yes | No |
| Read the active credential, health, quota, and usage | Yes | Yes | No |
| Acquire refresh lease and commit fenced refresh | Yes | Yes | No |
| Update fenced pool runtime state or active profile | Yes | Yes | No |
| Connect, replace without a lease, or delete a credential | Yes | No | No |
| Edit pool policy, name, or membership | Yes | No | No |
| Read vault sessions, machines, messages, settings, prompts, or KV | Only through normal owner login | No | No |

Owner-only and out-of-scope requests use the existing not-found response shape so they do not disclose hidden owner resources.

## Runtime and concurrency

- Every daemon contends on the same owner credential refresh lease.
- Refresh commits require both the expected credential revision and the lease owner ID.
- Pool runtime mutations use the existing generation and runtime-state revision fences.
- Owner changes publish a filtered projection to every existing configured grantee.
- Provider usage writes must prove a link to an authorized source. If the link cannot be proven, the owner-side transaction rolls back.
- Grantee quota and usage writes remain owner-owned. The server does not create copied credential, group, quota, or usage rows under grantee accounts.

## Compatibility

- Candidate server with no grant configuration behaves like the unmodified server.
- Candidate fork CLI against an older server tries V3 and falls back to the existing sealed V2 path for private E2EE resources.
- Released clients continue to work for ordinary accounts and the vault owner.
- Delegated use by a grantee requires the fork CLI, especially when the grantee account is E2EE.

## Verification

Before relying on the pool, verify:

1. Two grantee accounts both discover the same active profile and credential revision.
2. A refresh lease acquired by one grantee is contended for the other.
3. A fenced refresh performed by one grantee becomes visible to the other.
4. An active-profile change becomes visible to every grantee.
5. An unrelated account and an owner-private profile return not found.
6. Database rows for credentials, groups, quota, provider usage, and source links belong only to the vault owner.
7. Employee sessions and machines remain owned by their individual employee accounts.
8. One real Codex turn succeeds on company hardware. Before production reliance, also observe one real credential refresh or reconnect lifecycle.

## Changing or removing grants

Update the JSON and restart the server. Removing a grant immediately removes future delegated discovery, reads, leases, refreshes, and runtime writes. It does not delete or migrate owner rows.

Existing processes may retain locally materialized provider credentials until their normal process or session lifecycle ends. Stop affected sessions and daemons first when access removal must take effect immediately.

To roll back the fork capability:

1. Stop grantee sessions and daemons that use the pool.
2. Remove `HAPPIER_SHARED_CONNECTED_SERVICE_POOLS_JSON` and restart the server.
3. Verify that grantee discovery no longer returns the pool and that the vault owner still sees its profiles and group.
4. Deploy the baseline server and CLI if desired. No database rollback or compatibility adapter is needed.

## Troubleshooting

- Empty discovery for every grantee: verify the owner account is plain, the group ID matches exactly, and the group exists under the configured owner and service.
- A profile is missing: verify it is a current member of the configured group.
- Connected-service requests fail after an environment edit: validate the JSON and check for duplicate grantee and service assignments.
- An E2EE grantee falls back to a private credential or cannot persist delegated quota: verify that machine runs the fork CLI and that its account ID is present in the grant.
- The pool is visible but a Codex spawn fails: use `happier connect status`, inspect credential health, and verify the selected profile kind is supported by Codex.
