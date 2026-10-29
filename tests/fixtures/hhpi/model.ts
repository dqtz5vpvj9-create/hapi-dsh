/** The model HTTP boundary is synthetic; tests execute an unmodified native Codex app-server. */
import { createServer, type Server, type ServerResponse } from 'node:http';

export interface ModelRequest { reply(text?: string): void; tool(name: string, args: Record<string, unknown>): void }
export class SyntheticResponsesModel {
    readonly server: Server;
    private readonly requests: ModelRequest[] = [];
    private readonly waiting: Array<(request: ModelRequest) => void> = [];
    private sequence = 0;
    automatic = true;
    calls = 0;
    port = 0;
    constructor() {
        this.server = createServer(async (request, response) => {
            try {
                for await (const _chunk of request) { /* Consume input without retaining source prompts. */ }
                if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404); response.end(); return; }
                const id = ++this.sequence; this.calls++;
                response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                this.event(response, 'response.created', { response: { id: `response-${id}`, object: 'response', created_at: 1, status: 'in_progress', model: 'hhpi-fixture', output: [] } });
                let done = false;
                const finish = (item: Record<string, unknown>): void => {
                    if (done) throw new Error('A model fixture request was completed twice');
                    done = true;
                    this.event(response, 'response.output_item.done', { output_index: 0, item });
                    this.event(response, 'response.completed', { response: { id: `response-${id}`, object: 'response', created_at: 1, status: 'completed', model: 'hhpi-fixture', output: [item], usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 } } });
                    response.end();
                };
                const pending: ModelRequest = {
                    reply: (text = `Synthetic response ${id}`) => {
                        const item = { id: `message-${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
                        this.event(response, 'response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
                        this.event(response, 'response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
                        this.event(response, 'response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
                        this.event(response, 'response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
                        finish(item);
                    },
                    tool: (name, args) => {
                        const item = { id: `call-${id}`, call_id: `call-${id}`, type: 'function_call', name, arguments: JSON.stringify(args), status: 'completed' };
                        this.event(response, 'response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
                        this.event(response, 'response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
                        finish(item);
                    },
                };
                if (this.automatic) pending.reply();
                else { const waiter = this.waiting.shift(); if (waiter) waiter(pending); else this.requests.push(pending); }
            } catch { response.destroy(); }
        });
    }
    private event(response: ServerResponse, type: string, data: Record<string, unknown>): void {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    }
    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
        const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('No model fixture address'); this.port = address.port;
    }
    next(signal: AbortSignal): Promise<ModelRequest> {
        signal.throwIfAborted();
        const ready = this.requests.shift(); if (ready) return Promise.resolve(ready);
        return new Promise((resolve, reject) => {
            const accept = (request: ModelRequest): void => { signal.removeEventListener('abort', abort); resolve(request); };
            const abort = (): void => { const index = this.waiting.indexOf(accept); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); };
            this.waiting.push(accept); signal.addEventListener('abort', abort, { once: true });
        });
    }
    config(): string {
        return `model = "hhpi-fixture"\nmodel_provider = "hhpi_fixture"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[model_providers.hhpi_fixture]\nname = "HHPI fixture"\nbase_url = "http://127.0.0.1:${this.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
    }
    async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => { this.server.close(error => error ? reject(error) : resolve()); this.server.closeAllConnections(); });
    }
}
