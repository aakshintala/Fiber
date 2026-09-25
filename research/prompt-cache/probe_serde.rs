use std::collections::HashMap;
fn main() {
    // 1. A HashMap of tools, serialised as-is.
    let mut tools: HashMap<String, u32> = HashMap::new();
    for n in ["read", "write", "edit", "shell", "jobs", "handoff", "mcp__gh__issue", "delegate_spawn"] { tools.insert(n.into(), 0); }
    println!("hashmap: {}", serde_json::to_string(&tools).unwrap());
    // 2. Same MCP schema, keys in two orders, as a server might send after a reconnect.
    let a: serde_json::Value = serde_json::from_str(r#"{"type":"object","properties":{"b":{"type":"string"},"a":{"type":"integer"}},"required":["b"]}"#).unwrap();
    let b: serde_json::Value = serde_json::from_str(r#"{"required":["b"],"properties":{"a":{"type":"integer"},"b":{"type":"string"}},"type":"object"}"#).unwrap();
    let (sa, sb) = (serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
    println!("schema a: {sa}\nschema b: {sb}\nequal bytes: {}", sa == sb);
    // 3. Floats round-trip.
    let f: serde_json::Value = serde_json::from_str(r#"{"x":0.1,"y":1e21,"z":1.0}"#).unwrap();
    println!("floats: {}", serde_json::to_string(&f).unwrap());
}
