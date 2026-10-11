import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { ProductsRepository } from '../products/products.repository';

@Module({
  controllers: [MediaController],
  providers: [MediaService, ProductsRepository],
  exports: [MediaService],
})
export class MediaModule {}
