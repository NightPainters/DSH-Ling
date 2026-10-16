import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { constants, realpathSync, statSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { normalizeLibraryLimits, normalizeTextLf, resolveJsonPointer } from './library-store.js';

const LIMIT_KEYS = Object.freeze([
  'sourceMaxBytes', 'selectedTextMaxBytes', 'selectedTextMaxLines', 'checkTimeoutMs', 'checkConcurrency',
]);
const CONFIG_KEYS = new Set(['codeRoots', 'officialUrls', 'limits', 'resolver', 'requester', ...LIMIT_KEYS]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

class SourceFailure extends Error {
  constructor(code, cancelled = false) {
    super(code);
    this.code = code;
    this.cancelled = cancelled;
  }
}
const refuse = (reason, extra = {}) => ({ ok: false, state: 'unknown', recorded: false, reason, ...extra });
const stop = (signal, deadline) => {
  if (signal.aborted) throw signal.reason;
  if (deadline !== undefined && performance.now() >= deadline) throw new SourceFailure('timeout');
};

// A trusted injected hook cannot hold a check open by ignoring cancellation.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolvePromise, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

// ⚠️ 下面三个是**导出**的(2026-10-15):SQLite 接入通道(library-sqlite.js)要用**同一套**根校验。
// 复制第二份的代价是"将来会漂"——根校验只该有一套实现(选项文档 §11.6 B.2 拍板:导出复用)。
export function contained(root, candidate) {
  const rest = relative(root, candidate);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

export function localPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !isAbsolute(value)) return false;
  if (value.split(/[\\/]/).includes('..')) return false;
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')) return false;
  }
  return true;
}

export function normalizeRoots(raw = []) {
  if (!Array.isArray(raw) || raw.length > 256) throw new TypeError('codeRoots must be an array of at most 256 absolute local directories');
  return Object.freeze(raw.map((entry) => {
    if (!localPath(entry)) throw new TypeError('codeRoots must contain absolute local paths without traversal');
    const path = resolve(entry);
    // Use the same native resolution as fs.promises.realpath (not the JS
    // realpathSync fallback, which can preserve Windows junction spelling).
    const real = realpathSync.native(path);
    if (!statSync(real).isDirectory()) throw new TypeError('codeRoots entries must be existing directories');
    return Object.freeze({ path, real });
  }));
}

function ipv6Words(address) {
  const sides = address.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const words = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return words.map((part) => Number.parseInt(part, 16));
}

function publicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6 && !address.includes('.')) {
    const [a, b] = ipv6Words(address);
    // Only global unicast, excluding special-use, documentation and 6to4 ranges.
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002
      && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
      && !(a === 0x3fff && b < 0x1000);
  }
  return false;
}

function authorizedUrl(value) {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > 4096
    || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new SourceFailure('invalid_url');
  let url;
  try { url = new URL(value); } catch { throw new SourceFailure('invalid_url'); }
  if (url.protocol !== 'https:') throw new SourceFailure('https_required');
  if (url.username || url.password) throw new SourceFailure('url_credentials_forbidden');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal')) throw new SourceFailure('private_target');
  if (isIP(host) && !publicAddress(host)) throw new SourceFailure('private_target');
  return url;
}

function normalizeUrls(raw = []) {
  if (!Array.isArray(raw) || raw.length > 1000) throw new TypeError('officialUrls must be an array of at most 1000 exact HTTPS URLs');
  return new Set(raw.map((value) => {
    try { return authorizedUrl(value).href; } catch (error) { throw new TypeError(`officialUrls: ${error.code}`); }
  }));
}

