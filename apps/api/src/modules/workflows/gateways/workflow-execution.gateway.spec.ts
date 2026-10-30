import { describe, expect, it, jest } from '@jest/globals';
import { WorkflowExecutionGateway, WORKFLOW_EVENT_RELAY_CHANNEL } from './workflow-execution.gateway';

describe('WorkflowExecutionGateway cross-process event relay', () => {
  function gateway(withServer: boolean) {
    const g = new WorkflowExecutionGateway() as any;
    const emits: Array<{ room: string; event: string; payload: any }> = [];
    if (withServer) {
      g.server = { to: (room: string) => ({ emit: (event: string, payload: any) => emits.push({ room, event, payload }) }) };
    }
    const published: Array<{ channel: string; message: string }> = [];
    g.publisher = { publish: jest.fn(async (channel: string, message: string) => { published.push({ channel, message }); return 1; }) };
    return { g, emits, published };
  }

  it('publishes worker events (no socket server) so the API process can deliver them', () => {
    const worker = gateway(false);
    const api = gateway(true);
    worker.g.emitTenantEvent('tenant-1', null, 'marketing:updated', { tenantId: 'tenant-1', source: 'pancake_webhook_reconcile' });
    expect(worker.published).toHaveLength(1);
    expect(worker.published[0].channel).toBe(WORKFLOW_EVENT_RELAY_CHANNEL);
    api.g.handleRelayMessage(worker.published[0].message);
    expect(api.emits).toEqual([{ room: 'tenant:tenant-1', event: 'marketing:updated',
      payload: { tenantId: 'tenant-1', source: 'pancake_webhook_reconcile' } }]);
  });

  it('emits locally once and ignores its own relayed copy', () => {
    const api = gateway(true);
    api.g.emitTenantEvent('tenant-1', 'team-1', 'marketing:updated', { tenantId: 'tenant-1' });
    expect(api.emits.map(e => e.room)).toEqual(['tenant:tenant-1', 'tenant:tenant-1:team:team-1']);
    api.g.handleRelayMessage(api.published[0].message);
    expect(api.emits).toHaveLength(2);
  });

  it('ignores malformed relay messages and works without Redis', () => {
    const api = gateway(true);
    api.g.handleRelayMessage('not json');
    api.g.handleRelayMessage(JSON.stringify({ origin: 'other', rooms: 'x', event: 'e' }));
    expect(api.emits).toHaveLength(0);
    api.g.publisher = null;
    api.g.emitExecutionEvent('exec-1', 'execution:progress', { ok: true });
    expect(api.emits).toEqual([{ room: 'execution:exec-1', event: 'execution:progress', payload: { ok: true } }]);
  });
});
