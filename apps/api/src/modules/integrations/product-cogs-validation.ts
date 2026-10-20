import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

// PosProductCogs.cogs is stored as Decimal(12, 2), in pesos per unit.
export const MAX_PRODUCT_COGS = 9_999_999_999.99;
export const ERP_COGS_POLICY = 'ERP_POSITIVE_COGS_WMS_ZERO_ONLY_V1';

// Existing zero history remains readable and correctable, but is not an
// applicable ERP rate. WMS owns the separate zero-cost stock policy.
export function assertRecordedProductCogs(cogs: number): void {
  if (!Number.isFinite(cogs) || cogs < 0) {
    throw new BadRequestException('cogs must be a finite number greater than or equal to 0');
  }
  if (cogs > MAX_PRODUCT_COGS) {
    throw new BadRequestException(`cogs must not exceed ${MAX_PRODUCT_COGS}`);
  }
  if (new Prisma.Decimal(cogs).decimalPlaces() > 2) {
    throw new BadRequestException('cogs must have at most 2 decimal places');
  }
}

export function assertValidProductCogs(cogs: number): void {
  assertRecordedProductCogs(cogs);
  if (cogs <= 0) {
    throw new BadRequestException(`ERP cogs must be greater than 0 (${ERP_COGS_POLICY})`);
  }
}
