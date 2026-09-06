"""Offline regression tests: fake keys only, and every helper call uses --dry-run."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

WORKSPACE = pathlib.Path(__file__).resolve().parent.parent
HELPER = WORKSPACE / "scripts/set-codey-voice-secrets.py"
FAKE_KEY = "fake-only-foundry-key-not-a-credential-1234567890"
SPEECH = "https://voice-test.cognitiveservices.azure.com/"


class VoiceSecretPlanTests(unittest.TestCase):
    def setUp(self):
        self.parent = (WORKSPACE / "artifacts" / "voice-secret-tests").resolve()
        self.parent.mkdir(parents=True, exist_ok=True)
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="case-", dir=self.parent)).resolve()
        self.env = self.root / ".env"

    def tearDown(self):
        # Windows cleanup is limited to this test's freshly created directory.
        resolved = self.root.resolve()
        self.assertTrue(resolved.is_relative_to(WORKSPACE.resolve()))
        self.assertEqual(resolved.parent, self.parent)
        self.assertTrue(resolved.name.startswith("case-"))
        self.assertFalse(self.root.is_symlink())
        shutil.rmtree(resolved)

    def invoke(self, content, *arguments):
        self.env.write_text(content, encoding="utf-8")
        before = self.env.read_bytes()
        bindings = self.root / "bindings.json"
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(HELPER), str(self.env), str(bindings),
             "--dry-run", *arguments],
            capture_output=True, text=True, timeout=15,
        )
        self.assertNotIn(FAKE_KEY, result.stdout + result.stderr)
        self.assertEqual(self.env.read_bytes(), before)
        self.assertFalse(bindings.exists(), "A dry run must not write bindings or call Azure")
        return result

    def aliases(self):
        return (
            "FOUNDRY_ENDPOINT=https://voice-test.services.ai.azure.com/api/projects/test\n"
            f"FOUNDRY_KEY={FAKE_KEY}\nSPEECH_ENDPOINT={SPEECH}\n"
        )

    def test_foundry_aliases_and_opted_in_mai15_normalize_without_exposing_the_key(self):
        result = self.invoke(self.aliases(), "--mai-model", "MAI-Transcribe-1.5", "--secret-suffix", "mai15-test")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        binding = dict(item.split("=", 1) for item in plan["bindings"])
        self.assertEqual(binding["AZURE_SPEECH_ENDPOINT"], SPEECH)
        self.assertEqual(binding["MAI_TRANSCRIBE_SPEECH_ENDPOINT"], SPEECH)
        self.assertEqual(binding["MAI_TRANSCRIBE_MODEL"], "MAI-Transcribe-1.5")
        self.assertEqual(binding["FOUNDRY_API_KEY"], "secretref:codey-voice-foundry-api-key-mai15-test")
        self.assertNotIn("FOUNDRY_KEY", binding)
        self.assertNotIn("SPEECH_ENDPOINT", binding)
        self.assertEqual(plan["updatedSecretNames"], ["codey-voice-foundry-api-key-mai15-test"])

    def test_mai_is_not_implicitly_enabled_by_a_speech_endpoint(self):
        result = self.invoke(self.aliases())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(name.startswith("MAI_") for name in json.loads(result.stdout)["environmentNames"]))

    def test_previous_canonical_names_remain_supported(self):
        result = self.invoke(
            f"FOUNDRY_ENDPOINT=https://voice-test.services.ai.azure.com/api/projects/test\nFOUNDRY_API_KEY={FAKE_KEY}\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["updatedSecretNames"], ["codey-voice-foundry-api-key"])

    def test_an_env_changed_since_the_probe_is_rejected(self):
        result = self.invoke(self.aliases(), "--expect-env-sha256", "0" * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed since verification", result.stderr)
        # The exact same bytes are accepted.
        expected = hashlib.sha256(self.env.read_bytes()).hexdigest()
        result = self.invoke(self.aliases(), "--expect-env-sha256", expected)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_different_mai_resource_cannot_borrow_the_foundry_key(self):
        result = self.invoke(
            self.aliases() + "MAI_TRANSCRIBE_SPEECH_ENDPOINT=https://other-resource.cognitiveservices.azure.com/\n",
            "--mai-model", "MAI-Transcribe-1.5",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires its own key", result.stderr)

    def test_bad_suffix_or_missing_speech_endpoint_is_rejected(self):
        result = self.invoke(self.aliases(), "--secret-suffix", "../invalid")
        self.assertNotEqual(result.returncode, 0)
        result = self.invoke(f"FOUNDRY_API_KEY={FAKE_KEY}\n", "--mai-model", "MAI-Transcribe-1.5")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("explicit Speech endpoint", result.stderr)


if __name__ == "__main__":
    unittest.main()
