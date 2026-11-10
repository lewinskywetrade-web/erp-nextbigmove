import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { TenantService } from './tenant.service';

function prismaMock(overrides: { existingTenant?: any; existingUser?: any } = {}) {
  const tx: any = {
    tenant: { create: jest.fn(async ({ data }: any) => ({ id: 't-new', encryptionKey: 'secret', ...data })) },
    user: { create: jest.fn(async ({ data }: any) => ({ id: 'u-new', ...data })) },
    role: { findFirst: jest.fn(async () => ({ id: 'role-admin' })) },
    userRoleAssignment: { create: jest.fn(async () => ({})) },
  };
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => overrides.existingTenant ?? null) },
    user: { findFirst: jest.fn(async () => overrides.existingUser ?? null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, tx };
}

const dto = {
  tenantName: '  Acme Corp ', tenantSlug: 'acme-corp', email: '  Owner@Acme.COM ', password: 'Partner#2026',
  firstName: ' Juan ', lastName: ' Cruz ', planType: 'trial', status: 'TRIAL', maxUsers: 10, maxIntegrations: 5, trialDays: 7,
};

describe('TenantService.createTenant', () => {
  it('stores the owner email lowercased so the new admin can log in', async () => {
    const { prisma, tx } = prismaMock();
    const result = await new TenantService(prisma).createTenant(dto as any);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({ where: { email: { equals: 'owner@acme.com', mode: 'insensitive' } } });
    expect(tx.user.create.mock.calls[0][0].data).toMatchObject({ email: 'owner@acme.com', firstName: 'Juan', lastName: 'Cruz' });
    expect(tx.tenant.create.mock.calls[0][0].data.name).toBe('Acme Corp');
    expect(result.user).not.toHaveProperty('password');
    expect(result.tenant).not.toHaveProperty('encryptionKey');
  });

  it('sets trialEndsAt from trial days only for TRIAL tenants', async () => {
    const before = Date.now();
    const trial = prismaMock();
    await new TenantService(trial.prisma).createTenant(dto as any);
    const trialEndsAt: Date = trial.tx.tenant.create.mock.calls[0][0].data.trialEndsAt;
    expect(trialEndsAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 86400000);
    expect(trialEndsAt.getTime()).toBeLessThan(before + 7 * 86400000 + 60000);

    const active = prismaMock();
    await new TenantService(active.prisma).createTenant({ ...dto, status: 'ACTIVE', planType: 'starter' } as any);
    expect(active.tx.tenant.create.mock.calls[0][0].data.trialEndsAt).toBeNull();
  });

  it('rejects a duplicate email in any letter case and a duplicate slug', async () => {
    await expect(new TenantService(prismaMock({ existingUser: { id: 'x' } }).prisma).createTenant(dto as any))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(new TenantService(prismaMock({ existingTenant: { id: 'y' } }).prisma).createTenant(dto as any))
      .rejects.toThrow('Tenant slug already exists');
  });
});

describe('TenantService.update', () => {
  it('clears the trial end date when the tenant leaves TRIAL', async () => {
    const prisma: any = {
      tenant: {
        findUnique: jest.fn(async () => ({ id: 't1', slug: 'acme' })),
        update: jest.fn(async ({ data }: any) => ({ id: 't1', encryptionKey: 'k', ...data })),
      },
    };
    await new TenantService(prisma).update('t1', { status: 'ACTIVE' } as any);
    expect(prisma.tenant.update.mock.calls[0][0].data).toMatchObject({ status: 'ACTIVE', trialEndsAt: null });
    await new TenantService(prisma).update('t1', { status: 'TRIAL' } as any);
    expect(prisma.tenant.update.mock.calls[1][0].data).not.toHaveProperty('trialEndsAt');
  });
});
