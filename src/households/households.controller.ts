import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { HouseholdsService } from './households.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('households')
@UseGuards(JwtAuthGuard)
export class HouseholdsController {
  constructor(private readonly householdsService: HouseholdsService) {}

  @Get()
  async getMyHouseholds(@Request() req: any) {
    return this.householdsService.getUserHouseholds(req.user.userId);
  }

  @Get(':id')
  async getHouseholdDetails(@Param('id') id: string, @Request() req: any) {
    return this.householdsService.getHouseholdDetails(id, req.user.userId);
  }

  @Put(':id/members/:userId/role')
  async updateMemberRole(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body('role') role: string,
    @Request() req: any,
  ) {
    return this.householdsService.updateMemberRole(id, req.user.userId, targetUserId, role);
  }

  @Post(':id/members')
  async addMember(
    @Param('id') id: string,
    @Body() body: { email: string; role?: string; nickname?: string },
    @Request() req: any,
  ) {
    return this.householdsService.addMember(id, req.user.userId, body.email, body.role, body.nickname);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Request() req: any,
  ) {
    return this.householdsService.removeMember(id, req.user.userId, targetUserId);
  }
}
