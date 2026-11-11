import { WmsProductProfileStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateWmsProductProfileDto {
  @IsOptional()
  @IsEnum(WmsProductProfileStatus)
  status?: WmsProductProfileStatus;

  @IsOptional()
  @IsBoolean()
  isSerialized?: boolean;

  @IsOptional()
  @IsUUID()
  preferredLocationId?: string | null;

  @IsOptional()
  @IsUUID()
  pickLocationId?: string | null;

  @IsOptional()
  @IsBoolean()
  isFragile?: boolean;

  @IsOptional()
  @IsBoolean()
  isStackable?: boolean;

  @IsOptional()
  @IsBoolean()
  keepDry?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresExpirationDate?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  inhouseUnitCost?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  supplierUnitCost?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  linkedProfileIds?: string[];
}
