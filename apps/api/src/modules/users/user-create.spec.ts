import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { UserService } from './user.service';

function service(existing: any = null) {
  const prisma: any = {
    user: {
      findFirst: jest.fn(async () => existing),
      create: jest.fn(async ({ data }: any) => ({ id: 'u1', ...data })),
    },
    userRoleAssignment: { findMany: jest.fn(async () => []), deleteMany: jest.fn(), create: jest.fn() },
    teamMembership: { upsert: jest.fn() },
  };
  const cls: any = { get: jest.fn(() => 'tenant-1') };
  return { svc: new UserService(prisma, cls), prisma };
}
const dto = { email: '  New.User@Partner.COM ', password: 'Partner#2026', firstName: 'New', lastName: 'User' };

describe('UserService.create (ERP Settings → Users)', () => {
  it('stores the email lowercased and never returns the password hash', async () => {
    const { svc, prisma } = service();
    const created: any = await svc.create(dto as any);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ email: { equals: 'new.user@partner.com', mode: 'insensitive' } });
    expect(prisma.user.create.mock.calls[0][0].data.email).toBe('new.user@partner.com');
    expect(created).not.toHaveProperty('password');
    expect(created.email).toBe('new.user@partner.com');
  });

  it('rejects an email already used in this tenant', async () => {
    const { svc } = service({ tenantId: 'tenant-1' });
    await expect(svc.create(dto as any)).rejects.toThrow('Email already exists in this tenant');
  });

  it('points to "Add existing user" when the email belongs to another tenant', async () => {
    const { svc, prisma } = service({ tenantId: 'tenant-2' });
    await expect(svc.create(dto as any)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.create(dto as any)).rejects.toThrow(/Add existing user/);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
