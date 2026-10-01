import { IsNotEmpty, IsNumber, Min } from 'class-validator';

export class CreateRentalOrderDto {
  @IsNotEmpty()
  packageId: string | number;

  @IsNumber()
  @Min(1)
  monthsRented: number;
}
