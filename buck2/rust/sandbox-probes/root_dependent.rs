const ROOT_INPUT: &str = include_str!(concat!(env!("PWD"), "/q42-root-dependent.txt"));

fn main() {
    println!("{ROOT_INPUT}");
}
