use example_library::{identity, Probe, Serialize};

#[derive(Probe, Serialize)]
#[serde(crate = "example_library::serde")]
struct ConsumerMarker;

fn assert_serializable<T: example_library::serde::Serialize>() {}

fn main() {
    assert_eq!(identity(ConsumerMarker::probe()), 42);
    assert_eq!(identity(String::from("closure")), "closure");
    assert_serializable::<ConsumerMarker>();
}
