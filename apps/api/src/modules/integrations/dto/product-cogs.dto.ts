import { Transform } from 'class-transformer';
import { IsNumber, IsPositive, Max } from 'class-validator';
import { MAX_PRODUCT_COGS } from '../product-cogs-validation';

export class ProductCogsDto {
  // Validate the JSON value itself, even when the global pipe coerces primitives.
  @Transform(({ obj, key }) => obj[key], { toClassOnly: true })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_PRODUCT_COGS)
  cogs: number;
}
