import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendOpsDailyDigestEmailDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120000)
  text!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(250000)
  html!: string;
}
