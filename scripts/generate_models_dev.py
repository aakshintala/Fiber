#!/usr/bin/env python3
"""Regenerate embedded preset model entries from models.dev.

Reads https://models.dev/catalog.json (or a local snapshot of it) and rewrites
the ``models`` object of one embedded connection preset under
``src/protocols/presets/``. Each entry carries what the catalog supplies: id,
protocol, per-model base-URL override, context and output limits, input
modalities, reasoning, and prices. Nothing fetches models.dev at runtime; the
generated JSON is committed (#37 decisions 16 and 17).

Protocol comes from the model's ``[provider].npm``, falling back to the
provider's ``npm``: ``@ai-sdk/openai`` maps to Responses,
``@ai-sdk/anthropic`` to Anthropic Messages, ``@ai-sdk/google`` to Google
Generative AI, and anything else to Chat Completions (pi's
``packages/ai/scripts/generate-models.ts`` is the reference). A model whose
protocol has no adapter in the binary yet is left out and printed as skipped;
the preset regains those models when its adapter ticket reruns this script.

Only the ``models`` object is rewritten. The connection shell (credential,
default protocol, base URL, billing) and every per-model ``compat`` object are
hand-set and survive reruns byte for byte: generated keys are replaced,
everything else is preserved. Rerunning against the same catalog is a fixpoint.

Usage:
    python3 scripts/generate_models_dev.py [--catalog URL_OR_PATH]
                                           [--preset PRESET] [--root DIR]
"""

import argparse
import json
import os
import sys
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

CATALOG_URL = "https://models.dev/catalog.json"

# Presets this script may regenerate: preset name to models.dev provider id and
# preset file. Later presets get their own row with their own ticket.
PRESETS = {
    "opencode-go": {
        "provider": "opencode-go",
        "file": "src/protocols/presets/opencode-go.json",
    },
    "opencode-zen": {
        "provider": "opencode",
        "file": "src/protocols/presets/opencode-zen.json",
    },
}

# npm value to (fiber protocol, display protocol). Only protocols with an
# adapter in the binary (see Protocol in
# src/protocols/presets/connection.zig) are kept; the rest are skipped.
NPM_PROTOCOLS = {
    "@ai-sdk/openai": ("responses", "Responses"),
    "@ai-sdk/anthropic": ("anthropic-messages", "Anthropic Messages"),
    "@ai-sdk/google": ("google-generative-ai", "Google Generative AI"),
}
DEFAULT_PROTOCOL = ("chat_completions", "Chat Completions")
SUPPORTED_PROTOCOLS = {"responses", "chat_completions"}

# Model-entry keys this script owns. Every other key in a model entry (today:
# compat) is hand-set and preserved across reruns.
GENERATED_KEYS = {
    "protocol",
    "base_url",
    "context_window",
    "output_limit",
    "input_modalities",
    "reasoning",
    "price_input",
    "price_output",
    "price_cache_read",
    "price_cache_write",
}


def load_catalog(source: str) -> Dict[str, Any]:
    """Load the models.dev catalog from a URL or a local snapshot file."""
    if source.startswith(("http://", "https://")):
        request = urllib.request.Request(source, headers={"User-Agent": "fiber-modelsgen"})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    with open(source, "r", encoding="utf-8") as handle:
        return json.load(handle)


def check_object(value: Any, model_id: str, key: str) -> Dict[str, Any]:
    if value is not None and not isinstance(value, dict):
        raise ValueError("model %s: %s must be an object" % (model_id, key))
    return value or {}


