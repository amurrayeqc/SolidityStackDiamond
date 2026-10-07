const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Server } = require('../src/server');
const { SolidityStackDiamondService } = require('../src/services/soliditystackdiamond-service');

const validSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Counter {
    uint256 public count;
    function increment() external { count += 1; }
}`;

describe('SolidityStackDiamond API', () => {
    let server;
    beforeEach(() => { server = new Server(0, { logging: false }); });

    test('reports compiler and worker health', async () => {
        const response = await request(server.app).get('/health').expect(200);
        assert.equal(response.body.status, 'healthy');
        assert.match(response.body.compiler, /0\.8\./);
        assert.equal(response.body.minWorkers, 1);
    });

    test('compiles Solidity into ABI and deployable bytecode', async () => {
        const response = await request(server.app).post('/api/compile').send({ source: validSource, contractName: 'Counter' }).expect(200);
        const artifact = response.body.result.contracts[0];
        assert.equal(artifact.name, 'Counter');
        assert.ok(artifact.abi.some(item => item.name === 'increment'));
        assert.match(artifact.bytecode, /^0x[0-9a-f]+$/);
        assert.match(response.body.result.sourceHash, /^sha256:[0-9a-f]{64}$/);
    });

    test('returns compiler diagnostics for invalid Solidity', async () => {
        const response = await request(server.app).post('/api/compile').send({ source: 'contract Broken {' }).expect(422);
        assert.equal(response.body.error, 'Solidity compilation failed');
        assert.equal(response.body.diagnostics[0].severity, 'error');
    });

    test('validates requests and missing jobs', async () => {
        await request(server.app).post('/api/compile').send({ source: '' }).expect(400);
        await request(server.app).post('/api/compile').send({ source: validSource, fileName: '../Bad.sol' }).expect(400);
        await request(server.app).get('/api/jobs/missing').expect(404);
    });

    test('processes asynchronous compile jobs to completion', async () => {
        const queued = await request(server.app).post('/api/jobs').send({ source: validSource }).expect(202);
        assert.equal(queued.headers.location, `/api/jobs/${queued.body.job.id}`);
        const job = await waitForJob(server.service, queued.body.job.id);
        assert.equal(job.status, 'completed');
        assert.equal(job.result.contracts[0].name, 'Counter');
        assert.equal(server.service.getMetrics().completed, 1);
    });

    test('records failed asynchronous jobs', async () => {
        const queued = await request(server.app).post('/api/jobs').send({ source: 'contract Broken {' }).expect(202);
        const job = await waitForJob(server.service, queued.body.job.id);
        assert.equal(job.status, 'failed');
        assert.equal(job.error.diagnostics[0].severity, 'error');
    });

    test('scales desired workers with queue pressure and enforces the maximum', () => {
        const service = new SolidityStackDiamondService({ minWorkers: 1, maxWorkers: 3, scaleThreshold: 2 });
        service.queue = ['1', '2', '3', '4', '5', '6', '7'];
        assert.equal(service.desiredWorkers(), 3);
    });
});

async function waitForJob(service, id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const job = service.getJob(id);
        if (job.status === 'completed' || job.status === 'failed') return job;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Job did not complete in time');
}
