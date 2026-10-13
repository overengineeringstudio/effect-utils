// Usage: node rust/effect-rust-fixtures/browser-smoke-server.mjs <generated-wasm-package> [port]
// Open the printed URL in real Chromium; the page reports window.smokeResult / window.smokeError.
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const [directory, port = '0'] = process.argv.slice(2)
if (directory === undefined) throw new Error('Pass the generated wasm package directory')
const product = resolve(directory)
const fixture = dirname(fileURLToPath(import.meta.url))
const scheduler = execFileSync('bun', ['-e', `
  const result = await Bun.build({
    entrypoints: [${JSON.stringify(resolve(fixture, 'wasm-scheduler-smoke.ts'))}], target: 'browser',
    plugins: [{ name: 'fixture-runtime', setup(build) {
      build.onResolve({ filter: /^@overeng\\/effect-rust$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: ${JSON.stringify(`export * as Interop from ${JSON.stringify(resolve(fixture, '../../packages/@overeng/effect-rust/src/runtime/interop.ts'))}`)}, loader: 'ts'
      }));
    }}],
  });
  if (!result.success) throw new AggregateError(result.logs, 'Scheduler bundle failed');
  process.stdout.write(await result.outputs[0].text());
`])
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (pathname === '/smoke/wasm-scheduler-smoke.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    response.end(scheduler)
    return
  }
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><title>effect-rust browser delivery smoke</title><pre id="result">Running</pre><script type="module">
      import { runBrowserSmoke } from '/smoke/browser-smoke.mjs';
      try {
        window.smokeResult = await runBrowserSmoke(new URL('/product/', location.href));
        document.querySelector('#result').textContent = JSON.stringify(window.smokeResult, null, 2);
      } catch (cause) {
        window.smokeError = String(cause.stack ?? cause);
        document.querySelector('#result').textContent = window.smokeError;
      }
    </script>`)
    return
  }
  const root = pathname.startsWith('/product/') ? product : fixture
  const prefix = root === product ? '/product/' : '/smoke/'
  const file = resolve(root, decodeURIComponent(pathname.slice(prefix.length)))
  if (pathname.startsWith(prefix) === false || file.startsWith(`${root}${sep}`) === false) {
    response.writeHead(404).end()
    return
  }
  try {
    if ((await stat(file)).isFile() === false) throw new Error('Not a file')
    const mime = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    createReadStream(file).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
})
server.listen(Number(port), '127.0.0.1', () => {
  console.log(`Browser delivery smoke: http://127.0.0.1:${server.address().port}/`)
})
