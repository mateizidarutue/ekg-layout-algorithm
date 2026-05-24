"""Smoke tests for pipeline.config_loader env-var expansion.

Run with:

    python -m unittest bep/tests/test_config_loader.py

The tests write small temporary YAML files and assert that environment
references are expanded correctly.
"""

import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

# Make `pipeline` importable regardless of where the test runner is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.config_loader import load_config, _expand_env  # noqa: E402


def _write_yaml(body: str) -> Path:
    tmp = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
    tmp.write(textwrap.dedent(body))
    tmp.close()
    return Path(tmp.name)


class EnvExpansionTests(unittest.TestCase):
    def test_literal_strings_pass_through(self):
        self.assertEqual(_expand_env("plain"), "plain")
        self.assertEqual(_expand_env(42), 42)
        self.assertEqual(_expand_env(None), None)

    def test_env_var_is_substituted(self):
        os.environ["EKG_TEST_VAR"] = "secret-value"
        try:
            self.assertEqual(_expand_env("${EKG_TEST_VAR}"), "secret-value")
        finally:
            del os.environ["EKG_TEST_VAR"]

    def test_missing_env_uses_default(self):
        os.environ.pop("EKG_NOT_SET", None)
        self.assertEqual(_expand_env("${EKG_NOT_SET:-fallback}"), "fallback")

    def test_missing_env_with_no_default_raises(self):
        os.environ.pop("EKG_NOT_SET", None)
        with self.assertRaises(ValueError) as cm:
            _expand_env("${EKG_NOT_SET}")
        self.assertIn("EKG_NOT_SET", str(cm.exception))

    def test_expansion_recurses_into_dicts_and_lists(self):
        os.environ["EKG_A"] = "alpha"
        os.environ["EKG_B"] = "beta"
        try:
            result = _expand_env({
                "x": "${EKG_A}",
                "nested": {"y": ["${EKG_B}", "literal", "${EKG_A}-${EKG_B}"]},
            })
            self.assertEqual(result["x"], "alpha")
            self.assertEqual(result["nested"]["y"], ["beta", "literal", "alpha-beta"])
        finally:
            del os.environ["EKG_A"]
            del os.environ["EKG_B"]


class LoadConfigTests(unittest.TestCase):
    def test_full_config_is_expanded(self):
        os.environ["EKG_TEST_PW"] = "neo4j-secret"
        try:
            path = _write_yaml("""
                neo4j:
                  uri: neo4j://127.0.0.1:7687
                  user: neo4j
                  password: ${EKG_TEST_PW}
                  default_database: bep
                datasets:
                  demo:
                    semantic_header: sh.json
                    database: demo
            """)
            cfg = load_config(str(path))
            self.assertEqual(cfg["neo4j"]["password"], "neo4j-secret")
            self.assertEqual(cfg["neo4j"]["user"], "neo4j")
            self.assertIn("demo", cfg["datasets"])
        finally:
            del os.environ["EKG_TEST_PW"]
            try:
                path.unlink()
            except Exception:
                pass

    def test_missing_neo4j_section_raises(self):
        path = _write_yaml("""
            datasets:
              demo:
                semantic_header: sh.json
                database: demo
        """)
        try:
            with self.assertRaises(ValueError):
                load_config(str(path))
        finally:
            path.unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
