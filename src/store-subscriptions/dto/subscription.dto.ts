import { IsNotEmpty } from 'class-validator';

export class SubscribePlanDto {
  @IsNotEmpty()
  planId: string | number;
}
