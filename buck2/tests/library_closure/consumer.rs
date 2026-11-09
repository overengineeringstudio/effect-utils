use example_library::{identity, Probe, Serialize};

#[derive(Probe, Serialize)]
#[serde(crate = "example_library::serde")]
struct ConsumerMarker;

fn assert_serializable<T: example_library::serde::Serialize>() {}

fn main() {
    assert_eq!(identity(ConsumerMarker::probe()), 42);
    assert_eq!(identity(String::from("closure")), "closure");
    assert_eq!(example_library::alternate_identity(43), 43);
    assert_serializable::<ConsumerMarker>();
}
