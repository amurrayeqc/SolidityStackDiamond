const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { SolidityStackDiamondService } = require('./services/soliditystackdiamond-service');

class Server {
    constructor(port = 3000, options = {}) {
        this.port = Number(port);
        this.app = express();
        this.service = options.service || new SolidityStackDiamondService(options);
        this.httpServer = null;
        this.app.disable('x-powered-by');
        this.app.use(cors(options.cors || {}));
        if (options.logging !== false) this.app.use(morgan('dev'));
        this.app.use(express.json({ limit: options.jsonLimit || '1mb' }));
        this.setupRoutes();
    }

    setupRoutes() {
        this.app.get('/health', (request, response) => response.json({ status: 'healthy', ...this.service.getMetrics() }));
        this.app.get('/api/metrics', (request, response) => response.json(this.service.getMetrics()));
        this.app.get('/api/data', (request, response) => response.json({ success: true, data: this.service.getData() }));

        const compile = (request, response, next) => {
            try { response.json({ success: true, result: this.service.compile(request.body) }); }
            catch (error) { next(error); }
        };
        this.app.post('/api/compile', compile);
        this.app.post('/api/process', compile);

        this.app.post('/api/jobs', (request, response, next) => {
            try {
                const job = this.service.submit(request.body);
                response.status(202).location(`/api/jobs/${job.id}`).json({ success: true, job });
            } catch (error) { next(error); }
        });
        this.app.get('/api/jobs', (request, response) => response.json({ success: true, jobs: this.service.listJobs({ limit: request.query.limit }) }));
        this.app.get('/api/jobs/:id', (request, response) => {
            const job = this.service.getJob(request.params.id);
            if (!job) return response.status(404).json({ success: false, error: 'Job not found' });
            response.json({ success: true, job });
        });
        this.app.get('/api/events', (request, response) => {
            response.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            response.flushHeaders();
            response.write(`event: ready\ndata: ${JSON.stringify(this.service.getMetrics())}\n\n`);
            const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            this.service.on('event', send);
            request.on('close', () => this.service.off('event', send));
        });

        this.app.use((request, response) => response.status(404).json({ success: false, error: 'Route not found' }));
        this.app.use((error, request, response, next) => {
            if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return response.status(400).json({ success: false, error: 'Invalid JSON body' });
            response.status(error.statusCode || 500).json({ success: false, error: error.message, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) });
        });
    }

    start() {
        if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
        return new Promise((resolve, reject) => {
            this.httpServer = this.app.listen(this.port).once('error', reject).once('listening', () => {
                console.log(`SolidityStackDiamond listening on port ${this.httpServer.address().port}`);
                resolve(this.httpServer);
            });
        });
    }

    stop() {
        if (!this.httpServer) return Promise.resolve();
        return new Promise((resolve, reject) => this.httpServer.close(error => error ? reject(error) : resolve()));
    }
}

if (require.main === module) {
    const server = new Server(process.env.PORT || 3000, { minWorkers: process.env.MIN_WORKERS, maxWorkers: process.env.MAX_WORKERS, scaleThreshold: process.env.SCALE_THRESHOLD });
    server.start().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { Server };