function normalizeConfig(store, config) {
  if (!plain(config)) throw new TypeError('checker config must be a plain object');
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new RangeError(`unknown checker config key: ${key}`);
  }
  const overrides = config.limits ?? {};
  if (!plain(overrides)) throw new TypeError('checker limits must be a plain object');
  for (const key of Object.keys(overrides)) {
    if (!LIMIT_KEYS.includes(key)) throw new RangeError(`unknown checker limit: ${key}`);
  }
  const supplied = { ...overrides };
  for (const key of LIMIT_KEYS) {
    if (!own(config, key)) continue;
    if (own(supplied, key)) throw new RangeError(`duplicate checker limit: ${key}`);
    supplied[key] = config[key];
  }
  const normalized = normalizeLibraryLimits({ ...store.limits, ...supplied });
  const limits = Object.freeze(Object.fromEntries(LIMIT_KEYS.map((key) => [key, normalized[key]])));
  for (const key of ['resolver', 'requester']) {
    if (config[key] !== undefined && typeof config[key] !== 'function') throw new TypeError(`${key} must be a function`);
  }
  return {
    limits, roots: normalizeRoots(config.codeRoots), urls: normalizeUrls(config.officialUrls),
    resolver: config.resolver ?? defaultResolver, requester: config.requester ?? defaultRequester,
    injected: config.resolver !== undefined || config.requester !== undefined,
  };
}

/** Validate administrator configuration before any database is opened. */
export function validateLibraryCheckerConfig(config = {}, limits = {}) {
  normalizeConfig({ limits }, config);
}

async function defaultResolver(hostname) {
  return lookup(hostname, { all: true, verbatim: true });
}

function comparableAddress(address) {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return isIP(lower) === 6 ? ipv6Words(lower).join(':') : lower;
}

// No agent pooling, redirects, proxy environment handling or second DNS lookup.
function defaultRequester(url, { address, family, signal }) {
  return new Promise((resolvePromise, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, signal,
      headers: { Accept: 'application/json, text/plain, text/markdown, text/csv', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      resolvePromise({ statusCode: response.statusCode, headers: response.headers, body: response, url: url.href });
    });
    req.once('error', reject);
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const remote = socket.remoteAddress;
        if (!remote || comparableAddress(remote) !== comparableAddress(address)) {
          req.destroy(new SourceFailure('connection_address_mismatch'));
        }
      });
    });
    req.end();
  });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function verifyFilePath(path, handle, before, root, signal, deadline) {
  stop(signal, deadline);
  const now = await realpath(path);
  if (now !== path || !contained(root.real, now) || !sameFile(before, await stat(now))
    || !sameFile(before, await handle.stat())) throw new SourceFailure('source_changed');
  stop(signal, deadline);
}

