import { canonicalJson } from '../schema/json.ts'
import { assertPortablePattern } from '../schema/pattern.ts'
import { reject, tagFields, type ContractIR, type Definition, type Field, type Type } from './ir.ts'
import { rustSupport } from './rust-template.ts'

/** Inputs and canonical values are JSON data, not pre-encoded JSON text. */
export interface RustVector {
  readonly contract: string
  readonly name: string
  readonly input: unknown
  readonly accept: boolean
  readonly canonical?: unknown
}
/** Crate naming and shared acceptance vectors for Rust emission. */
export interface RustOptions {
  readonly crateName?: string
  readonly vectors?: readonly RustVector[]
}
/** Cargo manifest and standalone Rust source for an admitted contract set. */
export interface RustOutput {
  readonly cargoToml: string
  readonly source: string
}

const keywords: Readonly<Record<string, true>> = Object.fromEntries(
  'as async await become box break const continue crate do dyn else enum extern false final fn for gen if impl in let loop macro match mod move mut override priv pub ref return self Self static struct super trait true try type typeof unsafe unsized use virtual where while yield abstract'
    .split(' ')
    .map((name) => [name, true]),
)
const reserved: Readonly<Record<string, true>> = Object.fromEntries(
  [
    'U8',
    'U16',
    'U32',
    'I32',
    'U64',
    'I64',
    'TimestampMillis',
    'Patch',
    'Null',
    'ValidationError',
    'StrictSeed',
    'Canonical',
    'String',
    'Option',
    'Vec',
    'Box',
    'BTreeMap',
    'Serialize',
    'Deserialize',
    'TAG_FIELDS',
    'tagged',
    'required',
    'present',
    'encode_json',
    'decode_json',
    'encode_frame',
    'decode_frame',
    'contract_vectors',
  ].map((name) => [name, true]),
)
// Escape actual characters, not JSON's escape sequences: a literal backslash-u must remain literal.
const literal = (value: string): string =>
  // eslint-disable-next-line eslint/no-control-regex -- Rust string literals must escape every ASCII control character while preserving literal backslashes.
  `"${value.replace(/[\\"\u0000-\u001f\u007f]/g, (character) => (character === '\\' ? '\\\\' : character === '"' ? '\\"' : `\\u{${character.charCodeAt(0).toString(16)}}`))}"`
const fieldName = (wire: string): string => {
  const base =
    wire
      .replace(
        /[A-Z]/g,
        (letter, index: number) => `${index === 0 ? '' : '_'}${letter.toLowerCase()}`,
      )
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'
  const name =
    /^[0-9]/.test(base) === true || ['self', 'super', 'crate'].includes(base) === true
      ? `field_${base}`
      : base
  return Object.hasOwn(keywords, name) === true ? `r#${name}` : name
}
const variantNames = (values: readonly string[]): readonly string[] => {
  const used = new Set<string>()
  return values.map((value, index) => {
    const base = value
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join('')
    let name =
      base.length === 0 || /^[0-9]/.test(base) === true || Object.hasOwn(keywords, base) === true
        ? `Variant${index}`
        : base
    if (used.has(name) === true) name = `${name}_${index}`
    used.add(name)
    return name
  })
}
const refs = ({ type, output }: { type: Type; output: Set<string> }): void => {
  switch (type.kind) {
    case 'ref':
      output.add(type.name)
      break
    case 'array':
      refs({ type: type.item, output })
      break
    case 'nullable':
    case 'patch':
      refs({ type: type.inner, output })
      break
    case 'record':
      refs({ type: type.key, output })
      refs({ type: type.value, output })
      break
  }
}

