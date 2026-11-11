'use client';

import { useEffect, useMemo, useState } from 'react';
import { Link2, Trash2 } from 'lucide-react';
import { WmsModal } from '../../_components/wms-modal';
import { WmsSearchableSelect } from '../../_components/wms-searchable-select';
import type {
  UpdateWmsProductProfileInput,
  WmsProductPoolCandidateOption,
  WmsProductProfileRecord,
  WmsProductsOverviewResponse,
  WmsProductProfileStatus,
} from '../_types/product';

type ProductProfileModalProps = {
  open: boolean;
  profile: WmsProductProfileRecord | null;
  locationOptions: WmsProductsOverviewResponse['locationOptions'];
  poolCandidateOptions?: WmsProductPoolCandidateOption[];
  canEditProfile: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (input: UpdateWmsProductProfileInput) => Promise<void>;
};

type ProductProfileModalFormState = {
  status: WmsProductProfileStatus;
  isSerialized: boolean;
  requiresExpirationDate: boolean;
  preferredLocationId: string | null;
  isFragile: boolean;
  isStackable: boolean;
  keepDry: boolean;
  inhouseUnitCost: string;
  supplierUnitCost: string;
  notes: string;
  linkedProfileIds: string[];
};

type LocationOption = {
  id: string;
  label: string;
  kind: 'SECTION' | 'RACK' | 'BIN';
};

const statusOptions: Array<{ value: WmsProductProfileStatus; label: string }> = [
  { value: 'DEFAULT', label: 'Default' },
  { value: 'READY', label: 'Ready' },
  { value: 'ARCHIVED', label: 'Archived' },
];

function toInputCost(value: string | null | undefined) {
  return value ?? '';
}

