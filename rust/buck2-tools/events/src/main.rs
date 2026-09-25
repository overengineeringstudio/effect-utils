fn main() {
    if let Err(error) = buck2_events::main_entry() {
        eprintln!("buck2-events: {error}");
        std::process::exit(1);
    }
}
