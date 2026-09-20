import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';

@Injectable()
export class ServiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wsGateway: EventsGateway,
  ) {}

  async createServiceRequest(data: {
    householdId: string;
    deviceId?: string;
    storeId?: string;
    type?: string;
    category: string;
    description?: string;
    priority?: string;
  }) {
    const request = await this.prisma.serviceRequest.create({
      data: {
        householdId: data.householdId,
        deviceId: data.deviceId,
        storeId: data.storeId,
        type: data.type || 'MAINTENANCE',
        category: data.category,
        description: data.description || 'Yêu cầu dịch vụ được tạo từ hệ thống SmartSupply',
        priority: data.priority || 'NORMAL',
        status: 'PENDING',
      },
      include: {
        household: true,
        device: true,
      },
    });

    this.wsGateway.emitGlobal('SERVICE_REQUEST_CREATED', {
      requestId: request.id,
      householdName: request.household?.name,
      category: request.category,
      priority: request.priority,
      status: request.status,
      createdAt: request.createdAt,
    });

    return request;
  }

  async triggerEmergencyAlert(data: {
    householdId: string;
    deviceId?: string;
    alertType: string;
    message: string;
  }) {
    const alert = await this.prisma.urgentAlert.create({
      data: {
        householdId: data.householdId,
        deviceId: data.deviceId,
        alertType: data.alertType,
        message: data.message,
        status: 'ACTIVE',
      },
      include: {
        household: true,
        device: true,
      },
    });

    this.wsGateway.emitGlobal('URGENT_ALERT_TRIGGERED', {
      alertId: alert.id,
      householdId: alert.householdId,
      householdName: alert.household?.name,
      alertType: alert.alertType,
      message: alert.message,
      createdAt: alert.createdAt,
      urgency: 'CRITICAL',
    });

    return alert;
  }

  async getHouseholdRequests(householdId: string) {
    return this.prisma.serviceRequest.findMany({
      where: { householdId },
      include: { device: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStoreRequests(storeId: string) {
    return this.prisma.serviceRequest.findMany({
      where: { storeId },
      include: { household: true, device: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateRequestStatus(id: string, status: string) {
    const updated = await this.prisma.serviceRequest.update({
      where: { id },
      data: { status },
      include: { household: true },
    });

    this.wsGateway.emitGlobal('SERVICE_REQUEST_UPDATED', {
      requestId: updated.id,
      status: updated.status,
      householdId: updated.householdId,
    });

    return updated;
  }

  async getUrgentAlerts(householdId: string) {
    return this.prisma.urgentAlert.findMany({
      where: { householdId },
      include: { device: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acknowledgeAlert(alertId: string, userId: string) {
    return this.prisma.urgentAlert.update({
      where: { id: alertId },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedByUserId: userId,
        acknowledgedAt: new Date(),
      },
    });
  }
}