function toOptionalNumber(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function normalizeMatchToken(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

export function ProductProfileModal({
  open,
  profile,
  locationOptions,
  poolCandidateOptions = [],
  canEditProfile,
  isSaving,
  onClose,
  onSubmit,
}: ProductProfileModalProps) {
  const sectionLocationOptions = locationOptions.filter((option) => option.kind === 'SECTION') as LocationOption[];

  const [formState, setFormState] = useState<ProductProfileModalFormState>({
    status: profile?.status ?? 'DEFAULT',
    isSerialized: profile?.isSerialized ?? true,
    requiresExpirationDate: profile?.requiresExpirationDate ?? false,
    preferredLocationId: profile?.preferredLocation?.id ?? null,
    isFragile: profile?.handling.isFragile ?? false,
    isStackable: profile?.handling.isStackable ?? true,
    keepDry: profile?.handling.keepDry ?? false,
    inhouseUnitCost: toInputCost(profile?.inhouseUnitCost),
    supplierUnitCost: toInputCost(profile?.supplierUnitCost),
    notes: profile?.notes ?? '',
    linkedProfileIds: (profile?.linkedProfiles ?? []).map((peer) => peer.profileId),
  });

  useEffect(() => {
    setFormState({
      status: profile?.status ?? 'DEFAULT',
      isSerialized: profile?.isSerialized ?? true,
      requiresExpirationDate: profile?.requiresExpirationDate ?? false,
      preferredLocationId: profile?.preferredLocation?.id ?? null,
      isFragile: profile?.handling.isFragile ?? false,
      isStackable: profile?.handling.isStackable ?? true,
      keepDry: profile?.handling.keepDry ?? false,
      inhouseUnitCost: toInputCost(profile?.inhouseUnitCost),
      supplierUnitCost: toInputCost(profile?.supplierUnitCost),
      notes: profile?.notes ?? '',
      linkedProfileIds: (profile?.linkedProfiles ?? []).map((peer) => peer.profileId),
    });
  }, [profile]);

  const candidateById = useMemo(() => {
    const map = new Map<string, WmsProductPoolCandidateOption>();
    for (const candidate of poolCandidateOptions) {
      map.set(candidate.profileId, candidate);
    }
    for (const peer of profile?.linkedProfiles ?? []) {
      if (!map.has(peer.profileId)) {
        map.set(peer.profileId, {
          ...peer,
          stockPoolGroupId: profile?.stockPoolGroupId ?? null,
        });
      }
    }
    return map;
  }, [poolCandidateOptions, profile?.linkedProfiles, profile?.stockPoolGroupId]);

  const selectedLinkedCandidates = useMemo(
    () =>
      formState.linkedProfileIds
        .map((id) => candidateById.get(id))
        .filter((item): item is WmsProductPoolCandidateOption => Boolean(item)),
    [candidateById, formState.linkedProfileIds],
  );

  const availablePoolSelectOptions = useMemo(() => {
    if (!profile?.profileId) {
      return [];
    }
    const selectedSet = new Set<string>([profile.profileId, ...formState.linkedProfileIds]);
    const selfCustomId = normalizeMatchToken(profile.productCustomId);
    const selfDisplayId = normalizeMatchToken(profile.variationDisplayId);
    const selfName = normalizeMatchToken(profile.name);

    return poolCandidateOptions
      .filter((candidate) => !selectedSet.has(candidate.profileId))
      .map((candidate) => {
        const candCustomId = normalizeMatchToken(candidate.productCustomId);
        const candDisplayId = normalizeMatchToken(candidate.variationDisplayId);
        const candName = normalizeMatchToken(candidate.name);
        const isSuggested = Boolean(
          (selfCustomId && candCustomId === selfCustomId)
          || (selfDisplayId && candDisplayId === selfDisplayId)
          || (selfName && candName === selfName),
        );
        const identity = candidate.variationDisplayId ?? candidate.productCustomId ?? candidate.variationId;
        return {
          candidate,
          isSuggested,
          option: {
            value: candidate.profileId,
            label: `${candidate.storeName} · ${candidate.name} · ${identity}`,
            hint: isSuggested
              ? `Suggested · ${candidate.directBinUnits} in bins`
              : `${candidate.directBinUnits} in bins`,
          },
        };
      })
      .sort((left, right) => {
        if (left.isSuggested !== right.isSuggested) {
          return left.isSuggested ? -1 : 1;
        }
        if (right.candidate.directBinUnits !== left.candidate.directBinUnits) {
          return right.candidate.directBinUnits - left.candidate.directBinUnits;
        }
        return left.option.label.localeCompare(right.option.label);
      })
      .map((entry) => entry.option);
  }, [formState.linkedProfileIds, poolCandidateOptions, profile]);

  const pooledBinPreviewTotal = useMemo(() => {
    const ownDirect = profile?.directBinUnits ?? 0;
    const peersDirect = selectedLinkedCandidates.reduce((sum, peer) => sum + peer.directBinUnits, 0);
    return ownDirect + peersDirect;
  }, [profile?.directBinUnits, selectedLinkedCandidates]);

  if (!open || !profile) {
    return null;
  }

  const inputsDisabled = isSaving || !canEditProfile;

  const handleAddLinkedProfile = (profileIdToAdd: string) => {
    if (!profileIdToAdd) {
      return;
    }
    const picked = candidateById.get(profileIdToAdd);
    const groupPeerIds =
      picked?.stockPoolGroupId
        ? poolCandidateOptions
            .filter(
              (candidate) =>
                candidate.stockPoolGroupId === picked.stockPoolGroupId
                && candidate.profileId !== profile.profileId,
            )
            .map((candidate) => candidate.profileId)
        : [profileIdToAdd];
    setFormState((current) => ({
      ...current,
      linkedProfileIds: Array.from(
        new Set([...current.linkedProfileIds, profileIdToAdd, ...groupPeerIds]),
      ),
    }));
  };

  const handleRemoveLinkedProfile = (profileIdToRemove: string) => {
    setFormState((current) => ({
      ...current,
      linkedProfileIds: current.linkedProfileIds.filter((id) => id !== profileIdToRemove),
    }));
  };

  const footer = (
    <div className="flex items-center justify-end gap-3">
      <button
        type="button"
        onClick={onClose}
        className="btn btn-md btn-outline"
      >
        Cancel
      </button>
      <button
        type="button"
        disabled={inputsDisabled}
        onClick={async () => {
          await onSubmit({
            ...formState,
            inhouseUnitCost: toOptionalNumber(formState.inhouseUnitCost),
            supplierUnitCost: toOptionalNumber(formState.supplierUnitCost),
            notes: formState.notes?.trim() ? formState.notes.trim() : null,
            linkedProfileIds: formState.linkedProfileIds,
          });
        }}
        className="btn btn-md btn-primary"
      >
        {!canEditProfile ? 'Edit permission required' : isSaving ? 'Saving' : 'Save profile'}
      </button>
    </div>
  );

  return (
    <WmsModal
      open={open}
      title={profile.name}
      description={`${profile.store.name} · ${profile.variationDisplayId ?? 'No variation ID'}`}
      onClose={onClose}
      footer={footer}
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(260px,0.9fr)]">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2">
              <span className="form-label">Status</span>
              <select
                value={formState.status}
                disabled={inputsDisabled}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    status: event.target.value as WmsProductProfileStatus,
                  }))
                }
                className="input"
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
              <span className="form-label">Serialized</span>
              <select
                value={formState.isSerialized ? 'true' : 'false'}
                disabled={inputsDisabled}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    isSerialized: event.target.value === 'true',
                  }))
                }
                className="input"
              >
                <option value="true">Serialized</option>
                <option value="false">Non-serialized</option>
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2">
              <span className="form-label">Inhouse COGS</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={formState.inhouseUnitCost}
                disabled={inputsDisabled}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    inhouseUnitCost: event.target.value,
                  }))
                }
                className="input"
                placeholder="0.00"
              />
            </label>

            <label className="space-y-2">
              <span className="form-label">Supplier COGS</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={formState.supplierUnitCost}
                disabled={inputsDisabled}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    supplierUnitCost: event.target.value,
                  }))
                }
                className="input"
                placeholder="0.00"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-1">
            <label className="space-y-2">
              <span className="form-label">Section Assignment</span>
              <select
                value={formState.preferredLocationId ?? ''}
                disabled={inputsDisabled}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    preferredLocationId: event.target.value || null,
                  }))
                }
                className="input"
              >
                <option value="">Not assigned</option>
                {sectionLocationOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-2">
            <span className="form-label">Handling</span>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ['isFragile', 'Fragile'],
                ['isStackable', 'Stackable'],
                ['keepDry', 'Keep dry'],
              ].map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center gap-3 rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] px-4 py-3 text-sm font-medium text-primary"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(formState[key as keyof ProductProfileModalFormState])}
                    disabled={inputsDisabled}
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        [key]: event.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-[#c5d5df] text-primary"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] px-4 py-3">
            <input
              type="checkbox"
              checked={formState.requiresExpirationDate}
              disabled={inputsDisabled}
              onChange={(event) =>
                setFormState((current) => ({
                  ...current,
                  requiresExpirationDate: event.target.checked,
                }))
              }
              className="mt-0.5 h-4 w-4 rounded border-[#c5d5df] text-primary"
            />
            <span>
              <span className="block text-sm font-semibold text-primary">Expiration date required</span>
              <span className="mt-1 block text-xs leading-5 text-[#6f8290]">
                Receiving staff must set an expiration date before units of this product can be put away.
              </span>
            </span>
          </label>

          <div className="rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-[#235c42]" />
                <span className="text-sm font-semibold text-primary">
                  Shared Stock Pool (Linked Variants)
                </span>
              </div>
              <span className="inline-flex items-center rounded-full border border-[#b9decb] bg-[#ecf8f2] px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-[#235c42]">
                {pooledBinPreviewTotal.toLocaleString()} pooled in bins ({(profile.directBinUnits ?? 0).toLocaleString()} direct)
              </span>
            </div>

            <p className="text-xs leading-5 text-[#6f8290]">
              Link sister-store or legacy variations that share the same physical bin stock. Orders on any linked variant become Ready immediately and auto-assign scanned units on pick.
            </p>

            {selectedLinkedCandidates.length > 0 ? (
              <div className="space-y-2">
                {selectedLinkedCandidates.map((peer) => (
                  <div
                    key={peer.profileId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[#e3ebef] bg-white px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-semibold text-primary">
                        {peer.storeName} · {peer.name}
                      </p>
                      <p className="truncate text-[11px] text-[#6d8291]">
                        {peer.variationDisplayId ?? peer.productCustomId ?? peer.variationId} · {peer.directBinUnits.toLocaleString()} in bins
                      </p>
                    </div>
                    {!inputsDisabled ? (
                      <button
                        type="button"
                        onClick={() => handleRemoveLinkedProfile(peer.profileId)}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[#e5edf2] text-[#7a8f9e] transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                        title="Unlink from shared stock pool"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[#d7e0e7] bg-white px-3 py-2.5 text-xs text-[#758997]">
                Not linked to any shared stock pool yet.
              </div>
            )}

            {!inputsDisabled && availablePoolSelectOptions.length > 0 ? (
              <WmsSearchableSelect
                label="Add variant"
                value=""
                onChange={handleAddLinkedProfile}
                options={availablePoolSelectOptions}
                allLabel="Select sister-store or legacy variant to link..."
                placeholder="Search store, product name, or variation ID..."
                clearable={false}
                triggerClassName="h-10 w-full bg-white"
                popoverMinWidth={420}
              />
            ) : null}
          </div>

          <label className="space-y-2">
            <span className="form-label">Notes</span>
            <textarea
              value={formState.notes ?? ''}
              disabled={inputsDisabled}
              onChange={(event) =>
                setFormState((current) => ({
                  ...current,
                  notes: event.target.value,
                }))
              }
              rows={5}
              className="input"
              placeholder="Storage rule notes, handling exceptions, or receiving guidance"
            />
          </label>
        </div>

        <div className="space-y-4">
          <div className="card">
            <p className="card-label">Source</p>
            <div className="mt-3 space-y-3 text-sm text-[#4f6777]">
              <div>
                <p className="font-semibold text-primary">Variation ID</p>
                <p>{profile.variationDisplayId ?? '—'}</p>
              </div>
              <div>
                <p className="font-semibold text-primary">Product ID</p>
                <p>{profile.productCustomId ?? '—'}</p>
              </div>
              <div>
                <p className="font-semibold text-primary">POS warehouse</p>
                <p>{profile.posWarehouse?.name ?? 'Store-level only'}</p>
              </div>
              <div>
                <p className="font-semibold text-primary">Inhouse COGS</p>
                <p>{profile.inhouseUnitCost ?? 'Not set'}</p>
              </div>
              <div>
                <p className="font-semibold text-primary">Supplier COGS</p>
                <p>{profile.supplierUnitCost ?? 'Not set'}</p>
              </div>
            </div>
          </div>

          <div className="card">
            <p className="card-label">Current rules</p>
            <div className="mt-3 space-y-3 text-sm text-[#4f6777]">
              <div>
                <p className="font-semibold text-primary">Section assignment</p>
                <p>{profile.preferredLocation?.label ?? 'Not assigned'}</p>
              </div>
              <div>
                <p className="font-semibold text-primary">Expiration</p>
                <p>{profile.requiresExpirationDate ? 'Required before put-away' : 'Optional'}</p>
              </div>
              <div>
                <p className="font-semibold text-primary">Updated</p>
                <p>{new Date(profile.updatedAt).toLocaleString()}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </WmsModal>
  );
}
