#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const { bruToJsonV2, bruToEnvJsonV2, collectionBruToJson } = require('@usebruno/lang');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiRoot = path.join(root, 'bruno', 'flatwrite-api');
const webRoot = path.join(root, 'bruno', 'flatwrite-webmcp');
const errors = [];

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(absolute));
    else out.push(absolute);
  }
  return out.sort();
}

function rel(file) {
  return path.relative(root, file);
}

function parseBru(file) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    if (path.basename(file) === 'collection.bru') return collectionBruToJson(source);
    if (file.includes(`${path.sep}environments${path.sep}`)) return bruToEnvJsonV2(source);
    return bruToJsonV2(source);
  } catch (error) {
    errors.push(`${rel(file)}: Bruno syntax error: ${error.message}`);
    return null;
  }
}

function expect(condition, message) {
  if (!condition) errors.push(message);
}

for (const rootDir of [apiRoot, webRoot]) {
  expect(fs.existsSync(path.join(rootDir, 'bruno.json')), `${rel(rootDir)}: missing bruno.json`);
  expect(fs.existsSync(path.join(rootDir, 'collection.bru')), `${rel(rootDir)}: missing collection.bru`);
  for (const file of filesUnder(rootDir).filter((name) => name.endsWith('.bru'))) parseBru(file);
}

const apiRequests = filesUnder(apiRoot).filter((file) => file.endsWith('.bru') && !file.includes(`${path.sep}environments${path.sep}`) && path.basename(file) !== 'collection.bru');
const apiParsed = apiRequests.map((file) => ({ file, data: parseBru(file) })).filter((item) => item.data);

const operations = apiParsed.map(({ data }) => `${String(data.http?.method || '').toUpperCase()} ${String(data.http?.url || '').replace(/\{\{[^}]+\}\}/g, '')}`);
const openapi = yaml.load(fs.readFileSync(path.join(root, 'openapi.yaml'), 'utf8'));
const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const expectedOperations = Object.entries(openapi?.paths || {}).flatMap(([url, pathItem]) =>
  Object.keys(pathItem || {})
    .filter((method) => httpMethods.has(method.toLowerCase()))
    .map((method) => `${method.toUpperCase()} ${url}`)
).sort();
const actualOperations = [...operations].sort();
expect(
  JSON.stringify(actualOperations) === JSON.stringify(expectedOperations),
  `flatwrite-api: request operations differ from openapi.yaml; expected [${expectedOperations.join(', ')}], found [${actualOperations.join(', ')}]`
);
expect(new Set(operations).size === operations.length, 'flatwrite-api: duplicate method/path operation');

for (const { file, data } of apiParsed) {
  const method = String(data.http?.method || '').toUpperCase();
  const url = String(data.http?.url || '');
  const headers = Object.fromEntries((data.headers || []).filter((header) => header.enabled !== false).map((header) => [header.name.toLowerCase(), header.value]));
  if (method === 'POST' && ['/render', '/extract', '/assist'].some((suffix) => url.endsWith(suffix))) {
    expect(headers['x-api-key'] === '{{apiKey}}', `${rel(file)}: authenticated HTTP request must use X-Api-Key: {{apiKey}}`);
    expect(!headers.authorization, `${rel(file)}: Bearer/Authorization auth is not allowed`);
  }
  if (url.endsWith('/extract') && method === 'POST') {
    expect(data.http?.body === 'multipartForm', `${rel(file)}: /extract must use multipart form data`);
    expect((data.body?.multipartForm || []).some((field) => field.name === 'file' && field.type === 'file'), `${rel(file)}: multipart body must contain a file field`);
  }
}

const requiredApiEnvs = ['Render.bru', 'Assist.bru', 'Extract.bru', 'example.bru'];
for (const name of requiredApiEnvs) expect(fs.existsSync(path.join(apiRoot, 'environments', name)), `flatwrite-api: missing environment ${name}`);

const requiredWebEnvs = ['Production.bru', 'example.bru'];
for (const name of requiredWebEnvs) expect(fs.existsSync(path.join(webRoot, 'environments', name)), `flatwrite-webmcp: missing environment ${name}`);

const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
expect(gitignore.includes('bruno/*/environments/Local.bru'), '.gitignore: Local.bru environments must remain untracked');
expect(gitignore.includes('bruno/.openapi-import/'), '.gitignore: disposable OpenAPI importer output must remain untracked');

