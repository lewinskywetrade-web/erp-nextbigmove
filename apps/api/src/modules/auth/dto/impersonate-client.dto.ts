import { IsNotEmpty, IsUUID } from 'class-validator';

export class ImpersonateClientDto {
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @IsUUID()
  @IsNotEmpty()
  userId: string;
}
