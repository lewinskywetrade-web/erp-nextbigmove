import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { resolveAllowedCorsOrigins } from '../../../common/services/cors-config.service';
import { shouldRunApiBackgroundServices } from '../../../common/runtime/process-role';

export const WORKFLOW_EVENT_RELAY_CHANNEL = 'erp:ws:workflow-events';

type RelayMessage = {
  origin: string;
  rooms: string[];
  event: string;
  payload: any;
};

@WebSocketGateway({
  namespace: '/workflows',
  cors: {
    origin: resolveAllowedCorsOrigins(),
    credentials: true,
  },
})
export class WorkflowExecutionGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WorkflowExecutionGateway.name);
  private readonly instanceId = randomUUID();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;

  /**
   * The dedicated worker process (webhook ingest + reconcile) has no socket
   * server, so its events were silently dropped and browsers only saw new data
   * on their next poll. Every process publishes events to Redis; processes
   * that serve browser sockets re-emit events published by other processes.
   */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.WORKFLOW_EVENT_RELAY_ENABLED === 'false') return;
    const options = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 2,
    };
    try {
      this.publisher = new Redis(options);
      this.publisher.on('error', (error) => this.logger.warn(`Event relay publisher: ${error?.message ?? error}`));
      if (shouldRunApiBackgroundServices()) {
        this.subscriber = new Redis(options);
        this.subscriber.on('error', (error) => this.logger.warn(`Event relay subscriber: ${error?.message ?? error}`));
        this.subscriber.on('message', (_channel: string, raw: string) => this.handleRelayMessage(raw));
        void this.subscriber.subscribe(WORKFLOW_EVENT_RELAY_CHANNEL).catch((error) =>
          this.logger.warn(`Event relay subscribe failed: ${error?.message ?? error}`));
      }
    } catch (error: any) {
      this.logger.warn(`Event relay disabled: ${error?.message ?? error}`);
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.publisher?.quit(), this.subscriber?.quit()].map((p) => p?.catch(() => undefined)));
  }

  /**
   * Subscribe a client to tenant/team room for broadcast updates
   */
  @SubscribeMessage('subscribe:tenant')
  handleSubscribeTenant(
    @MessageBody() data: { tenantId: string; teamId?: string | null },
    @ConnectedSocket() client: Socket,
  ) {
    const tenantId = data?.tenantId;
    const teamId = data?.teamId;
    if (tenantId) {
      client.join(`tenant:${tenantId}`);
      if (teamId) {
        client.join(`tenant:${tenantId}:team:${teamId}`);
      }
    }
  }

  /**
   * Subscribe a client to an execution room
   */
  @SubscribeMessage('subscribe:execution')
  handleSubscribe(
    @MessageBody() executionId: string,
    @ConnectedSocket() client: Socket,
  ) {
    if (executionId) {
      client.join(`execution:${executionId}`);
    }
  }

  /**
   * Emit an event to all subscribers of an execution
   */
  emitExecutionEvent(executionId: string, event: string, payload: any) {
    this.dispatch([`execution:${executionId}`], event, payload);
  }

  /**
   * Emit an event to all subscribers of a tenant/team
   */
  emitTenantEvent(tenantId: string, teamId: string | null | undefined, event: string, payload: any) {
    this.dispatch(
      teamId ? [`tenant:${tenantId}`, `tenant:${tenantId}:team:${teamId}`] : [`tenant:${tenantId}`],
      event,
      payload,
    );
  }

  private dispatch(rooms: string[], event: string, payload: any) {
    this.emitLocal(rooms, event, payload);
    if (!this.publisher) return;
    const message: RelayMessage = { origin: this.instanceId, rooms, event, payload };
    void this.publisher.publish(WORKFLOW_EVENT_RELAY_CHANNEL, JSON.stringify(message)).catch((error) =>
      this.logger.warn(`Event relay publish failed (${event}): ${error?.message ?? error}`));
  }

  private emitLocal(rooms: string[], event: string, payload: any) {
    if (!this.server) return;
    for (const room of rooms) this.server.to(room).emit(event, payload);
  }

  private handleRelayMessage(raw: string) {
    try {
      const message = JSON.parse(raw) as RelayMessage;
      if (!message || message.origin === this.instanceId || !Array.isArray(message.rooms) || typeof message.event !== 'string') return;
      this.emitLocal(message.rooms.filter((room) => typeof room === 'string'), message.event, message.payload);
    } catch {
      // Ignore malformed relay messages.
    }
  }
}
