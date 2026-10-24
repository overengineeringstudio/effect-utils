//! Portable work-storage v1 manifest reader.
//!
//! The launcher supplies the factory observation. This crate neither probes provider
//! state nor creates directories, changes the environment, or interprets providers.
//! Additive struct fields are ignored; undeclared path role names are rejected.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt, path::Path};

/// The normative, language-neutral manifest schema.
pub const PROTOCOL_SCHEMA: &str = include_str!(concat!(env!("OUT_DIR"), "/protocol.schema.json"));
/// A declared storage role, independent of any provider implementation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    State,
    Cache,
    Data,
    Runtime,
    Checkouts,
    Credentials,
}

impl Purpose {
    /// Returns the wire spelling of this role.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::Cache => "cache",
            Self::Data => "data",
            Self::Runtime => "runtime",
            Self::Checkouts => "checkouts",
            Self::Credentials => "credentials",
        }
    }
}

impl std::str::FromStr for Purpose {
    type Err = StorageError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "state" => Ok(Self::State),
            "cache" => Ok(Self::Cache),
            "data" => Ok(Self::Data),
            "runtime" => Ok(Self::Runtime),
            "checkouts" => Ok(Self::Checkouts),
            "credentials" => Ok(Self::Credentials),
            _ => Err(StorageError::UnknownPurpose),
        }
    }
}

/// Provider tags are descriptive, not executable instructions.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Apfs,
    Zfs,
    Fixture,
}

/// Validated provider metadata from a manifest.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Provider {
    #[serde(deserialize_with = "deserialize_provider_kind")]
    pub kind: ProviderKind,
    pub root: String,
    pub identity: String,
}

fn deserialize_provider_kind<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ProviderKind, D::Error> {
    struct KindVisitor;

    impl serde::de::Visitor<'_> for KindVisitor {
        type Value = ProviderKind;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("apfs, zfs, or fixture")
        }

        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<ProviderKind, E> {
            match value {
                "apfs" => Ok(ProviderKind::Apfs),
                "zfs" => Ok(ProviderKind::Zfs),
                "fixture" => Ok(ProviderKind::Fixture),
                _ => Err(E::custom("unknown provider kind")),
            }
        }
    }

    deserializer.deserialize_str(KindVisitor)
}

/// A manifest validated against the v1 contract on deserialization.
///
/// Fields are read-only through accessors so admission cannot observe a manifest
/// mutated after validation. Paths are absolute wire strings, not host-native paths.
#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "Object<ManifestWire>")]
pub struct Manifest {
    app: String,
    provider: Provider,
    paths: BTreeMap<Purpose, String>,
    environment: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct ManifestWire {
    version: serde_json::Number,
    app: String,
    #[serde(deserialize_with = "deserialize_object")]
    provider: Provider,
    paths: BTreeMap<Purpose, String>,
    environment: BTreeMap<String, String>,
}

impl TryFrom<Object<ManifestWire>> for Manifest {
    type Error = StorageError;

    fn try_from(Object(wire): Object<ManifestWire>) -> Result<Self, Self::Error> {
        // JSON Schema integer semantics include numeric spellings such as 1.0.
        let valid_app = wire
            .app
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_lowercase)
            && wire
                .app
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
        if wire.version.as_f64() != Some(1.0)
            || !valid_app
            || !canonical_path(&wire.provider.root)
            || wire.provider.identity.is_empty()
            || wire.paths.values().any(|path| !canonical_path(path))
        {
            return Err(StorageError::InvalidManifest);
        }
        Ok(Self {
            app: wire.app,
            provider: wire.provider,
            paths: wire.paths,
            environment: wire.environment,
        })
    }
}

fn canonical_path(path: &str) -> bool {
    path == "/"
        || (path.starts_with('/')
            && !path.contains('\0')
            && path[1..]
                .split('/')
                .all(|segment| !matches!(segment, "" | "." | "..")))
}

impl Manifest {
    /// Decodes JSON and validates the complete manifest before admission.
    ///
    /// # Errors
    /// Returns `InvalidManifest` for malformed JSON or a contract violation.
    pub fn from_json(json: &str) -> Result<Self, StorageError> {
        serde_json::from_str(json).map_err(|_| StorageError::InvalidManifest)
    }

    #[must_use]
    pub fn app(&self) -> &str {
        &self.app
    }

    #[must_use]
    pub const fn provider(&self) -> &Provider {
        &self.provider
    }

    #[must_use]
    pub fn paths(&self) -> &BTreeMap<Purpose, String> {
        &self.paths
    }

    #[must_use]
    pub fn environment(&self) -> &BTreeMap<String, String> {
        &self.environment
    }
}

/// Provider presence and identity supplied by the gated launcher, not probed here.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Observation {
    pub present: bool,
    pub identity: String,
}

/// The complete portable request. Malformed observations are decode failures.
#[derive(Clone, Debug, Deserialize)]
#[serde(from = "Object<RequestWire>")]
pub struct Request {
    pub manifest: Manifest,
    pub observed: Observation,
    pub purpose: String,
}

