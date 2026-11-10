import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

function parseUuidList(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

  return Array.from(
    new Set(
      values
        .flatMap((entry) => String(entry).split(','))
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

export class GetWmsDailyInventoryMovementsDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must use YYYY-MM-DD format' })
  date?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must use YYYY-MM-DD format' })
  startDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate must use YYYY-MM-DD format' })
  endDate?: string;

  @Transform(({ value }) => parseUuidList(value))
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  tenantIds: string[] = [];

  @Transform(({ value }) => parseUuidList(value))
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  storeIds: string[] = [];
}
