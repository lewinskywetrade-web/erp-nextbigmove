import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export const CLIENT_PREVIEW_DESTINATIONS = [
  '/daily-inventory',
  '/dashboard',
  '/reports',
] as const;

export type ClientPreviewDestination = (typeof CLIENT_PREVIEW_DESTINATIONS)[number];

export class ImpersonateClientDto {
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @IsUUID()
  @IsNotEmpty()
  userId: string;

  @IsOptional()
  @IsIn(CLIENT_PREVIEW_DESTINATIONS)
  destination?: ClientPreviewDestination;
}

export class ExchangeClientPreviewHandoffDto {
  @IsString()
  @IsNotEmpty()
  @Length(32, 128)
  code: string;
}
