"""Unit test for scripts/generate_models_dev.py over a checked-in catalog excerpt."""

import json
import os
import unittest

from scripts.generate_models_dev import generate_models, regenerate

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "models_dev_excerpt.json")
BASE_URL = "https://opencode.ai/zen/go/v1"

SHELL = json.dumps(
    {
        "opencode-go": {
            "credential": "api_key",
            "protocol": "chat_completions",
            "base_url": BASE_URL,
            "billing": "subscription",
            "models": {
                "keep-chat": {
                    "protocol": "responses",
                    "context_window": 1,
                    "compat": {"reasoning_replay": True},
                }
            },
        }
    }
)


def load_provider():
    with open(FIXTURE, "r", encoding="utf-8") as handle:
        return json.load(handle)["providers"]["opencode-go"]


class GenerateModelsDevTest(unittest.TestCase):
    def test_npm_mappings(self):
        entries, skipped = generate_models(load_provider(), BASE_URL)
        self.assertEqual(entries["keep-chat"]["protocol"], "chat_completions")
        # The model's own [provider].npm wins over the provider's npm.
        self.assertEqual(entries["keep-responses"]["protocol"], "responses")
        self.assertEqual(
            entries["keep-chat"],
            {
                "protocol": "chat_completions",
                "context_window": 1000000,
                "output_limit": 131072,
                "input_modalities": ["text", "image"],
                "reasoning": True,
                "price_input": 0.15,
                "price_output": 0.6,
                "price_cache_read": 0.003,
            },
        )
        # Sparse catalog entries produce sparse generated entries.
        self.assertEqual(entries["minimal"], {"protocol": "chat_completions"})
        self.assertNotIn("skip-anthropic", entries)
        self.assertNotIn("skip-google", entries)

    def test_per_model_api_override(self):
        entries, _ = generate_models(load_provider(), BASE_URL)
        self.assertEqual(entries["per-model-api"]["base_url"], "https://other.test/v1")
        self.assertNotIn("base_url", entries["keep-chat"])

    def test_skipped_protocol_report(self):
        _, skipped = generate_models(load_provider(), BASE_URL)
        self.assertEqual(
            skipped,
            [
                "skip-anthropic (@ai-sdk/anthropic maps to Anthropic Messages, no adapter yet)",
                "skip-google (@ai-sdk/google maps to Google Generative AI, no adapter yet)",
            ],
        )

    def test_rerun_is_a_fixpoint_and_keeps_hand_set_compat(self):
        with open(FIXTURE, "r", encoding="utf-8") as handle:
            catalog = json.load(handle)
        first, _ = regenerate(catalog, "opencode-go", SHELL)
        second, _ = regenerate(catalog, "opencode-go", first)
        self.assertEqual(first, second)
        models = json.loads(first)["opencode-go"]["models"]
        # Generated keys are replaced; the hand-set compat flag survives.
        self.assertEqual(models["keep-chat"]["protocol"], "chat_completions")
        self.assertEqual(models["keep-chat"]["context_window"], 1000000)
        self.assertEqual(models["keep-chat"]["compat"], {"reasoning_replay": True})
        # The connection shell is untouched.
        connection = json.loads(first)["opencode-go"]
        self.assertEqual(connection["credential"], "api_key")
        self.assertEqual(connection["base_url"], BASE_URL)

    def test_unknown_provider_fails_loud(self):
        with open(FIXTURE, "r", encoding="utf-8") as handle:
            catalog = json.load(handle)
        del catalog["providers"]["opencode-go"]
        with self.assertRaises(ValueError):
            regenerate(catalog, "opencode-go", SHELL)


if __name__ == "__main__":
    unittest.main()
