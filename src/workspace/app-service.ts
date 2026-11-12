import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService, type Principal } from '@deepseek-ai/dsh-typert-protocol';
import type { AppServiceContext, AppServiceRequest, AppServiceResponse } from './app-service-types.ts';
import type { AppNotificationService } from './notification-service.ts';
import { ReadStateService } from './read-state-service.ts';

export interface AppReadService {
    appReadState(context: AppServiceContext, request: AppServiceRequest<'appReadState'>): Promise<AppServiceResponse<'appReadState'>>;
    appReadStates(context: AppServiceContext, request: AppServiceRequest<'appReadStates'>): Promise<AppServiceResponse<'appReadStates'>>;
    appReadStateWrite(context: AppServiceContext, request: AppServiceRequest<'appReadStateWrite'>): Promise<AppServiceResponse<'appReadStateWrite'>>;
}
export interface AppShareService {
    appShareCreate(context: AppServiceContext, request: AppServiceRequest<'appShareCreate'>): Promise<AppServiceResponse<'appShareCreate'>>;
    appShareResolve(context: AppServiceContext, request: AppServiceRequest<'appShareResolve'>): Promise<AppServiceResponse<'appShareResolve'>>;
}
declare module '@deepseek-ai/cordis' { interface Context { appServices: AppServicesController } }
export class AppServicesController extends TypertRemoteService {
    private readonly reads: AppReadService | undefined;
    private readonly lifetime = new AbortController();
    constructor(ctx: Context, private readonly options: {
        context(principal: Principal): AppServiceContext;
        notifications: AppNotificationService; reads?: AppReadService; shares?: AppShareService;
        /** A Host-owned private SQLite file. Injected reads remain caller-owned. */
        readStatePath?: string;
    }) {
        super(ctx, 'appServices');
        const owned = options.reads ? undefined : options.readStatePath ? new ReadStateService({ path: options.readStatePath }) : undefined;
        this.reads = options.reads ?? owned;
        ctx.effect(() => () => { this.lifetime.abort(); owned?.close(); }, 'hhpi: account application read state');
    }
    private async call<T>(signal: AbortSignal | undefined, action: (context: AppServiceContext) => T | Promise<T>): Promise<T> {
        const invocation = this.ctx.invocation;
        if (!invocation) throw new RemoteError('remote-access/denied', 'An authenticated application connection is required.', { action: 'appServices', reason: 'no-allow' });
        const lifetime = AbortSignal.any([this.lifetime.signal, invocation.signal, invocation.peer.signal, ...(signal ? [signal] : [])]);
        lifetime.throwIfAborted();
        const context = this.options.context(invocation.peer.principal);
        const value = await action({ scope: context.scope, authorizeSource: async source => {
            lifetime.throwIfAborted();
            await context.authorizeSource(source);
            lifetime.throwIfAborted();
        } });
        lifetime.throwIfAborted(); return value;
    }
    @Remote('appNotificationSettings')
    appNotificationSettings(request: AppServiceRequest<'appNotificationSettings'>, signal?: AbortSignal) {
        return this.call(signal, context => this.options.notifications.appNotificationSettings(context, request));
    }
    @Remote('appPushSubscribe')
    appPushSubscribe(request: AppServiceRequest<'appPushSubscribe'>, signal?: AbortSignal) {
        return this.call(signal, context => this.options.notifications.appPushSubscribe(context, request));
    }
    @Remote('appPushUnsubscribe')
    appPushUnsubscribe(request: AppServiceRequest<'appPushUnsubscribe'>, signal?: AbortSignal) {
        return this.call(signal, context => this.options.notifications.appPushUnsubscribe(context, request));
    }
    @Remote('appNotificationResolve')
    appNotificationResolve(request: AppServiceRequest<'appNotificationResolve'>, signal?: AbortSignal) {
        return this.call(signal, context => this.options.notifications.appNotificationResolve(context, request));
    }
    @Remote('appReadState')
    appReadState(request: AppServiceRequest<'appReadState'>, signal?: AbortSignal) {
        return this.call(signal, context => {
            if (!this.reads) throw new Error('Reading synchronization is not registered on this Host.');
            return this.reads.appReadState(context, request);
        });
    }
    @Remote('appReadStateWrite')
    appReadStateWrite(request: AppServiceRequest<'appReadStateWrite'>, signal?: AbortSignal) {
        return this.call(signal, context => {
            if (!this.reads) throw new Error('Reading synchronization is not registered on this Host.');
            return this.reads.appReadStateWrite(context, request);
        });
    }
    @Remote('appReadStates')
    appReadStates(request: AppServiceRequest<'appReadStates'>, signal?: AbortSignal) {
        return this.call(signal, context => {
            if (!this.reads) throw new Error('Reading synchronization is not registered on this Host.');
            return this.reads.appReadStates(context, request);
        });
    }
    @Remote('appShareCreate')
    appShareCreate(request: AppServiceRequest<'appShareCreate'>, signal?: AbortSignal) {
        return this.call(signal, context => {
            if (!this.options.shares) throw new Error('Sharing is not registered on this Host.');
            return this.options.shares.appShareCreate(context, request);
        });
    }
    @Remote('appShareResolve')
    appShareResolve(request: AppServiceRequest<'appShareResolve'>, signal?: AbortSignal) {
        return this.call(signal, context => {
            if (!this.options.shares) throw new Error('Sharing is not registered on this Host.');
            return this.options.shares.appShareResolve(context, request);
        });
    }
}
