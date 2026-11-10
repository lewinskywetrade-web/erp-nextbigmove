import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

function parseEmailList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return Array.from(
    new Set(
      values
        .flatMap((entry) => String(entry).split(/[,;\n]+/))
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

export class UpdateWmsDailyInventoryEmailSubscriptionDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Transform(({ value }) => parseEmailList(value))
  @IsArray()
  @ArrayMaxSize(25)
  @IsEmail({}, { each: true })
  recipients?: string[];

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'sendTimeManila must use HH:mm 24-hour format (e.g. 20:00)',
  })
  sendTimeManila?: string;
}

export class SendWmsDailyInventoryEmailDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

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

  @IsOptional()
  @Transform(({ value }) => parseEmailList(value))
  @IsArray()
  @ArrayMaxSize(25)
  @IsEmail({}, { each: true })
  recipients?: string[];
}