async function readCode(source, config, evidence, signal, deadline) {
  if (!localPath(source)) throw new SourceFailure('absolute_local_path_required');
  const lexical = resolve(source);
  const roots = config.roots.filter((root) => contained(root.path, lexical) || contained(root.real, lexical));
  if (!roots.length) throw new SourceFailure('code_root_not_allowed');
  const actual = await realpath(lexical);
  stop(signal, deadline);
  const root = roots.find((entry) => contained(entry.real, actual));
  if (!root) throw new SourceFailure('symlink_escape');
  evidence.actual_source = actual;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(actual, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new SourceFailure('source_not_regular_file');
    if (before.size > config.limits.sourceMaxBytes) throw new SourceFailure('source_too_large');
    await verifyFilePath(actual, handle, before, root, signal, deadline);
    const chunks = [];
    let total = 0;
    while (true) {
      stop(signal, deadline);
      const buffer = Buffer.allocUnsafe(Math.min(65536, config.limits.sourceMaxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      stop(signal, deadline);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > config.limits.sourceMaxBytes) throw new SourceFailure('source_too_large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await verifyFilePath(actual, handle, before, root, signal, deadline);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function header(headers, name) {
  if (!plain(headers)) throw new SourceFailure('invalid_response_headers');
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new SourceFailure('invalid_response_headers');
  return value;
}

function safeMime(value) {
  if (!value) return false;
  const parts = value.split(';').map((part) => part.trim().toLowerCase());
  const type = parts.shift();
  if (!['application/json', 'text/plain', 'text/markdown', 'text/csv'].includes(type)) return false;
  let charset = null;
  for (const part of parts) {
    const match = /^charset\s*=\s*(?:"(utf-8|utf8)"|(utf-8|utf8))$/.exec(part);
    if (!match || charset !== null) return false;
    charset = match[1] ?? match[2];
  }
  return charset !== null || type === 'application/json' || type === 'text/plain';
}

async function resolveAddress(url, config, signal, deadline) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  let records;
  try { records = await abortable(config.resolver(hostname, { signal }), signal); }
  catch (error) { if (signal.aborted) throw signal.reason; throw new SourceFailure('dns_failure'); }
  stop(signal, deadline);
  if (!Array.isArray(records) || records.length === 0 || records.length > 64) throw new SourceFailure('dns_invalid_result');
  for (const record of records) {
    if (!plain(record) || !publicAddress(record.address) || isIP(record.address) !== record.family) {
      throw new SourceFailure('dns_private_or_invalid_address');
    }
  }
  return { address: records[0].address, family: records[0].family };
}

function discardBody(response) {
  if (response?.body && typeof response.body.destroy === 'function') response.body.destroy();
}

async function readOfficial(source, config, evidence, signal, deadline) {
  const url = authorizedUrl(source);
  if (!config.urls.has(url.href)) throw new SourceFailure('official_url_not_allowed');
  const address = await resolveAddress(url, config, signal, deadline);
  stop(signal, deadline);
  evidence.actual_source = url.href;
  const pending = Promise.resolve(config.requester(new URL(url.href), {
    ...address, signal, maxBytes: config.limits.sourceMaxBytes, timeoutMs: config.limits.checkTimeoutMs,
  }));
  pending.then((response) => { if (signal.aborted) discardBody(response); }, () => {});
  let response;
  try {
    response = await abortable(pending, signal);
    stop(signal, deadline);
    if (!response || typeof response !== 'object') throw new SourceFailure('invalid_http_response');
    if (response.url !== undefined && response.url !== url.href) {
      throw new SourceFailure('unexpected_response_url');
    }
    if (response.statusCode >= 300 && response.statusCode < 400) throw new SourceFailure('redirect_forbidden');
    if (response.statusCode !== 200) throw new SourceFailure('http_status_not_ok');
    if (!safeMime(header(response.headers, 'content-type'))) throw new SourceFailure('unsupported_mime');
    const encoding = header(response.headers, 'content-encoding');
    if (encoding && encoding.trim().toLowerCase() !== 'identity') throw new SourceFailure('unsupported_content_encoding');
    const length = header(response.headers, 'content-length');
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
      throw new SourceFailure('invalid_content_length');
    }
    if (length !== null && Number(length) > config.limits.sourceMaxBytes) throw new SourceFailure('source_too_large');
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw new SourceFailure('invalid_response_body');
    const chunks = [];
    let total = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      while (true) {
        stop(signal, deadline);
        const next = await abortable(iterator.next(), signal);
        stop(signal, deadline);
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) throw new SourceFailure('invalid_response_chunk');
        total += chunk.byteLength;
        if (total > config.limits.sourceMaxBytes) throw new SourceFailure('source_too_large');
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      // Do not await an uncooperative injected iterator's return during cancellation.
      if (typeof iterator.return === 'function') {
        try { Promise.resolve(iterator.return()).catch(() => {}); } catch { /* cleanup only */ }
      }
    }
    stop(signal, deadline);
    if (length !== null && total !== Number(length)) throw new SourceFailure('incomplete_source');
    return Buffer.concat(chunks, total);
  } finally {
    discardBody(response);
  }
}

function selectedBytes(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, (_key, member) => {
      if (typeof member === 'number' && !Number.isFinite(member)) throw new SourceFailure('nonfinite_json_value');
      if (Object.is(member, -0)) throw new SourceFailure('non_roundtrippable_json_value');
      if (member === undefined || ['bigint', 'function', 'symbol'].includes(typeof member)) {
        throw new SourceFailure('invalid_selected_value');
      }
      return member;
    });
  } catch (error) {
    if (error instanceof SourceFailure) throw error;
    throw new SourceFailure('invalid_selected_value');
  }
  if (typeof text !== 'string') throw new SourceFailure('invalid_selected_value');
  return Buffer.byteLength(text);
}