/** Emit one independent Cargo crate for the complete contract set. */
// eslint-disable-next-line overeng/named-args -- Preserve the public emitRust positional SDK signature.
export const emitRust = (ir: ContractIR, options: RustOptions = {}): RustOutput => {
  const crateName = options.crateName ?? ir.contract.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase()
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(crateName) === false)
    reject(
      '$/crateName',
      'Invalid Cargo package name',
      'Use an ASCII letter followed by letters, digits, underscores or hyphens',
    )
  // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
  const entries = Object.entries(ir.defs).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  // Every named definition is emitted as a public contract, including vector-only contracts.
  // Walk nested containers without following refs: their targets are scanned exactly once below.
  const features = { u64: false, i64: false, timestamp: false, patch: false, regex: false }
  const collectFeatures = (type: Type): void => {
    switch (type.kind) {
      case 'u64':
      case 'i64':
        features[type.kind] = true
        break
      case 'dateTime':
        features.timestamp = true
        features.regex = true
        break
      case 'patch':
        features.patch = true
        collectFeatures(type.inner)
        break
      case 'nullable':
        collectFeatures(type.inner)
        break
      case 'array':
        collectFeatures(type.item)
        break
      case 'record':
        collectFeatures(type.key)
        collectFeatures(type.value)
        break
    }
  }
  for (const [, definition] of entries) {
    if (definition.kind === 'alias') collectFeatures(definition.type)
    if (definition.kind === 'struct')
      for (const field of definition.fields) collectFeatures(field.type)
    if (definition.kind === 'string' && definition.pattern !== undefined) features.regex = true
  }
  const edges = new Map<string, Set<string>>()
  const rustNames: Record<string, string> = {}
  const emittedNames = new Set<string>()
  for (const [name, definition] of entries) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) === false ||
      Object.hasOwn(keywords, name) === true ||
      Object.hasOwn(reserved, name) === true
    ) {
      reject(
        `$/defs/${name}`,
        'Invalid or reserved Rust type identifier',
        'Use a unique Rust identifier that does not collide with generated wire helpers',
      )
    }
    const base = name
      .split('_')
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join('')
    const emitted = /^[A-Z]/.test(base) === true ? base : `Type${base}`
    if (Object.hasOwn(reserved, emitted) === true || emittedNames.has(emitted) === true)
      reject(
        `$/defs/${name}`,
        'Rust identifiers collide after UpperCamelCase normalization',
        'Choose identifiers with distinct UpperCamelCase spellings that do not collide with wire helpers',
      )
    emittedNames.add(emitted)
    Object.defineProperty(rustNames, name, { value: emitted, enumerable: true })
    const targets = new Set<string>()
    if (definition.kind === 'struct')
      for (const field of definition.fields) refs({ type: field.type, output: targets })
    if (definition.kind === 'alias') refs({ type: definition.type, output: targets })
    if (definition.kind === 'taggedUnion')
      for (const variant of definition.variants) targets.add(variant.ref)
    edges.set(name, targets)
    for (const target of targets)
      if (Object.hasOwn(ir.defs, target) === false)
        reject(
          `$/defs/${name}`,
          `Unknown reference ${target}`,
          'Include every referenced definition in the contract set',
        )
  }
  const reaches = ({ from, to }: { from: string; to: string }): boolean => {
    const seen = new Set<string>()
    const pending = [from]
    while (pending.length > 0) {
      const next = pending.pop()!
      if (next === to) return true
      if (seen.has(next) === true) continue
      seen.add(next)
      pending.push(...(edges.get(next) ?? []))
    }
    return false
  }
  const recursive = (name: string): boolean =>
    [...(edges.get(name) ?? [])].some((target) => reaches({ from: target, to: name }))
  const resolveAlias = ({
    type,
    seen = new Set<string>(),
  }: {
    type: Type
    seen?: Set<string>
  }): Type => {
    if (type.kind !== 'ref' || seen.has(type.name) === true) return type
    const definition = ir.defs[type.name]
    if (definition?.kind !== 'alias') return type
    seen.add(type.name)
    return resolveAlias({ type: definition.type, seen })
  }
  const keyAllowed = ({
    type,
    seen = new Set<string>(),
  }: {
    type: Type
    seen?: Set<string>
  }): boolean => {
    if (type.kind === 'string') return true
    if (type.kind !== 'ref' || seen.has(type.name) === true) return false
    seen.add(type.name)
    const definition = ir.defs[type.name]
    return (
      definition?.kind === 'string' ||
      definition?.kind === 'literals' ||
      (definition?.kind === 'alias' && keyAllowed({ type: definition.type, seen }))
    )
  }
  const rustType = ({
    type,
    owner,
    direct,
    path,
  }: {
    type: Type
    owner: string
    direct: boolean
    path: string
  }): string => {
    switch (type.kind) {
      case 'string':
        return 'String'
      case 'bool':
        return 'bool'
      case 'u64':
        return 'U64'
      case 'i64':
        return 'I64'
      case 'dateTime':
        return 'TimestampMillis'
      case 'null':
        return 'Null'
      case 'int':
        return { u8: 'U8', u16: 'U16', u32: 'U32', i32: 'I32' }[type.width]
      case 'nullable':
        return `Option<${rustType({ type: type.inner, owner, direct, path: `${path}/inner` })}>`
      case 'patch':
        return `Patch<${rustType({ type: type.inner, owner, direct, path: `${path}/inner` })}>`
      case 'array':
        return `Vec<${rustType({ type: type.item, owner, direct: false, path: `${path}/item` })}>`
      case 'record': {
        if (keyAllowed({ type: type.key }) === false)
          reject(
            `${path}/key`,
            'Record key is not a string contract',
            'Use String, a validating string newtype or a string literal enum',
          )
        return `std::collections::BTreeMap<${rustType({ type: type.key, owner, direct: false, path: `${path}/key` })}, ${rustType({ type: type.value, owner, direct: false, path: `${path}/value` })}>`
      }
      case 'ref':
        return direct === true && reaches({ from: type.name, to: owner }) === true
          ? `Box<${rustNames[type.name]}>`
          : rustNames[type.name]!
    }
  }
  const fieldInfo = ({
    field,
    owner,
  }: {
    field: Field
    owner: string
  }): { name: string; type: string; patch: boolean; attributes: string } => {
    const name = fieldName(field.wire)
    const patch = resolveAlias({ type: field.type }).kind === 'patch'
    const inner = rustType({
      type: field.type,
      owner,
      direct: true,
      path: `$/defs/${owner}/${field.wire}`,
    })
    const type = field.presence === 'optional' && patch === false ? `Option<${inner}>` : inner
    const serde = [`rename = ${literal(field.wire)}`]
    if (patch === true) {
      const skip =
        field.type.kind === 'ref' && recursive(field.type.name) === true
          ? `${rustNames[field.type.name]}::is_absent`
          : 'Patch::is_absent'
      serde.push('default', `skip_serializing_if = ${literal(skip)}`)
    } else if (field.presence === 'optional')
      serde.push(
        'default',
        'skip_serializing_if = "Option::is_none"',
        'deserialize_with = "present"',
      )
    else serde.push('deserialize_with = "required"')
    return {
      name,
      type,
      patch,
      attributes: `#[serde(${serde.join(', ')})]\n${recursive(owner) === true ? '#[borsh(bound(serialize = "", deserialize = ""))]\n' : ''}`,
    }
  }
  const derive =
    '#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, borsh::BorshSerialize, borsh::BorshDeserialize)]\n#[borsh(crate = "borsh")]'
  const emitDefinition = ({
    wireName,
    definition,
  }: {
    wireName: string
    definition: Definition
  }): string => {
    const name = rustNames[wireName]!
    const doc = `#[doc = ${literal(`${wireName} from contract ${ir.contract} (IR v${ir.irVersion}).`)}]\n`
    switch (definition.kind) {
      case 'string': {
        if (definition.pattern !== undefined)
          assertPortablePattern(
            definition.pattern,
            definition.flags ?? 'u',
            `$/defs/${wireName}/pattern`,
          )
        if (
          (definition.minLength !== undefined &&
            (Number.isSafeInteger(definition.minLength) === false || definition.minLength < 0)) ||
          (definition.maxLength !== undefined &&
            (Number.isSafeInteger(definition.maxLength) === false || definition.maxLength < 0)) ||
          (definition.minLength !== undefined &&
            definition.maxLength !== undefined &&
            definition.minLength > definition.maxLength)
        ) {
          reject(
            `$/defs/${name}`,
            'Invalid string length bounds',
            'Use nonnegative safe-integer bounds with minLength <= maxLength',
          )
        }
        const constraints: string[] = []
        if ((definition.minLength ?? 0) > 0 || definition.maxLength !== undefined) {
          // Count only as far as needed to decide admitted code-point bounds.
          const limit =
            definition.maxLength === undefined ? definition.minLength! : definition.maxLength + 1
          constraints.push(`let length = value.chars().take(${limit}).count();`)
          if ((definition.minLength ?? 0) > 0)
            constraints.push(
              `if length < ${definition.minLength} { return Err(ValidationError::new(${literal(name)}, "string shorter than minLength")); }`,
            )
          if (definition.maxLength !== undefined)
            constraints.push(
              `if length > ${definition.maxLength} { return Err(ValidationError::new(${literal(name)}, "string longer than maxLength")); }`,
            )
        }
        if (definition.pattern !== undefined) {
          const pattern = `${definition.flags === 'iu' ? '(?i)' : ''}${definition.pattern.slice(0, -1)}\\z`
          constraints.push(
            `static REGEX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(${literal(pattern)}).expect("admitted portable regex"));`,
          )
          constraints.push(
            `if !REGEX.is_match(&value) { return Err(ValidationError::new(${literal(name)}, ${literal(`string must match ${definition.pattern}`)})); }`,
          )
        }
        return `${doc}#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Deserialize, borsh::BorshSerialize)]
#[borsh(crate = "borsh")]
#[serde(try_from = "String")]
pub struct ${name}(String);
impl ${name} {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        ${constraints.join('\n        ')}
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str { &self.0 }
    pub fn into_inner(self) -> String { self.0 }
}
impl TryFrom<String> for ${name} { type Error = ValidationError; fn try_from(value: String) -> Result<Self, Self::Error> { Self::new(value) } }
impl TryFrom<&str> for ${name} { type Error = ValidationError; fn try_from(value: &str) -> Result<Self, Self::Error> { Self::new(value) } }
impl std::str::FromStr for ${name} { type Err = ValidationError; fn from_str(value: &str) -> Result<Self, Self::Err> { Self::new(value) } }
impl AsRef<str> for ${name} { fn as_ref(&self) -> &str { &self.0 } }
impl std::borrow::Borrow<str> for ${name} { fn borrow(&self) -> &str { &self.0 } }
impl std::fmt::Display for ${name} { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) } }
impl serde::Serialize for ${name} { fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> { serializer.serialize_str(&self.0) } }
impl borsh::BorshDeserialize for ${name} {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let value = <String as borsh::BorshDeserialize>::deserialize_reader(reader)?;
        Self::new(value).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }
}`
      }
      case 'literals': {
        if (
          definition.values.length === 0 ||
          new Set(definition.values).size !== definition.values.length
        )
          reject(
            `$/defs/${name}`,
            'Empty or duplicate literal enum',
            'Provide at least one distinct string literal',
          )
        if (definition.values.length > 256)
          reject(
            `$/defs/${name}`,
            'Borsh enum exceeds 256 variants',
            'Use at most 256 variants per contract enum',
          )
        const variants = variantNames(definition.values)
        return `${doc}#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize, borsh::BorshSerialize, borsh::BorshDeserialize)]\n#[borsh(crate = "borsh")]\npub enum ${name} {\n${definition.values.map((value, index) => `    #[serde(rename = ${literal(value)})]\n    ${variants[index]},`).join('\n')}\n}`
      }
      case 'alias': {
        const type = rustType({
          type: definition.type,
          owner: wireName,
          direct: true,
          path: `$/defs/${wireName}`,
        })
        const patch = resolveAlias({ type: definition.type }).kind === 'patch'
        return recursive(wireName) === true
          ? `${doc}${patch === true ? '#[derive(Default)]\n' : ''}${derive}\n#[serde(transparent)]\npub struct ${name}(#[borsh(bound(serialize = "", deserialize = ""))] pub ${type});${patch === true ? `\nimpl ${name} { pub fn is_absent(&self) -> bool { self.0.is_absent() } }` : ''}`
          : `${doc}pub type ${name} = ${type};`
      }
      case 'struct': {
        const seen = new Set<string>()
        const info = definition.fields.map((field) => {
          const value = fieldInfo({ field, owner: wireName })
          if (seen.has(value.name) === true)
            reject(
              `$/defs/${name}/${field.wire}`,
              'Field names collide after Rust normalization',
              'Choose distinct wire names after snake_case normalization',
            )
          seen.add(value.name)
          return value
        })
        const required = info.filter(
          (value, index) => definition.fields[index]!.presence === 'required' && !value.patch,
        )
        const initial = info.map((value, index) =>
          value.patch === true
            ? `${value.name}: Default::default()`
            : definition.fields[index]!.presence === 'optional'
              ? `${value.name}: None`
              : value.name,
        )
        const constructor =
          definition.nonExhaustive === true
            ? `\nimpl ${name} {\n    pub fn new(${required.map((value) => `${value.name}: ${value.type}`).join(', ')}) -> Self { Self { ${initial.join(', ')} } }\n${info
                .filter(
                  (value, index) =>
                    definition.fields[index]!.presence === 'optional' || value.patch,
                )
                .map(
                  (value) =>
                    `    pub fn with_${value.name.replace(/^r#/, '')}(mut self, value: ${value.type}) -> Self { self.${value.name} = value; self }`,
                )
                .join('\n')}\n}`
            : ''
        return `${doc}${derive}\n${definition.excess === 'ignore' ? '' : '#[serde(deny_unknown_fields)]\n'}${definition.nonExhaustive === true ? '#[non_exhaustive]\n' : ''}pub struct ${name} {\n${info.map((value) => `    ${value.attributes.replaceAll('\n', '\n    ')}pub ${value.name}: ${value.type},`).join('\n')}\n}${constructor}`
      }
      case 'taggedUnion': {
        if (
          definition.variants.length === 0 ||
          definition.variants.length > 256 ||
          new Set(definition.variants.map((variant) => variant.tag)).size !==
            definition.variants.length
        )
          reject(
            `$/defs/${name}`,
            'Empty, duplicate or oversized tagged union',
            'Provide 1-256 distinct tagged variants',
          )
        const variants = variantNames(definition.variants.map((variant) => variant.tag))
        const payloads = definition.variants.map((variant) => {
          const payload = ir.defs[variant.ref]
          if (payload?.kind !== 'struct')
            return reject(
              `$/defs/${name}/${variant.tag}`,
              'Tagged variant payload is not a struct',
              'Reference a struct definition for each variant',
            )
          if (payload.fields.some((field) => field.wire === definition.tagField) === true)
            reject(
              `$/defs/${name}/${variant.tag}`,
              'Discriminant collides with payload field',
              'Remove the tag field from the variant payload; the union emits it',
            )
          return rustNames[variant.ref]!
        })
        const uniquePayloads = new Set<string>()
        const conversions = definition.variants.flatMap((variant, index) => {
          if (uniquePayloads.has(variant.ref) === true) return []
          uniquePayloads.add(variant.ref)
          return [
            `impl From<${rustNames[variant.ref]}> for ${name} { fn from(value: ${rustNames[variant.ref]}) -> Self { Self::${variants[index]}(value) } }`,
          ]
        })
        return `${doc}#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, borsh::BorshSerialize, borsh::BorshDeserialize)]
#[borsh(crate = "borsh")]
#[serde(tag = ${literal(definition.tagField)})]
${definition.nonExhaustive === true ? '#[non_exhaustive]\n' : ''}pub enum ${name} {
${definition.variants.map((variant, index) => `    #[serde(rename = ${literal(variant.tag)})]\n    ${variants[index]}(${recursive(wireName) === true ? '#[borsh(bound(serialize = "", deserialize = ""))] ' : ''}${payloads[index]}),`).join('\n')}
}
impl tagged::TaggedUnion for ${name} {
    const NAME: &'static str = ${literal(name)};
    const TAG_FIELD: &'static str = ${literal(definition.tagField)};
    const TAGS: &'static [&'static str] = &[${definition.variants.map((variant) => literal(variant.tag)).join(', ')}];
    fn deserialize_variant<'de, D: serde::Deserializer<'de>>(index: usize, payload: D) -> Result<Self, D::Error> {
        match index {
${definition.variants.map((_, index) => `            ${index} => <${payloads[index]} as serde::Deserialize>::deserialize(payload).map(Self::${variants[index]}),`).join('\n')}
            _ => Err(serde::de::Error::custom("invalid variant index")),
        }
    }
}
impl<'de> serde::Deserialize<'de> for ${name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> { tagged::deserialize(deserializer) }
}
${conversions.join('\n')}`
      }
    }
  }
  const tags = tagFields(ir)
  const tests = (options.vectors ?? []).map((vector, index) => {
    if (Object.hasOwn(ir.defs, vector.contract) === false)
      reject(
        `$/vectors/${index}/contract`,
        `Unknown vector contract ${vector.contract}`,
        'Use a named definition from this contract set',
      )
    const input = JSON.stringify(vector.input)
    if (input === undefined)
      reject(
        `$/vectors/${index}/input`,
        'Input is not JSON data',
        'Provide a JSON-compatible vector value',
      )
    const assertion =
      vector.accept === true
        ? `let value = result.expect(${literal(`${vector.contract}/${vector.name} must accept`)});\n        assert_eq!(encode_json(&value).unwrap(), ${literal(canonicalJson(vector.canonical ?? vector.input, tags))});\n        let frame = encode_frame(&value, 0x12345678, 1).unwrap();\n        let binary: ${rustNames[vector.contract]} = decode_frame(&frame, 0x12345678, 1).unwrap();\n        assert_eq!(binary, value);`
        : `assert!(result.is_err(), ${literal(`${vector.contract}/${vector.name} must reject`)});`
    return `    #[test]\n    fn vector_${index}_${fieldName(vector.name).replace(/^r#/, '')}() {\n        let result = decode_json::<${rustNames[vector.contract]}>(${literal(input)});\n        ${assertion}\n    }`
  })
  const cargoToml = `[package]\nname = ${literal(crateName)}\nversion = "0.1.0"\nedition = "2024"\npublish = false\n\n[workspace]\n\n[dependencies]\nserde = { version = "1.0.228", features = ["derive"] }\nserde_json = { version = "1", features = ["unbounded_depth"] }\n${features.timestamp ? 'chrono = { version = "0.4", default-features = false, features = ["std"] }\n' : ''}${features.regex ? 'regex = "1"\n' : ''}serde_path_to_error = "0.1.20"\nborsh = { version = "1.5", features = ["derive", "de_strict_order"] }\n`
  return {
    cargoToml,
    source: `// Generated by @overeng/effect-rust emitRust from contract ${ir.contract.replaceAll('\n', ' ')}; IR v${ir.irVersion}.\n${rustSupport(features)}\nconst TAG_FIELDS: &[&str] = &[${tags.map(literal).join(', ')}];\n\n${entries.map(([name, definition]) => emitDefinition({ wireName: name, definition })).join('\n\n')}\n${tests.length === 0 ? '' : `\n#[cfg(test)]\nmod contract_vectors {\n    use super::*;\n${tests.join('\n\n')}\n}\n`}`,
  }
}