const webRequests = filesUnder(path.join(webRoot, 'webmcp')).filter((file) => file.endsWith('.bru'));
const webParsed = webRequests.map((file) => ({ file, data: parseBru(file), source: fs.readFileSync(file, 'utf8') })).filter((item) => item.data);
const stubs = webParsed.filter(({ data }) => String(data.meta?.tags || '').includes('browser-only'));
const runnable = webParsed.filter(({ data }) => String(data.meta?.tags || '').includes('http-backed'));
const unsupported = webParsed.filter(({ data }) => String(data.meta?.tags || '').includes('unsupported-http'));
const webmcpSource = fs.readFileSync(path.join(root, 'public', 'webmcp-tools.js'), 'utf8');
const manifestToolNames = [...webmcpSource.matchAll(/"name":\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
const uniqueToolNames = [...new Set(manifestToolNames)];
const nonBrowserToolNames = new Set(['render_markdown', 'list_render_options', 'assist_document']);
const expectedStubNames = uniqueToolNames.filter((name) => !nonBrowserToolNames.has(name)).sort();
const actualStubNames = stubs.map(({ file }) => path.basename(file, '.bru').replace(/-/g, '_').replace(/_stub$/, '')).sort();
expect(
  JSON.stringify(actualStubNames) === JSON.stringify(expectedStubNames),
  `flatwrite-webmcp: browser-only stubs differ from webmcp-tools.js; expected [${expectedStubNames.join(', ')}], found [${actualStubNames.join(', ')}]`
);
expect(runnable.length === 4, `flatwrite-webmcp: expected 4 verified HTTP-backed requests, found ${runnable.length}`);
expect(unsupported.length === 1, `flatwrite-webmcp: expected one unsupported HTTP discovery placeholder, found ${unsupported.length}`);
expect(webParsed.length === runnable.length + unsupported.length + expectedStubNames.length, 'flatwrite-webmcp: unexpected unclassified request/stub files');
for (const { file, data, source } of stubs) {
  expect(data.meta?.['webmcp-type'] === 'webmcp-side-effect', `${rel(file)}: missing webmcp-side-effect metadata`);
  expect(source.includes('bru.runner.skipRequest()'), `${rel(file)}: browser-only stub must skip CLI execution`);
}
for (const { file, data } of runnable) {
  expect(Boolean(data.tests), `${rel(file)}: HTTP-backed WebMCP request must include tests`);
}
for (const { file, data, source } of unsupported) {
  expect(Boolean(data.tests), `${rel(file)}: documented discovery contract must include a tests block`);
  expect(source.includes('bru.runner.skipRequest()'), `${rel(file)}: unsupported HTTP placeholder must skip execution`);
}

const apiCollection = fs.readFileSync(path.join(apiRoot, 'collection.bru'), 'utf8');
const webCollection = fs.readFileSync(path.join(webRoot, 'collection.bru'), 'utf8');
for (const [name, source] of [['flatwrite-api', apiCollection], ['flatwrite-webmcp', webCollection]]) {
  expect(source.includes("Math.floor(Date.now() / 1000)"), `${name}: token expiry must compare Unix seconds`);
  expect(source.includes("prefix = isAssist ? 'assist' : isExtract ? 'extract' : 'render'"), `${name}: tokens must be minted per host/scope`);
  expect(source.includes("Origin: bru.getEnvVar('browserOrigin')"), `${name}: token mint must send an allowed Origin`);
  expect(source.includes("typeof body.token !== 'string'"), `${name}: token issuer response must be validated before caching`);
  expect(source.includes("bru.sleep(remainingMs)"), `${name}: rate-limit backoff guard is missing`);
  expect(!source.includes('setCollectionVar'), `${name}: transient credentials/state must not be persisted to collection.bru`);
  expect(!/mock-(?:assist|mcp)-token/.test(source), `${name}: mock token leaked into collection variables`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
expect(packageJson.devDependencies?.['@usebruno/cli'] === '^4.0.0', 'package.json: @usebruno/cli ^4.0.0 is missing');
for (const script of ['bruno:import', 'bruno:run:api', 'bruno:run:webmcp', 'bruno:lint']) {
  expect(Boolean(packageJson.scripts?.[script]), `package.json: missing ${script} script`);
}

if (errors.length) {
  console.error(`Bruno validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Bruno validation passed: ${apiParsed.length} API operations, ${runnable.length} runnable WebMCP requests, ${unsupported.length} documented unsupported request, ${stubs.length} browser-only stubs.`);