function boundedSelection(value, limits) {
  if (selectedBytes(value) > limits.selectedTextMaxBytes) throw new SourceFailure('selection_too_large');
  if (typeof value === 'string') {
    let count = 1;
    for (const _match of value.matchAll(/\r\n|\r|\n/g)) {
      count += 1;
      if (count > limits.selectedTextMaxLines) throw new SourceFailure('selection_too_many_lines');
    }
  }
}

function lines(text, locator) {
  let line = 1;
  let start = locator.start === 1 ? 0 : null;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    if (line === locator.end) return text.slice(start, match.index);
    line += 1;
    if (line === locator.start) start = match.index + match[0].length;
  }
  if (line === locator.end && start !== null) return text.slice(start);
  throw new SourceFailure('missing_lines');
}

function validateSpec(spec, limits) {
  if (spec === null || spec === undefined) throw new SourceFailure('no_check_spec');
  if (!plain(spec) || Object.keys(spec).some((key) => !['locator', 'expected', 'comparison'].includes(key))
    || !own(spec, 'expected') || !['exact', 'text-lf'].includes(spec.comparison) || !plain(spec.locator)) {
    throw new SourceFailure('invalid_check_spec');
  }
  const loc = spec.locator;
  if (loc.kind === 'lines') {
    if (Object.keys(loc).some((key) => !['kind', 'start', 'end'].includes(key))
      || !Number.isSafeInteger(loc.start) || !Number.isSafeInteger(loc.end)
      || loc.start < 1 || loc.end < loc.start || typeof spec.expected !== 'string') {
      throw new SourceFailure('invalid_lines_locator');
    }
    if (loc.end - loc.start + 1 > limits.selectedTextMaxLines) throw new SourceFailure('selection_too_many_lines');
  } else if (loc.kind === 'json-pointer') {
    if (Object.keys(loc).some((key) => !['kind', 'pointer'].includes(key))
      || typeof loc.pointer !== 'string' || (loc.pointer !== '' && !loc.pointer.startsWith('/'))
      || /~(?![01])/.test(loc.pointer)) throw new SourceFailure('invalid_json_pointer');
  } else throw new SourceFailure('unsupported_locator');
  boundedSelection(spec.expected, limits);
}

function observe(bytes, spec, limits) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SourceFailure('invalid_utf8'); }
  let value;
  if (spec.locator.kind === 'lines') value = lines(text, spec.locator);
  else {
    let doc;
    try { doc = JSON.parse(text); } catch { throw new SourceFailure('invalid_json'); }
    const result = resolveJsonPointer(doc, spec.locator.pointer);
    if (!result.found) throw new SourceFailure(result.invalid ? 'invalid_json_pointer' : 'missing_json_pointer');
    value = result.value;
    if (typeof value === 'number' && !Number.isFinite(value)) throw new SourceFailure('nonfinite_json_value');
  }
  boundedSelection(value, limits);
  return value;
}

function evidenceFor(item) {
  return {
    requested_source: item.source_ref, actual_source: null, source_hash: null,
    locator: item.check_spec?.locator ?? null, expected: item.check_spec?.expected ?? null,
    observed: null, comparison: item.check_spec?.comparison ?? null,
    checked_at: null, state: 'unknown', reason: null,
  };
}

/** Standalone checker. Resolver/requester hooks are trusted administrator code, never item payload. */
export class LibraryChecker {
  #store;
  #config;
  #active = new Map();
  #closed = false;
  #closing = null;

  constructor(store, config = {}) {
    if (!store || typeof store.get !== 'function' || typeof store.recordCheck !== 'function') {
      throw new TypeError('LibraryChecker requires store.get and store.recordCheck');
    }
    this.#store = store;
    this.#config = normalizeConfig(store, config);
  }

  status() {
    return {
      closed: this.#closed, activeCount: this.#active.size, limits: { ...this.#config.limits },
      codeRootCount: this.#config.roots.length, officialUrlCount: this.#config.urls.size,
      transport: this.#config.injected ? 'trusted-injected' : 'native-https',
    };
  }

