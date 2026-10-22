import { PrismaModule } from '../prisma/prisma.module';
import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { ProductsRepository } from '../products/products.repository';

@Module({
  imports: [PrismaModule],
  controllers: [MediaController],
  providers: [MediaService, ProductsRepository],
  exports: [MediaService],
})
export class MediaModule {}
