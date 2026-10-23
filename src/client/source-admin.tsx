import { useEffect, useSyncExternalStore, type ComponentType } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SourceAdminApi } from '../source-admin-types.ts';
import { SourceAdministrationRuntime } from './source-admin-runtime.ts';
import { RunnerSkewPreferences } from './runner-skew-state.ts';
import { RunnerSkewBanner, runnerSkewStyles } from './runner-skew.tsx';
import { notifySourceSummarySettings, type SourceSummarySettings } from './notify-summary-state.ts';
import { Administration } from './deferred-panels.tsx';
import type {} from './workspace-ui.ts';

const words = (language: string) => (en: string, zh: string) => language.startsWith('zh') ? zh : en;
function storage(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }

export interface SourceAdminInstallation { (): void; RunnerSkew: ComponentType }

/** Uses the unchanged official Settings shell; the workspace mounts its in-flow banner. */
export function installSourceAdmin(ctx: Context, api: SourceAdminApi): SourceAdminInstallation {
    const readLanguage = () => ctx.locale.getSnapshot().active;
    const runtime = new SourceAdministrationRuntime(api, storage());
    let session: Storage | undefined;
    try { session = globalThis.sessionStorage; } catch { /* Dismissal and minimization remain available in memory. */ }
    const preferences = new RunnerSkewPreferences(session);
    const onSummarySettings = (value: SourceSummarySettings) => notifySourceSummarySettings(ctx.get('hapiWorkspaceUi')?.sourceSummaries, value);
    const Section = (_props: PropsRuntime<'settings.section'>) => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), readLanguage), tr = words(language);
        const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
        useEffect(() => { void runtime.refresh(); }, []);
        return <section className="hapi-source-panel hapi-administration" aria-label={tr('HAPI Hub and Runners', 'HAPI Hub 与 Runner')}><h2>{tr('HAPI Hub and Runners', 'HAPI Hub 与 Runner')}</h2>
            {state.loading && !state.data && <p role="status">{tr('Reading Hub state…', '正在读取 Hub 状态…')}</p>}{state.error && <p role="alert" className="hapi-error">{state.error}</p>}
            {state.data && state.controller && <Administration api={api} data={state.data} controller={state.controller} refresh={runtime.revalidate} language={language} onSummarySettings={onSummarySettings}/>}
            <div className="hapi-button-row"><button type="button" disabled={state.loading} onClick={() => { void runtime.refresh(); }}>{tr('Refresh Hub state', '刷新 Hub 状态')}</button></div>
        </section>;
    };
    const RunnerSkew = () => {
        const language = useSyncExternalStore(listener => ctx.locale.subscribe(listener), readLanguage);
        return <RunnerSkewBanner runtime={runtime} preferences={preferences} language={language}/>;
    };
    const style = document.createElement('style'); style.textContent = styles + runnerSkewStyles; document.head.append(style);
    const unregister = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'hapi-hub', order: 35, label: () => words(readLanguage())('HAPI Hub', 'HAPI Hub') }, Section));
    return Object.assign(() => { runtime.dispose(); preferences.dispose(); unregister(); style.remove(); }, { RunnerSkew });
}
const styles = `
.hapi-administration{height:auto;min-height:0;padding:0;overflow:visible}.hapi-administration code{overflow-wrap:anywhere}
.hapi-admin-properties{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,2fr);gap:6px 14px}.hapi-admin-properties>span{display:contents}.hapi-admin-properties dt{opacity:.7}.hapi-admin-properties dd{margin:0;overflow-wrap:anywhere}
.hapi-administration .hapi-admin-toggle{display:flex;align-items:start;gap:10px;margin:16px 0}.hapi-admin-toggle input{margin-top:5px}.hapi-admin-toggle span{flex:1}.hapi-admin-toggle small{display:block;margin-top:4px}
.hapi-admin-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px}.hapi-admin-metrics>div{display:grid;gap:5px;border:1px solid var(--border-secondary,#8885);border-radius:8px;padding:10px}.hapi-admin-metrics strong{font-size:19px}
.hapi-admin-usage-row{padding:8px 0}.hapi-admin-usage-row summary{display:flex;justify-content:space-between;gap:10px;cursor:pointer;overflow-wrap:anywhere}.hapi-admin-usage-bar{height:5px;border-radius:8px;background:var(--bg-secondary,#8882);margin-top:6px}.hapi-admin-usage-bar span{display:block;height:100%;background:var(--text-link,#668de5);border-radius:8px}
.hapi-admin-storage-bar{height:14px;display:flex;overflow:hidden;border-radius:5px;margin:14px 0}.hapi-admin-storage-bar span{display:block;height:100%}.hapi-admin-receipts{margin-top:22px}.hapi-admin-receipts article{padding:10px 0;border-top:1px solid var(--border-secondary,#8883)}
`;
