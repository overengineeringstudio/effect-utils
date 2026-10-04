// Usage: node rust/effect-rust-fixtures/workerd-smoke-config.mjs <wasm-package> <output.capnp> [port]
// Then: workerd serve <output.capnp>; curl http://127.0.0.1:<port>/
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [directory, output, port = '8787'] = process.argv.slice(2)
if (directory === undefined || output === undefined) throw new Error('Pass the wasm package and config output path')
const product = resolve(directory)
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
