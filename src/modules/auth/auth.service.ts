import { Injectable, NotFoundException, UnauthorizedException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { CreateApiKeyDto, UpdateApiKeyDto } from './dto';
import { createLogger } from '../../common/services/logger.service';

const API_KEY_FILE = join(process.cwd(), 'data', '.api-key');

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = createLogger('AuthService');

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  async onModuleInit(): Promise<void> {
    const configuredMasterKey = process.env.API_MASTER_KEY?.trim();

    // If an operator sets API_MASTER_KEY, that key must be valid even when
    // the database already contains older/generated keys. Otherwise changing
    // .env after the first boot would never affect dashboard/API login.
    if (configuredMasterKey) {
      await this.ensureMasterApiKey(configuredMasterKey);
      this.writeApiKeyFile(configuredMasterKey);
      this.logStartupBanner(configuredMasterKey, false);
      return;
    }

    // Seed a default API key if none exist
    const count = await this.apiKeyRepository.count();
    let displayKey: string;
    let isNewKey = false;

    if (count === 0) {
      displayKey =
        process.env.NODE_ENV === 'production' ? `owa_k1_${randomBytes(32).toString('hex')}` : 'dev-admin-key';

      await this.seedApiKey(displayKey, 'Default Admin Key', ApiKeyRole.ADMIN);
      isNewKey = true;
      this.writeApiKeyFile(displayKey);
    } else {
      displayKey = this.readApiKeyFile();
    }

    this.logStartupBanner(displayKey, isNewKey);
  }

  private async ensureMasterApiKey(rawKey: string): Promise<void> {
    const keyHash = this.hashKey(rawKey);
    const existing = await this.apiKeyRepository.findOne({ where: { keyHash } });

    if (existing) {
      existing.name = existing.name || 'Master Admin Key';
      existing.role = ApiKeyRole.ADMIN;
      existing.isActive = true;
      existing.allowedIps = null;
      existing.allowedSessions = null;
      existing.expiresAt = null;
      await this.apiKeyRepository.save(existing);
      return;
    }

    await this.seedApiKey(rawKey, 'Master Admin Key', ApiKeyRole.ADMIN);
  }

  private writeApiKeyFile(rawKey: string): void {
    try {
      writeFileSync(API_KEY_FILE, rawKey, 'utf-8');
    } catch (err) {
      this.logger.warn('Could not save API key file', { error: String(err) });
    }
  }

  private readApiKeyFile(): string {
    if (!existsSync(API_KEY_FILE)) {
      return '(check dashboard for keys)';
    }

    try {
      return readFileSync(API_KEY_FILE, 'utf-8').trim();
    } catch (error) {
      this.logger.warn(`Failed to read API key file: ${API_KEY_FILE}`, { error: String(error) });
      return '(check dashboard for keys)';
    }
  }

  private logStartupBanner(displayKey: string, isNewKey: boolean): void {
    // Always show the welcome banner on startup
    const apiBaseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 2785}`;
    const dashboardUrl = process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 2886}`;

    this.logger.log('');
    this.logger.log('????????????????????????????????????????????????????????????????????????????????????????');
    this.logger.log('');
    this.logger.log('  ?? Welcome to OpenWA - WhatsApp API Gateway');
    this.logger.log('');
    this.logger.log(`  ?? Dashboard: ${dashboardUrl}`);
    this.logger.log(`  ?? API Docs:  ${apiBaseUrl}/api/docs`);
    this.logger.log('');
    this.logger.log(isNewKey ? '  ?? API Key (newly created):' : '  ?? API Key:');
    this.logger.log(`     ${displayKey}`);
    this.logger.log('');
    this.logger.log('????????????????????????????????????????????????????????????????????????????????????????');
    this.logger.log('');
  }

  private async seedApiKey(rawKey: string, name: string, role: ApiKeyRole): Promise<ApiKey> {
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);

    const apiKey = this.apiKeyRepository.create({
      name,
      keyHash,
      keyPrefix,
      role,
    });

    return this.apiKeyRepository.save(apiKey);
  }

  async createApiKey(dto: CreateApiKeyDto): Promise<{ apiKey: ApiKey; rawKey: string }> {
    // Generate secure random key: owa_k1_<32 bytes hex>
    const rawKey = `owa_k1_${randomBytes(32).toString('hex')}`;
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);

    const apiKey = this.apiKeyRepository.create({
      name: dto.name,
      keyHash,
      keyPrefix,
      role: dto.role || ApiKeyRole.OPERATOR,
      allowedIps: dto.allowedIps || null,
      allowedSessions: dto.allowedSessions || null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    const saved = await this.apiKeyRepository.save(apiKey);
    this.logger.log(`API key created: ${saved.name}`, {
      keyId: saved.id,
      role: saved.role,
      action: 'api_key_created',
    });

    return { apiKey: saved, rawKey };
  }

  async findAll(): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<ApiKey> {
    const apiKey = await this.apiKeyRepository.findOne({ where: { id } });
    if (!apiKey) {
      throw new NotFoundException(`API key with id '${id}' not found`);
    }
    return apiKey;
  }

  async update(id: string, dto: UpdateApiKeyDto): Promise<ApiKey> {
    const apiKey = await this.findOne(id);

    if (dto.name) apiKey.name = dto.name;
    if (dto.role) apiKey.role = dto.role;
    if (dto.allowedIps !== undefined) apiKey.allowedIps = dto.allowedIps;
    if (dto.allowedSessions !== undefined) apiKey.allowedSessions = dto.allowedSessions;
    if (dto.expiresAt !== undefined) apiKey.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    return this.apiKeyRepository.save(apiKey);
  }

  async delete(id: string): Promise<void> {
    const apiKey = await this.findOne(id);
    await this.apiKeyRepository.remove(apiKey);
    this.logger.log(`API key deleted: ${apiKey.name}`, {
      keyId: id,
      action: 'api_key_deleted',
    });
  }

  async revoke(id: string): Promise<ApiKey> {
    const apiKey = await this.findOne(id);
    apiKey.isActive = false;
    return this.apiKeyRepository.save(apiKey);
  }

  async validateApiKey(rawKey: string, clientIp?: string, sessionId?: string): Promise<ApiKey> {
    const keyHash = this.hashKey(rawKey);
    const apiKey = await this.apiKeyRepository.findOne({ where: { keyHash } });

    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (!apiKey.isActive) {
      throw new UnauthorizedException('API key is revoked');
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    // Check IP whitelist
    if (apiKey.allowedIps && apiKey.allowedIps.length > 0 && clientIp) {
      if (!this.isIpAllowed(clientIp, apiKey.allowedIps)) {
        this.logger.warn(`IP not allowed: ${clientIp}`, {
          keyId: apiKey.id,
          action: 'ip_rejected',
        });
        throw new UnauthorizedException('IP address not allowed');
      }
    }

    // Check session restriction
    if (apiKey.allowedSessions && apiKey.allowedSessions.length > 0 && sessionId) {
      if (!apiKey.allowedSessions.includes(sessionId)) {
        throw new UnauthorizedException('API key not authorized for this session');
      }
    }

    // Update usage stats
    apiKey.lastUsedAt = new Date();
    apiKey.usageCount += 1;
    await this.apiKeyRepository.save(apiKey);

    return apiKey;
  }

  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  private isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
    // Phase 3 Security Audit: Support both exact match and CIDR notation
    for (const entry of allowedIps) {
      if (entry.includes('/')) {
        // CIDR notation (e.g., "10.0.0.0/24")
        if (this.ipInCidr(clientIp, entry)) {
          return true;
        }
      } else {
        // Exact match
        if (clientIp === entry) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if an IPv4 address is within a CIDR range
   * @param ip - Client IP address (e.g., "192.168.1.100")
   * @param cidr - CIDR notation (e.g., "192.168.1.0/24")
   */
  private ipInCidr(ip: string, cidr: string): boolean {
    try {
      const [range, bitsStr] = cidr.split('/');
      const bits = parseInt(bitsStr, 10);

      if (isNaN(bits) || bits < 0 || bits > 32) {
        return false;
      }

      const mask = ~(2 ** (32 - bits) - 1);
      const ipNum = this.ipToNumber(ip);
      const rangeNum = this.ipToNumber(range);

      return (ipNum & mask) === (rangeNum & mask);
    } catch (error) {
      this.logger.warn(`Invalid CIDR format: ${cidr}`, { error: String(error) });
      return false;
    }
  }

  /**
   * Convert IPv4 address string to 32-bit number
   */
  private ipToNumber(ip: string): number {
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;

    return parts.reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  }

  hasPermission(apiKey: ApiKey, requiredRole: ApiKeyRole): boolean {
    const roleHierarchy: Record<ApiKeyRole, number> = {
      [ApiKeyRole.VIEWER]: 1,
      [ApiKeyRole.OPERATOR]: 2,
      [ApiKeyRole.ADMIN]: 3,
    };

    return roleHierarchy[apiKey.role] >= roleHierarchy[requiredRole];
  }
}
