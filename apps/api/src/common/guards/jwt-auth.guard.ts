import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { assertImpersonationReadOnly, IMPERSONATION_STOP_REQUEST, isExactAuthAction } from './impersonation-policy';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    request[IMPERSONATION_STOP_REQUEST] = isExactAuthAction(context, 'impersonate/stop');
    return super.canActivate(context);
  }

  handleRequest<TUser = any>(err: any, user: any, info: any, context: ExecutionContext, status?: any): TUser {
    const authenticated = super.handleRequest<TUser>(err, user, info, context, status);
    assertImpersonationReadOnly(context, authenticated as { impersonatedBy?: string | null });
    return authenticated;
  }
}
