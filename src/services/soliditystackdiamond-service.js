const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const solc = require('solc');

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

class CompilationError extends Error {
    constructor(diagnostics) {
        super('Solidity compilation failed');
        this.name = 'CompilationError';
        this.statusCode = 422;
        this.diagnostics = diagnostics;
    }
}

class SolidityStackDiamondService extends EventEmitter {
    constructor(options = {}) {
        super();
        this.minWorkers = positiveInteger(options.minWorkers, 1, 'minWorkers');
        this.maxWorkers = positiveInteger(options.maxWorkers, 4, 'maxWorkers');
        this.scaleThreshold = positiveInteger(options.scaleThreshold, 2, 'scaleThreshold');
        this.maxSourceBytes = positiveInteger(options.maxSourceBytes, 512 * 1024, 'maxSourceBytes');
        if (this.minWorkers > this.maxWorkers) throw new ValidationError('minWorkers cannot exceed maxWorkers');
        this.jobs = new Map();
        this.queue = [];
        this.activeWorkers = 0;
        this.completed = 0;
        this.failed = 0;
        this.startedAt = new Date().toISOString();
    }

    getData() { return this.getMetrics(); }
    process(input) { return this.compile(input); }

    compile(input) {
        const request = this.validateRequest(input);
        const compilerInput = {
            language: 'Solidity',
            sources: { [request.fileName]: { content: request.source } },
            settings: {
                optimizer: request.optimizer,
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } }
            }
        };
        const output = JSON.parse(solc.compile(JSON.stringify(compilerInput)));
        const diagnostics = (output.errors || []).map(normalizeDiagnostic);
        if (diagnostics.some(item => item.severity === 'error')) throw new CompilationError(diagnostics);

        const contracts = [];
        for (const [fileName, fileContracts] of Object.entries(output.contracts || {})) {
            for (const [name, contract] of Object.entries(fileContracts)) {
                if (request.contractName && name !== request.contractName) continue;
                const bytecode = contract.evm?.bytecode?.object || '';
                const deployedBytecode = contract.evm?.deployedBytecode?.object || '';
                contracts.push({
                    fileName,
                    name,
                    abi: contract.abi || [],
                    bytecode: bytecode ? `0x${bytecode}` : '0x',
                    deployedBytecode: deployedBytecode ? `0x${deployedBytecode}` : '0x',
                    metadata: contract.metadata ? JSON.parse(contract.metadata) : null
                });
            }
        }
        if (request.contractName && contracts.length === 0) throw new ValidationError(`Contract not found: ${request.contractName}`);
        return {
            compiler: solc.version(),
            sourceHash: `sha256:${crypto.createHash('sha256').update(request.source).digest('hex')}`,
            optimizer: request.optimizer,
            diagnostics,
            contracts
        };
    }

    submit(input) {
        const request = this.validateRequest(input);
        const id = crypto.randomUUID();
        const job = { id, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, request, result: null, error: null };
        this.jobs.set(id, job);
        this.queue.push(id);
        this.publish('job.queued', job);
        queueMicrotask(() => this.drain());
        return this.serializeJob(job, false);
    }

    getJob(id) {
        const job = this.jobs.get(id);
        return job ? this.serializeJob(job, true) : null;
    }

    listJobs(options = {}) {
        const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
        return [...this.jobs.values()].slice(-limit).reverse().map(job => this.serializeJob(job, false));
    }

    getMetrics() {
        return {
            service: 'SolidityStackDiamond', compiler: solc.version(), startedAt: this.startedAt,
            queueDepth: this.queue.length, activeWorkers: this.activeWorkers, desiredWorkers: this.desiredWorkers(),
            minWorkers: this.minWorkers, maxWorkers: this.maxWorkers,
            completed: this.completed, failed: this.failed, totalJobs: this.jobs.size
        };
    }

    desiredWorkers() {
        if (!this.queue.length) return this.minWorkers;
        return Math.min(this.maxWorkers, Math.max(this.minWorkers, Math.ceil(this.queue.length / this.scaleThreshold)));
    }

    drain() {
        const target = this.desiredWorkers();
        while (this.queue.length && this.activeWorkers < target) {
            const id = this.queue.shift();
            this.activeWorkers += 1;
            setImmediate(() => this.runJob(id));
        }
    }

    runJob(id) {
        const job = this.jobs.get(id);
        if (!job) return;
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        this.publish('job.started', job);
        try {
            job.result = this.compile(job.request);
            job.status = 'completed';
            this.completed += 1;
            job.finishedAt = new Date().toISOString();
            this.publish('job.completed', job);
        } catch (error) {
            job.status = 'failed';
            job.error = serializeError(error);
            this.failed += 1;
            job.finishedAt = new Date().toISOString();
            this.publish('job.failed', job);
        } finally {
            this.activeWorkers -= 1;
            this.drain();
        }
    }

    validateRequest(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Request body must be a JSON object');
        if (typeof input.source !== 'string' || !input.source.trim()) throw new ValidationError('source must be a non-empty Solidity string');
        if (Buffer.byteLength(input.source) > this.maxSourceBytes) throw new ValidationError(`source exceeds ${this.maxSourceBytes} bytes`);
        const fileName = input.fileName || 'Contract.sol';
        if (!/^[A-Za-z0-9_.-]+\.sol$/.test(fileName)) throw new ValidationError('fileName must be a safe .sol filename');
        if (input.contractName != null && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input.contractName)) throw new ValidationError('contractName is not a valid Solidity identifier');
        const optimizer = input.optimizer || {};
        const runs = optimizer.runs == null ? 200 : Number(optimizer.runs);
        if (!Number.isInteger(runs) || runs < 1 || runs > 1000000) throw new ValidationError('optimizer.runs must be an integer from 1 to 1000000');
        return { source: input.source, fileName, contractName: input.contractName || null, optimizer: { enabled: optimizer.enabled !== false, runs } };
    }

    serializeJob(job, includeResult) {
        return {
            id: job.id, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
            fileName: job.request.fileName, contractName: job.request.contractName,
            ...(includeResult ? { result: job.result, error: job.error } : {})
        };
    }

    publish(type, job) { this.emit('event', { type, at: new Date().toISOString(), job: this.serializeJob(job, false) }); }
}

function positiveInteger(value, fallback, name) {
    if (value == null) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new ValidationError(`${name} must be a positive integer`);
    return number;
}

function normalizeDiagnostic(item) {
    return { severity: item.severity, type: item.type, message: item.message, formattedMessage: item.formattedMessage, sourceLocation: item.sourceLocation || null };
}

function serializeError(error) { return { name: error.name, message: error.message, diagnostics: error.diagnostics || [] }; }

module.exports = { SolidityStackDiamondService, ValidationError, CompilationError };