#[derive(Deserialize)]
struct RequestWire {
    manifest: Manifest,
    #[serde(deserialize_with = "deserialize_object")]
    observed: Observation,
    purpose: String,
}

impl From<Object<RequestWire>> for Request {
    fn from(Object(wire): Object<RequestWire>) -> Self {
        Self {
            manifest: wire.manifest,
            observed: wire.observed,
            purpose: wire.purpose,
        }
    }
}

// Serde's default struct decoder also accepts sequences. The wire contract admits
// JSON objects only, so constrain that entry shape without building a JSON tree.
struct Object<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_object(deserializer).map(Self)
    }
}

fn deserialize_object<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct ObjectVisitor<T>(std::marker::PhantomData<T>);

    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for ObjectVisitor<T> {
        type Value = T;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an object")
        }

        fn visit_map<M: serde::de::MapAccess<'de>>(self, map: M) -> Result<T, M::Error> {
            T::deserialize(serde::de::value::MapAccessDeserializer::new(map))
        }
    }

    deserializer.deserialize_map(ObjectVisitor(std::marker::PhantomData))
}

/// Stable wire error codes, in validation/admission/resolution precedence order.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StorageError {
    InvalidManifest,
    FactoryAbsent,
    IdentityMismatch,
    UnknownPurpose,
    UndeclaredPurpose,
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidManifest => "InvalidManifest",
            Self::FactoryAbsent => "FactoryAbsent",
            Self::IdentityMismatch => "IdentityMismatch",
            Self::UnknownPurpose => "UnknownPurpose",
            Self::UndeclaredPurpose => "UndeclaredPurpose",
        })
    }
}

impl std::error::Error for StorageError {}

/// Exactly one of the wire response fields `ok` and `error`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Response {
    Ok(String),
    Error(StorageError),
}

/// An admitted manifest whose observation matched the declared provider identity.
#[derive(Clone, Debug)]
pub struct WorkStorage(Manifest);

impl WorkStorage {
    /// Admits an already validated manifest without any filesystem access.
    ///
    /// # Errors
    /// Returns `FactoryAbsent` before checking for `IdentityMismatch`.
    pub fn admit(manifest: Manifest, observed: &Observation) -> Result<Self, StorageError> {
        if !observed.present {
            return Err(StorageError::FactoryAbsent);
        }
        if observed.identity != manifest.provider.identity {
            return Err(StorageError::IdentityMismatch);
        }
        Ok(Self(manifest))
    }

    /// Resolves a typed role without probing or normalizing its declared path.
    ///
    /// # Errors
    /// Returns `UndeclaredPurpose` if this manifest does not declare the role.
    pub fn role(&self, purpose: Purpose) -> Result<&str, StorageError> {
        self.0
            .paths
            .get(&purpose)
            .map(String::as_str)
            .ok_or(StorageError::UndeclaredPurpose)
    }

    /// Resolves a wire role name after factory admission.
    ///
    /// # Errors
    /// Returns `UnknownPurpose` or `UndeclaredPurpose`.
    pub fn resolve(&self, purpose: &str) -> Result<&str, StorageError> {
        self.role(purpose.parse()?)
    }

    #[must_use]
    pub const fn manifest(&self) -> &Manifest {
        &self.0
    }

    #[must_use]
    pub fn environment(&self) -> &BTreeMap<String, String> {
        self.0.environment()
    }
}

/// Resolves a fully decoded request in the normative error order.
///
/// # Errors
/// Returns a factory admission or purpose resolution error.
pub fn resolve_request(request: Request) -> Result<String, StorageError> {
    let mut storage = WorkStorage::admit(request.manifest, &request.observed)?;
    let purpose = request.purpose.parse::<Purpose>()?;
    storage
        .0
        .paths
        .remove(&purpose)
        .ok_or(StorageError::UndeclaredPurpose)
}

/// Decodes the entire request before admission and returns the portable wire response.
/// Malformed requests, observations, and manifests all produce `InvalidManifest`.
#[must_use]
pub fn resolve_json(json: &str) -> Response {
    match serde_json::from_str::<Request>(json)
        .map_err(|_| StorageError::InvalidManifest)
        .and_then(resolve_request)
    {
        Ok(path) => Response::Ok(path),
        Err(error) => Response::Error(error),
    }
}

/// Distinguishes manifest file access failures from invalid manifest contents.
#[derive(Debug)]
pub enum ReadManifestError {
    Io(std::io::Error),
    InvalidManifest,
}

impl fmt::Display for ReadManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "reading work-storage manifest: {error}"),
            Self::InvalidManifest => f.write_str("InvalidManifest"),
        }
    }
}

impl std::error::Error for ReadManifestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidManifest => None,
        }
    }
}

/// Reads only the selected manifest file. No provider or role path is accessed.
///
/// # Errors
/// Returns `Io` for file access errors and `InvalidManifest` for invalid contents.
pub fn read_manifest(path: impl AsRef<Path>) -> Result<Manifest, ReadManifestError> {
    let bytes = std::fs::read(path).map_err(ReadManifestError::Io)?;
    serde_json::from_slice(&bytes).map_err(|_| ReadManifestError::InvalidManifest)
}
