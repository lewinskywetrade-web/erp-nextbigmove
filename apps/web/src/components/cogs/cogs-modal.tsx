"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ConfirmActionDialog } from "@/app/(dashboard)/settings/_components/confirm-action-dialog";
import { CogsEntryForm } from "./cogs-entry-form";
import apiClient from "@/lib/api-client";
import { Pencil, Trash2 } from "lucide-react";
import { parseIntegrationErrorMessage } from "@/app/(dashboard)/integrations/_utils/integration-error";

interface Product {
  id: string;
  productId?: string;
  name: string;
}

interface CogsEntry {
  id: string;
  cogs: string;
  createdAt: string;
  updatedAt: string;
}

interface CogsModalProps {
  product: Product;
  storeId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function CogsModal(props: CogsModalProps) {
  return <CogsModalContent key={`${props.storeId}:${props.product.id}:${props.isOpen}`} {...props} />;
}

function CogsModalContent({ product, storeId, isOpen, onClose }: CogsModalProps) {
  const { addToast } = useToast();
  const [currentCogs, setCurrentCogs] = useState<CogsEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<CogsEntry | null>(null);
  const [entryToDelete, setEntryToDelete] = useState<CogsEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const mutationPending = useRef(false);
  const mounted = useRef(false);
  const loadSequence = useRef(0);
  const isMutating = isSaving || isDeleting;

  const fetchCogsData = useCallback(async () => {
    if (!mounted.current) return;
    const sequence = ++loadSequence.current;
    setLoadStatus("loading");
    setLoadError("");
    try {
      const token = localStorage.getItem("access_token");
      if (!token) {
        throw new Error("Unauthorized");
      }

      const currentRes = await apiClient.get(
        `/integrations/pos-stores/${storeId}/products/${product.id}/cogs/current`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!mounted.current || sequence !== loadSequence.current) return;
      setCurrentCogs(currentRes.data || null);
      setLoadStatus("ready");
    } catch (error) {
      if (!mounted.current || sequence !== loadSequence.current) return;
      setLoadError(parseIntegrationErrorMessage(error));
      setLoadStatus("error");
    }
  }, [product.id, storeId]);

  useEffect(() => {
    mounted.current = true;
    if (isOpen) {
      void fetchCogsData();
    }
    return () => {
      mounted.current = false;
      loadSequence.current += 1;
    };
  }, [isOpen, fetchCogsData]);

  const handleSaveCogs = async (cogs: number) => {
    if (mutationPending.current || loadStatus !== "ready") return;
    mutationPending.current = true;
    setIsSaving(true);
    try {
      const token = localStorage.getItem("access_token");
      if (!token) {
        addToast("error", "Unauthorized");
        return;
      }

      const url = `/integrations/pos-stores/${storeId}/products/${product.id}/cogs`;
      const config = { headers: { Authorization: `Bearer ${token}` } };
      await apiClient.post(url, { cogs }, config);

      if (!mounted.current) return;
      setShowForm(false);
      setEditingEntry(null);
      addToast("success", "COGS saved.");
      // A failed refresh has its own retry state; the write already succeeded.
      await fetchCogsData();
    } catch (error) {
      if (mounted.current) addToast("error", parseIntegrationErrorMessage(error));
    } finally {
      mutationPending.current = false;
      if (mounted.current) setIsSaving(false);
    }
  };

  const handleDeleteCogs = async (cogsId: string) => {
    if (mutationPending.current || loadStatus !== "ready") return;
    mutationPending.current = true;
    setIsDeleting(true);
    try {
      const token = localStorage.getItem("access_token");
      if (!token) {
        addToast("error", "Unauthorized");
        return;
      }

      await apiClient.delete(
        `/integrations/pos-stores/${storeId}/products/${product.id}/cogs/${cogsId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!mounted.current) return;
      setShowForm(false);
      setEditingEntry(null);
      setEntryToDelete(null);
      addToast("success", "COGS deleted.");
      await fetchCogsData();
    } catch (error) {
      if (mounted.current) addToast("error", parseIntegrationErrorMessage(error));
    } finally {
      mutationPending.current = false;
      if (mounted.current) setIsDeleting(false);
    }
  };

  const handleEdit = (entry: CogsEntry) => {
    setEditingEntry(entry);
    setShowForm(true);
  };

  const handleCancelForm = () => {
    if (mutationPending.current) return;
    setShowForm(false);
    setEditingEntry(null);
  };

  const handleClose = () => {
    if (!mutationPending.current) onClose();
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader className="mb-3 gap-1.5">
            <DialogTitle>Manage COGS - {product.name}</DialogTitle>
            <DialogDescription>
              Store: {storeId}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {loadStatus === "loading" && <p role="status" className="text-sm text-muted">Loading COGS…</p>}
            {loadStatus === "error" && (
              <div role="alert" className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <p>Could not load current COGS. {loadError}</p>
                <Button variant="outline" size="sm" onClick={() => void fetchCogsData()}>Retry</Button>
              </div>
            )}
            {loadStatus === "ready" && !showForm && !currentCogs && (
              <button
                onClick={() => setShowForm(true)}
                className="w-full rounded-lg border-2 border-dashed border-[#CBD5E1] p-4 text-[#64748B] transition hover:border-[#2563EB] hover:text-[#2563EB]"
              >
                Add COGS
              </button>
            )}

            {loadStatus === "ready" && !showForm && currentCogs && (
              <div className="card border border-blue-200 bg-blue-50/30 dark:bg-background-secondary">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="card-label mb-2">Current COGS</p>
                    <span className="text-2xl font-bold text-foreground">
                      PHP {parseFloat(currentCogs.cogs).toFixed(2)}
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEdit(currentCogs)}
                      disabled={isMutating}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#64748B] transition hover:bg-[#F8FAFC] hover:text-[#2563EB] focus:outline-none focus:ring-2 focus:ring-[#2563EB] dark:text-slate-300"
                      title="Set current COGS"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setEntryToDelete(currentCogs)}
                      disabled={isMutating}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#64748B] transition hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 dark:text-slate-300"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {loadStatus === "ready" && showForm && (
              <div className="space-y-3">
                <p className="text-sm text-muted">New costs apply from today. Earlier cost periods are preserved.</p>
                <CogsEntryForm
                  onSubmit={handleSaveCogs}
                  onCancel={handleCancelForm}
                  initialCogs={editingEntry ? parseFloat(editingEntry.cogs) : undefined}
                  title="Set current COGS"
                  submitLabel="Save current COGS"
                  isSubmitting={isSaving}
                />
              </div>
            )}

            <div className="flex justify-end border-t border-border pt-4">
              <Button variant="outline" onClick={handleClose} disabled={isMutating}>
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={Boolean(entryToDelete)}
        onOpenChange={(open) => {
          if (!open && !mutationPending.current) {
            setEntryToDelete(null);
          }
        }}
        title="Delete COGS"
        description="Are you sure you want to delete this COGS entry? This action cannot be undone."
        confirmLabel="Delete COGS"
        cancelLabel="Cancel"
        isConfirming={isDeleting}
        onConfirm={() => {
          if (!entryToDelete) return;
          void handleDeleteCogs(entryToDelete.id);
        }}
      />
    </>
  );
}
