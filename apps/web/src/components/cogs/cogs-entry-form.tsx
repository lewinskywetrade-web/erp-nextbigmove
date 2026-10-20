"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

function ErrorModal({ errors, onClose }: { errors: string[]; onClose: () => void }) {
  if (errors.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-100">
            <svg className="h-6 w-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-foreground">Validation Error</h3>
            <p className="mt-1 text-sm text-[#64748B]">Please fix the following issues:</p>
          </div>
        </div>
        <ul className="space-y-2 pl-2">
          {errors.map((error, index) => (
            <li key={index} className="flex items-start gap-2 text-sm text-[#DC2626]">
              <span className="mt-0.5 text-red-500">*</span>
              <span>{error}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end pt-2">
          <Button onClick={onClose} variant="primary">
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CogsEntryFormProps {
  onSubmit: (cogs: number) => void | Promise<void>;
  onCancel: () => void;
  initialCogs?: number;
  isEditing?: boolean;
  isSubmitting?: boolean;
  title?: string;
  amountLabel?: string;
  submitLabel?: string;
}

export function CogsEntryForm({
  onSubmit,
  onCancel,
  initialCogs,
  isEditing = false,
  isSubmitting = false,
  title,
  amountLabel,
  submitLabel,
}: CogsEntryFormProps) {
  const [cogs, setCogs] = useState<string>(initialCogs?.toString() || "");
  const [errors, setErrors] = useState<{ cogs?: string }>({});
  const [modalErrors, setModalErrors] = useState<string[]>([]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const newErrors: { cogs?: string } = {};
    const validationErrors: string[] = [];

    if (!cogs || cogs.trim() === "") {
      newErrors.cogs = "COGS amount is required";
      validationErrors.push("COGS amount is required");
    } else {
      const cogsValue = Number(cogs);

      if (!Number.isFinite(cogsValue)) {
        newErrors.cogs = "COGS must be a valid number";
        validationErrors.push("COGS must be a valid number");
      } else if (cogsValue <= 0) {
        newErrors.cogs = "ERP COGS must be greater than 0";
        validationErrors.push("ERP COGS must be greater than 0");
      } else if (cogsValue > 1000000000) {
        newErrors.cogs = "COGS value is too large (max: PHP 1,000,000,000)";
        validationErrors.push("COGS value is too large (maximum: PHP 1,000,000,000)");
      } else {
        const decimalPart = cogs.split(".")[1];
        if (decimalPart && decimalPart.length > 2) {
          newErrors.cogs = "COGS can only have up to 2 decimal places";
          validationErrors.push("COGS can only have up to 2 decimal places");
        }
      }
    }

    if (validationErrors.length > 0) {
      setErrors(newErrors);
      setModalErrors(validationErrors);
      return;
    }

    void onSubmit(Number(cogs));
  };

  return (
    <>
      <ErrorModal errors={modalErrors} onClose={() => setModalErrors([])} />
      <form onSubmit={handleSubmit} className="card space-y-4 dark:bg-background-secondary">
        <h4 className="mb-4 card-label">
          {title || (isEditing ? "Edit COGS" : "Add COGS")}
        </h4>

        <div>
          <label htmlFor="cogs" className="mb-1 block text-sm font-medium text-foreground">
            {amountLabel || "New COGS Amount"}
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[#64748B]">
              PHP
            </span>
            <input
              id="cogs"
              type="number"
              step="0.01"
              min="0.01"
              value={cogs}
              onChange={(e) => {
                setCogs(e.target.value);
                setErrors((prev) => ({ ...prev, cogs: undefined }));
              }}
              placeholder="0.00"
              disabled={isSubmitting}
              className={`input pl-12 pr-3 ${
                errors.cogs ? "border-red-500" : "border-[#E2E8F0] dark:border-border"
              } bg-surface focus:outline-none focus:ring-2 focus:ring-[#2563EB]`}
            />
          </div>
          {errors.cogs && <p className="mt-1 text-sm text-red-600">{errors.cogs}</p>}
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting}
            loading={isSubmitting}
            className="flex-1"
          >
            {submitLabel || (isEditing ? "Update COGS Entry" : "Save COGS Entry")}
          </Button>
        </div>
      </form>
    </>
  );
}
