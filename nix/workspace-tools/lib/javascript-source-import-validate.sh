# Sourced by the JavaScript source importer; all producer reads happen here.
fail() {
  jq -cn --arg check "$1" '{error:"javascript-product-import",check:$check}' >&2
  exit 1
}
check() {
  jq -e --slurpfile facts "$facts" "$2" "$descriptor" >/dev/null || fail "$1"
}
check descriptor-fields 'keys == ["externalCapabilities","externalModules","integrity","modulePath","platform","productKind","productName","provenance","runtimeContract","runtimeContractVersion","runtimeKind","schema","sizeBytes","target"]'
check schema '.schema == "effect-utils/javascript-product/v2"'
check product-name '.productName == $facts[0].expectedProductName'
check product-kind '.productKind == $facts[0].expectedProductKind'
check runtime-kind '.runtimeKind == $facts[0].expectedRuntimeKind and (.runtimeKind == "bun" or .runtimeKind == "node")'
check runtime-contract '.runtimeContract == $facts[0].expectedRuntimeContract'
check runtime-contract-version '.runtimeContractVersion == $facts[0].expectedRuntimeContractVersion'
check platform '.platform == {abi:"any",architecture:"any",os:"any"}'
check module-path '.modulePath == $facts[0].expectedModulePath and (.modulePath | test("^[A-Za-z0-9][A-Za-z0-9._+-]*(/[A-Za-z0-9][A-Za-z0-9._+-]*)*$"))'
check external-capabilities '(.externalCapabilities | sort) == ($facts[0].expectedExternalCapabilities | sort)'
check external-modules '(.externalModules | sort) == ($facts[0].expectedExternalModules | sort)'
check payload-size '(.sizeBytes | type) == "number" and .sizeBytes > 0 and .sizeBytes == (.sizeBytes | floor)'
check integrity '(.integrity | type) == "string" and (.integrity | test("^sha256-[A-Za-z0-9+/]{43}=$"))'
actual="$(sha256sum "$artifact" | cut -d ' ' -f 1)"
provenance="$source_product/provenance.json"
expected="$(jq -er '.productDigest | select(test("^[0-9a-f]{64}$"))' "$provenance")" || fail provenance-digest
[ "$actual" = "$expected" ] || fail module-digest
integrity="sha256-$(openssl dgst -sha256 -binary "$artifact" | openssl base64 -A)"
[ "$integrity" = "$(jq -er .integrity "$descriptor")" ] || fail descriptor-integrity
[ "$(wc -c < "$artifact" | tr -d ' ')" = "$(jq -er .sizeBytes "$descriptor")" ] || fail descriptor-size
if jq -e '.checkProducerCommit' "$facts" >/dev/null; then
  expected="$(jq -er '.expectedProducerCommit | select(type == "string") | select(test("^[0-9a-f]{40}$"))' "$facts")" || fail missing-producer-commit
  [ "$(jq -er .producerCommit "$provenance")" = "$expected" ] || fail producer-commit
fi
