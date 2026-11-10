import {
  IsEmail,
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  Matches,
  IsEnum,
  IsNumber,
  Min,
  Max,
  IsOptional,
} from 'class-validator';

export class CreateTenantDto {
  // Tenant Information
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  tenantName: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Tenant slug must be lowercase alphanumeric with hyphens',
  })
  tenantSlug: string;

  // Admin User Information
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password must contain uppercase, lowercase, and number/special character',
  })
  password: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  firstName: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  lastName: string;

  // Plan & Limits
  @IsEnum(['trial', 'starter', 'professional', 'enterprise'])
  planType: string;

  @IsEnum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'])
  status: string;

  @IsNumber()
  @Min(0)
  @Max(10000)
  maxUsers: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  maxIntegrations: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(365)
  trialDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  billingCompanyName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  billingAddress?: string | null;
}
