// `sqlx::migrate!` embeds `migrations/` at compile time; rebuild when it changes.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
