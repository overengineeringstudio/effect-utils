// Usage: node rust/effect-rust-fixtures/workerd-smoke-config.mjs <wasm-package> <output.capnp> [port]
// Then: workerd serve <output.capnp>; curl http://127.0.0.1:<port>/
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [directory, output, port = '8787'] = process.argv.slice(2)
if (directory === undefined || output === undefined) throw new Error('Pass the wasm package and config output path')
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
`]).toString()
const manifest = JSON.parse(readFileSync(resolve(product, 'package.json'), 'utf8'))
// Resolve actual public exports, then use canonical module paths so their relative
// imports resolve identically to a bundler's workerd output.
const root = manifest.exports['./workerd']
const loader = manifest.exports['./workerd/load']
const canonical = (path) => `product/${path.slice(2)}`
const source = readFileSync(new URL('./workerd-smoke.mjs', import.meta.url), 'utf8')
  .replaceAll("'effect_rust_fixture/workerd'", JSON.stringify(`./${canonical(root)}`))
  .replaceAll("'effect_rust_fixture/workerd/load'", JSON.stringify(`./${canonical(loader)}`))
const modules = [
  `(name = "main.mjs", esModule = ${JSON.stringify(source)})`,
  `(name = "wasm-scheduler-smoke.js", esModule = ${JSON.stringify(scheduler)})`,
  ...[root, loader, './web/inline-glue.js', './web/inline-factory.js'].map((path) =>
    `(name = ${JSON.stringify(canonical(path))}, esModule = ${JSON.stringify(readFileSync(resolve(product, path), 'utf8'))})`,
  ),
  `(name = ${JSON.stringify(`product/web/${manifest.name}_bg.wasm`)}, wasm = 0x"${readFileSync(resolve(product, 'web', `${manifest.name}_bg.wasm`)).toString('hex')}")`,
]
writeFileSync(output, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    compatibilityDate = "2025-01-01",
    modules = [${modules.join(',\n')}]
  ))],
  sockets = [(name = "http", address = "127.0.0.1:${Number(port)}", http = (), service = "main")]
);
`)
console.log(`workerd serve ${output}`)
