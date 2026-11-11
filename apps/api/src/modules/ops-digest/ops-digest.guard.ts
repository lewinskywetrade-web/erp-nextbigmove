import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

@Injectable()
export class OpsDigestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedToken = (process.env.OPS_DIGEST_TOKEN || '').trim();
    if (expectedToken.length < 32) {
      throw new ServiceUnavailableException('Ops digest endpoint is not configured');
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      user?: { id: string; role: string; tenantId: string | null };
    }>();

    const authHeaderRaw = request.headers?.authorization;
    const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
    const customHeaderRaw = request.headers?.['x-ops-digest-token'];
    const customHeader = Array.isArray(customHeaderRaw) ? customHeaderRaw[0] : customHeaderRaw;

    let providedToken = '';
    if (typeof authHeader === 'string' && /^Bearer\s+\S+/i.test(authHeader)) {
      providedToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    } else if (typeof customHeader === 'string' && customHeader.trim().length > 0) {
      providedToken = customHeader.trim();
    }

    if (!providedToken) {
      throw new UnauthorizedException('Missing ops digest authorization token');
    }

    const expectedDigest = sha256Buffer(expectedToken);
    const providedDigest = sha256Buffer(providedToken);
    if (!timingSafeEqual(expectedDigest, providedDigest)) {
      throw new UnauthorizedException('Invalid ops digest authorization token');
    }

    request.user = {
      id: 'ops-digest-automation',
      role: 'SUPER_ADMIN',
      tenantId: null,
    };

    return true;
  }
}