  async check(id, options = {}) {
    if (this.#closed) return refuse('closed');
    if (!plain(options) || Object.keys(options).some((key) => key !== 'signal')) return refuse('invalid_options');
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return refuse('invalid_signal');
    if (signal?.aborted) return refuse('aborted', { cancelled: true });
    // Store failures and exceptions stay store failures and exceptions.
    const found = this.#store.get(id);
    if (!found.ok) return { ...found, state: 'unknown', recorded: false };
    const item = found.item;
    const key = item.id;
    if (this.#active.has(key)) return refuse('in_flight', { item_id: key });
    if (this.#active.size >= this.#config.limits.checkConcurrency) return refuse('concurrency_limit', { item_id: key });
    const controller = new AbortController();
    const entry = { controller, done: null };
    this.#active.set(key, entry);
    entry.done = this.#run(item, signal, controller).finally(() => this.#active.delete(key));
    return entry.done;
  }

  async #run(item, callerSignal, controller) {
    const evidence = evidenceFor(item);
    const onAbort = () => controller.abort(new SourceFailure('aborted', true));
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    if (callerSignal?.aborted) onAbort();
    const deadline = performance.now() + this.#config.limits.checkTimeoutMs;
    const timer = setTimeout(() => controller.abort(new SourceFailure('timeout')), this.#config.limits.checkTimeoutMs);
    try {
      try {
        await abortable(this.#evaluate(item, evidence, controller.signal, deadline), controller.signal);
        stop(controller.signal, deadline);
      } catch (error) {
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        evidence.state = 'unknown';
        evidence.reason = failure instanceof SourceFailure ? failure.code : 'source_io_failure';
      }
      // Timers cannot interrupt synchronous decoding/comparison: check the monotonic
      // deadline immediately before certification and cancel any residual I/O.
      if (!controller.signal.aborted && performance.now() >= deadline) {
        controller.abort(new SourceFailure('timeout'));
      }
      if (controller.signal.aborted) {
        evidence.state = 'unknown';
        evidence.reason = controller.signal.reason?.code ?? 'aborted';
      }
      evidence.checked_at = new Date().toISOString();
      if (controller.signal.aborted && controller.signal.reason?.cancelled) {
        return refuse(evidence.reason, { cancelled: true, item_id: item.id, item_hash: item.content_hash, evidence });
      }
      const record = this.#store.recordCheck(item.id, item.content_hash, evidence);
      if (!record.ok) return { ...record, state: evidence.state, recorded: false, evidence, record };
      return {
        ok: true, item_id: item.id, item_hash: item.content_hash, state: evidence.state,
        reason: evidence.reason, recorded: true, adopted: record.adopted, evidence, record,
      };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }

  async #evaluate(item, evidence, signal, deadline) {
    stop(signal, deadline);
    validateSpec(item.check_spec, this.#config.limits);
    stop(signal, deadline);
    let bytes;
    if (item.source_kind === 'our-code') bytes = await readCode(item.source_ref, this.#config, evidence, signal, deadline);
    else if (item.source_kind === 'official-doc') bytes = await readOfficial(item.source_ref, this.#config, evidence, signal, deadline);
    else throw new SourceFailure('unsupported_source_kind');
    stop(signal, deadline);
    evidence.source_hash = sha256(bytes);
    const observed = observe(bytes, item.check_spec, this.#config.limits);
    evidence.observed = observed;
    let equal;
    if (item.check_spec.comparison === 'text-lf') {
      if (typeof observed !== 'string' || typeof item.check_spec.expected !== 'string') {
        throw new SourceFailure('comparison_requires_text');
      }
      equal = normalizeTextLf(observed) === normalizeTextLf(item.check_spec.expected);
    } else equal = isDeepStrictEqual(observed, item.check_spec.expected);
    stop(signal, deadline);
    evidence.state = equal ? 'ok' : 'wrong';
    evidence.reason = equal ? null : 'declared_comparison_mismatch';
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const entries = [...this.#active.values()];
    for (const entry of entries) entry.controller.abort(new SourceFailure('closed', true));
    this.#closing = Promise.allSettled(entries.map((entry) => entry.done)).then(() => ({ ok: true, closed: true }));
    return this.#closing;
  }
}
