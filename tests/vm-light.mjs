// vm-light: run a browser script with injected globals, capture module exports.
import vm from 'node:vm';

export async function contextify(src, globals) {
  let captured = null;
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    URL,
    fetch: globals.fetch || (async () => ({ ok: false, json: async () => ({}), blob: async () => new Blob() })),
    Blob: typeof Blob !== 'undefined' ? Blob : class Blob { constructor() {} },
    document: globals.document,
    navigator: { userAgent: 'node-test' },
    location: { href: 'http://localhost' },
  };
  sandbox.window = globals.window || sandbox;
  if (!sandbox.window.__ModuleLoader__) {
    sandbox.window.__ModuleLoader__ = {
      load(opts) {
        captured = opts;
        if (typeof opts.factory === 'function') {
          const requireStub = (id) => (id === 'react' ? sandbox.__react : {});
          const module = { exports: {} };
          const ret = opts.factory(requireStub);
          captured.exports = ret && ret.default ? ret.default : ret;
        }
      },
    };
  } else {
    sandbox.window.__ModuleLoader__.load = (opts) => {
      captured = opts;
      if (typeof opts.factory === 'function') {
        const requireStub = (id) => (id === 'react' ? sandbox.__react : {});
        captured.exports = opts.factory(requireStub);
      }
    };
  }
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  sandbox.__react = globals.__react || { createElement: () => ({}), useEffect: () => {} };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'client.js' });
  if (!captured) throw new Error('ModuleLoader.load 未被调用');
  return captured.exports || null;
}
