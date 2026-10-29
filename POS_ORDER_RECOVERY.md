# Pancake order sync recovery

Failed order imports and outbound status projections are recovered from a fresh, read-only Pancake order request. The original webhook receipt remains intact; each recovery attempt produces a separate `PANCAKE_POS_RECOVERY` webhook log. No POS login is needed while the configured store API credentials remain valid.

The API scheduler runs every minute. It discovers eligible failures at least five minutes old from the last 30 days, up to 20 receipts per pass. Recovery work runs on the worker, one job at a time, with a global limit of 10 attempts per minute. A busy backlog can increase latency. Temporary failures retry with exponential backoff and jitter, capped at 30 minutes. Missing credentials, disabled connections, ownership ambiguity and invalid source responses are marked `BLOCKED` and checked again hourly.

Recovery is durable in `pos_order_sync_recoveries`. Persisted queue IDs deduplicate uncertain enqueue results; expired worker leases reopen unfinished attempts. A newer failed receipt reopens an already completed scope. Full precision source timestamps and deletion tombstones in `pos_order_source_versions` prevent older queued snapshots from overwriting newer orders or recreating deleted ones. Equal versions can retry incomplete projections.

Recovery uses the existing order and warehouse business rules. A returned POS status updates the outbound status projection; physical return receiving, disposition and stock availability still require the warehouse workflow. Recovery does not replay webhook relays or automatic customer cancellation.

## Operations

- Inspect `PANCAKE_POS_RECOVERY` webhook logs and recovery state/error-code counts. Original failures remain available for diagnosis. `SUCCEEDED` means the current snapshot was applied, superseded by a newer local source version, or excluded by an existing business rule.
- For `BLOCKED`, correct the scoped store credentials, connection setting, ownership mapping or source data indicated by the error code. The next hourly check retries without manually replaying an old payload.
- `POS_ORDER_RECOVERY_ENABLED=false` in the production environment, followed by recreating API and worker containers, pauses discovery and new worker claims. An attempt already running can finish. Default is `true`.
- This handles recorded import/projection failures. It does not detect a webhook that never reached the API, or automatically repair failures older than the 30-day discovery window.

## Deployment and rollback

The migration only adds recovery and version-ledger tables. Apply it before starting the new API and worker. The deployment workflow checks API health, matching API/worker images, process roles and both tables.

Before building, the workflow retains the running images under `erp-api:rollback-api-<deployment SHA prefix>` and `erp-api:rollback-worker-<deployment SHA prefix>`. If rollback is needed, restore the prior application revision/images and recreate both services using the existing production configuration. Keep the additive tables; do not drop recovery history or source versions. An old application will not enforce the new source-version guard until the corrected release is restored.
