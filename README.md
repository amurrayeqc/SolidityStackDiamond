# SolidityStackDiamond

[![CI](https://github.com/centxyz/SolidityStackDiamond/actions/workflows/ci.yml/badge.svg)](https://github.com/centxyz/SolidityStackDiamond/actions/workflows/ci.yml)

SolidityStackDiamond is a production-oriented Solidity compilation service. It turns Solidity source into ABI, creation bytecode, deployed bytecode, compiler metadata, diagnostics, and a reproducible source hash through either a synchronous HTTP call or an asynchronous worker queue.

## What it does

- Compiles real Solidity source with the official `solc-js` compiler
- Produces ABI, bytecode, deployed bytecode, metadata, warnings, and errors
- Supports synchronous compilation and asynchronous jobs
- Scales active workers in response to queue depth within configured limits
- Streams job lifecycle events over Server-Sent Events (SSE)
- Validates source size, filenames, contract names, and optimizer configuration
- Reports queue, worker, compiler, completion, and failure metrics
- Disables framework fingerprinting and returns consistent JSON errors

It is a build and processing service. It does not deploy contracts, manage private keys, or claim blockchain consensus.

## Requirements

- Node.js 18 or newer

## Install

```bash
git clone https://github.com/centxyz/SolidityStackDiamond.git
cd SolidityStackDiamond
npm install
npm test
npm start
```

The API listens on port `3000` by default.

## Compile a contract

```bash
curl -s http://localhost:3000/api/compile \
  -H 'Content-Type: application/json' \
  -d '{
    "fileName": "Counter.sol",
    "contractName": "Counter",
    "source": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0; contract Counter { uint256 public count; function increment() external { count += 1; } }",
    "optimizer": { "enabled": true, "runs": 200 }
  }'
```

The successful response contains `compiler`, `sourceHash`, `diagnostics`, and one or more contract artifacts under `contracts`.

## Queue a compilation

Submit the same JSON body to the job endpoint:

```bash
curl -i http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  --data-binary @request.json
```

The server returns `202 Accepted`, a job ID, and a `Location` header. Poll the location until the status is `completed` or `failed`:

```bash
curl http://localhost:3000/api/jobs/JOB_ID
```

Watch every job transition in real time:

```bash
curl -N http://localhost:3000/api/events
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health, compiler version, and worker status |
| `GET` | `/api/metrics` | Queue and completion metrics |
| `POST` | `/api/compile` | Compile immediately |
| `POST` | `/api/process` | Compatibility alias for immediate compilation |
| `POST` | `/api/jobs` | Queue a compilation and return `202` |
| `GET` | `/api/jobs` | List recent jobs; supports `?limit=1..100` |
| `GET` | `/api/jobs/:id` | Read status, artifacts, or diagnostics |
| `GET` | `/api/events` | SSE stream for queued/running/completed/failed events |

## Configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PORT` | `3000` | HTTP listening port |
| `MIN_WORKERS` | `1` | Minimum desired worker count |
| `MAX_WORKERS` | `4` | Maximum simultaneous compilers |
| `SCALE_THRESHOLD` | `2` | Queued jobs represented by each desired worker |

The default maximum Solidity source size is 512 KiB. The HTTP JSON body limit is 1 MiB.

## Test

```bash
npm test
```

The suite compiles a real contract and verifies bytecode/ABI output, compiler diagnostics, request validation, asynchronous success and failure paths, worker scaling, metrics, and routing.

## License

MIT © cent
