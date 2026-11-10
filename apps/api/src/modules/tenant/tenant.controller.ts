import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TenantService } from './tenant.service';
import { CreateTenantDto, UpdateTenantDto } from './dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { WmsAccessGuard } from '../../common/guards/wms-access.guard';

@Controller('tenants')
@UseGuards(JwtAuthGuard, WmsAccessGuard)
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  /**
   * Create a new tenant
   */
  @Post()
  @Permissions('wms.partners.write')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createTenantDto: CreateTenantDto) {
    return this.tenantService.createTenant(createTenantDto);
  }

  /**
   * Get all tenants
   */
  @Get()
  @Permissions('wms.partners.read')
  async findAll() {
    return this.tenantService.findAll();
  }

  /**
   * Get tenant statistics
   */
  @Get('stats')
  @Permissions('wms.partners.read')
  async getStats() {
    return this.tenantService.getStats();
  }

  /**
   * Get a single tenant
   */
  @Get(':id/users')
  @Permissions('wms.partners.read')
  async findUsers(@Param('id') id: string) {
    return this.tenantService.findUsers(id);
  }

  @Get(':id')
  @Permissions('wms.partners.read')
  async findOne(@Param('id') id: string) {
    return this.tenantService.findOne(id);
  }

  /**
   * Update a tenant
   */
  @Patch(':id')
  @Permissions('wms.partners.edit')
  async update(@Param('id') id: string, @Body() updateTenantDto: UpdateTenantDto) {
    return this.tenantService.update(id, updateTenantDto);
  }

  /**
   * Delete a tenant
   */
  @Delete(':id')
  @Permissions('wms.partners.edit')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string) {
    await this.tenantService.remove(id);
  }
}
