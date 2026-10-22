import { Controller, Get, Param, Query } from '@nestjs/common';
import { StoresService } from './stores.service';

@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get()
  async listStores(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.storesService.listActiveStores({
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    return {
      success: true,
      data,
    };
  }

  @Get(':id')
  async getStoreById(@Param('id') id: string) {
    const data = await this.storesService.getStoreById(id);
    return {
      success: true,
      data,
    };
  }
}
