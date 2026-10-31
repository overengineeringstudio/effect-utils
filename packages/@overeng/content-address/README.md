# @overeng/content-address

## Vite SSR source consumption

Vite externalizes dependencies for SSR by default. When using source-staged
packages, configure Vite to transform both this package and its runtime:

```ts
ssr: {
  noExternal: ['@overeng/content-address', '@overeng/effect-rust'],
}
```

Include every other source-staged package that imports `@overeng/effect-rust` in
`ssr.noExternal` too. Otherwise Node loads `src/*.ts` from `node_modules` and fails
with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
