'use client';

import { AlertCircle, BrainCircuit, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertBanner, LoadingCard } from '@/components/ui/feedback';
import type { CreativeAiProvider } from '@/app/(dashboard)/creative-agent/video-registry/_types/creative-ai';
import { AiDefaultsPanel } from './_components/ai-defaults-panel';
import { AiDocumentsPanel } from './_components/ai-documents-panel';
import { AiTargetDefaultsPanel } from './_components/ai-target-defaults-panel';
import { AiPromptsPanel } from './_components/ai-prompts-panel';
import { AiProviderCard } from './_components/ai-provider-card';
import { AiSignInDialog } from './_components/ai-sign-in-dialog';
import { useAiSettingsController } from './_hooks/use-ai-settings-controller';

export default function AiSettingsPage() {
  const controller = useAiSettingsController();

  if (controller.loading) return <LoadingCard label="Checking AI providers…" />;

  if (!controller.config) {
    return (
      <div className="space-y-4">
        <AlertBanner tone="error" message={controller.error || 'Unable to load AI settings.'} />
        <Button type="button" variant="outline" iconLeft={<RefreshCw className="h-4 w-4" />} onClick={() => void controller.reload()}>Try again</Button>
      </div>
    );
  }

  const disconnect = (provider: CreativeAiProvider) => {
    const label = provider === 'CLAUDE' ? 'Claude' : 'Codex';
    if (window.confirm(`Disconnect ${label}? New analyses using ${label} will be unavailable until it is connected again.`)) {
      void controller.logout(provider);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-primary"><BrainCircuit className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-wide">AI workspace</span></div>
          <h1 className="mt-2 text-2xl font-semibold text-foreground">AI providers</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">Connect this tenant’s AI accounts for creative analysis, then choose familiar workspace defaults.</p>
        </div>
        <Button type="button" size="sm" variant="outline" iconLeft={<RefreshCw className="h-4 w-4" />} onClick={() => void controller.reload()}>Refresh status</Button>
      </header>

      {controller.error ? <AlertBanner tone="error" message={controller.error} /> : null}

      {!controller.config.permissions.canManageConnections ? (
        <div className="flex gap-3 rounded-xl border border-info/30 bg-info-soft/30 p-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-info" />
          <div><p className="text-sm font-semibold text-foreground">Connection managed by client admin</p><p className="mt-1 text-sm text-muted">You can view this client’s connection status and allowed defaults. Ask the client administrator to connect or disconnect an account.</p></div>
        </div>
      ) : null}

      <section>
        <div className="mb-3"><h2 className="text-base font-semibold text-foreground">Client connections</h2><p className="mt-1 text-sm text-muted">Each provider is isolated to the active client and shows whether it is ready before users begin an analysis.</p></div>
        <div className="grid gap-4 lg:grid-cols-2">
          {controller.config.providers.map((status) => (
            <AiProviderCard
              key={status.provider}
              status={status}
              canManageConnections={controller.config?.permissions.canManageConnections ?? false}
              busy={controller.busyProvider === status.provider}
              onConnect={(provider) => void controller.startLogin(provider)}
              onTest={(provider) => void controller.test(provider)}
              onDisconnect={disconnect}
            />
          ))}
        </div>
        {!controller.config.providers.length ? (
          <div className="mt-4 flex gap-2 rounded-xl border border-warning/30 bg-warning-soft/30 p-4 text-sm text-warning"><AlertCircle className="h-4 w-4 shrink-0" />No AI providers were reported by the gateway.</div>
        ) : null}
      </section>

      <AiPromptsPanel
        prompts={controller.config.prompt}
        canEdit={controller.config.permissions.canEditPrompts}
        savingKind={controller.savingPromptKind}
        onSave={(kind, body, note) => void controller.savePrompt(kind, body, note)}
        onReset={(kind) => void controller.resetPrompt(kind)}
        onActivated={(setting) => controller.applyPrompt(setting)}
      />

      <AiTargetDefaultsPanel />

      <AiDocumentsPanel />

      {controller.config.permissions.canConfigure ? (
        <AiDefaultsPanel
          config={controller.config}
          draft={controller.draft}
          saving={controller.saving}
          onDraftChange={controller.setDraft}
          onProviderChange={controller.setDefaultProvider}
          onModelChange={controller.setModel}
          onEffortChange={controller.setEffort}
          onSave={() => void controller.save()}
        />
      ) : null}

      <AiSignInDialog
        provider={controller.loginProvider}
        login={controller.login}
        submittingCode={controller.submittingCode}
        onSubmitCode={(code) => void controller.submitLoginCode(code)}
        onClose={controller.closeLogin}
      />
    </div>
  );
}