def check_count(value: Any, model_id: str, key: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("model %s: %s must be a non-negative integer" % (model_id, key))
    return value


def check_price(value: Any, model_id: str, key: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValueError("model %s: %s must be a non-negative number" % (model_id, key))
    return float(value)


def generate_entry(
    model_id: str, model: Dict[str, Any], connection_base_url: Optional[str]
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Build one preset model entry. Returns (entry, skip_reason)."""
    provider_override = check_object(model.get("provider"), model_id, "provider")
    npm = provider_override.get("npm")
    protocol, display = NPM_PROTOCOLS.get(npm, DEFAULT_PROTOCOL)
    if protocol not in SUPPORTED_PROTOCOLS:
        return None, "%s (%s maps to %s, no adapter yet)" % (model_id, npm, display)

    entry: Dict[str, Any] = {"protocol": protocol}
    api = provider_override.get("api")
    if api and api != connection_base_url:
        entry["base_url"] = api

    limit = check_object(model.get("limit"), model_id, "limit")
    if "context" in limit:
        entry["context_window"] = check_count(limit["context"], model_id, "limit.context")
    if "output" in limit:
        entry["output_limit"] = check_count(limit["output"], model_id, "limit.output")

    modalities = check_object(model.get("modalities"), model_id, "modalities")
    if "input" in modalities:
        inputs = modalities["input"]
        if not isinstance(inputs, list) or any(not isinstance(m, str) for m in inputs):
            raise ValueError("model %s: modalities.input must be a list of strings" % model_id)
        entry["input_modalities"] = list(inputs)

    if "reasoning" in model:
        if not isinstance(model["reasoning"], bool):
            raise ValueError("model %s: reasoning must be a boolean" % model_id)
        entry["reasoning"] = model["reasoning"]

    cost = check_object(model.get("cost"), model_id, "cost")
    for catalog_key, entry_key in (
        ("input", "price_input"),
        ("output", "price_output"),
        ("cache_read", "price_cache_read"),
        ("cache_write", "price_cache_write"),
    ):
        if catalog_key in cost:
            entry[entry_key] = check_price(cost[catalog_key], model_id, "cost." + catalog_key)

    return entry, None


def generate_models(
    provider_catalog: Dict[str, Any], connection_base_url: Optional[str]
) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    """Generate entries for every model, sorted by id. Returns (entries, skipped)."""
    models = provider_catalog.get("models")
    if models is None:
        raise ValueError("provider models is missing")
    if not isinstance(models, dict):
        raise ValueError("provider models must be an object")
    provider_npm = provider_catalog.get("npm")
    entries: Dict[str, Dict[str, Any]] = {}
    skipped: List[str] = []
    for model_id in sorted(models):
        if not isinstance(models[model_id], dict):
            raise ValueError("model %s: entry must be an object" % model_id)
        model = dict(models[model_id])
        # A model's own [provider].npm wins; otherwise the provider's applies.
        provider_override = check_object(model.get("provider"), model_id, "provider")
        if "npm" not in provider_override and provider_npm:
            provider_override = dict(provider_override, npm=provider_npm)
            model["provider"] = provider_override
        entry, skip_reason = generate_entry(model_id, model, connection_base_url)
        if skip_reason is not None:
            skipped.append(skip_reason)
        else:
            entries[model_id] = entry or {}
    return entries, skipped


def render_preset(shell: Dict[str, Any], preset_name: str, entries: Dict[str, Dict[str, Any]]) -> str:
    """Merge generated entries over the hand-set shell. Shell keys keep their order."""
    connection = dict(shell[preset_name])
    models = connection.get("models") or {}
    merged = {}
    for model_id, generated in entries.items():
        existing = dict(models.get(model_id) or {})
        for key in GENERATED_KEYS:
            existing.pop(key, None)
        existing.update(generated)
        merged[model_id] = existing
    connection["models"] = merged
    return json.dumps({preset_name: connection}, indent=2) + "\n"


def regenerate(catalog: Dict[str, Any], preset_name: str, preset_text: str) -> Tuple[str, List[str]]:
    """Regenerate one preset from an already-loaded catalog and preset file text."""
    spec = PRESETS[preset_name]
    providers = catalog.get("providers") or {}
    if spec["provider"] not in providers:
        raise ValueError("catalog has no provider %r" % spec["provider"])
    shell = json.loads(preset_text)
    if preset_name not in shell:
        raise ValueError("preset file has no connection %r" % preset_name)
    connection_base_url = shell[preset_name].get("base_url")
    entries, skipped = generate_models(providers[spec["provider"]], connection_base_url)
    return render_preset(shell, preset_name, entries), skipped


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Regenerate preset model entries from models.dev.")
    parser.add_argument("--catalog", default=CATALOG_URL, help="catalog URL or local snapshot path")
    parser.add_argument("--preset", default="opencode-go", choices=sorted(PRESETS), help="preset to regenerate")
    parser.add_argument("--root", default=".", help="repository root")
    args = parser.parse_args(argv)

    spec = PRESETS[args.preset]
    path = os.path.join(args.root, spec["file"])
    catalog = load_catalog(args.catalog)
    with open(path, "r", encoding="utf-8") as handle:
        preset_text = handle.read()
    rendered, skipped = regenerate(catalog, args.preset, preset_text)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(rendered)
    model_count = len(json.loads(rendered)[args.preset]["models"])
    for line in skipped:
        print("skip: " + line)
    print("wrote %s (%d models, %d skipped)" % (spec["file"], model_count, len(skipped)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
