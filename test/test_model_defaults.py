"""Offline defaults tests. Every writable target is an explicit temporary directory."""
from contextlib import contextmanager, ExitStack
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/config-new-codey-machine"
sys.path.insert(0, str(SKILL / "scripts"))
from codey_node.common import config_defaults as defaults, config_files as files, toml_edit
from codey_node.common.errors import SetupError

ACTIVE_KEY = "new-gateway-key-unit-test-not-a-real-credential"
OLD_KEY = "controller-old-gateway-key-do-not-copy"


def fixture_owner(home):
    identity = files.windows_owner(home) if os.name == "nt" else os.getuid()
    return files.Owner(home, identity)


def tree(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


@contextmanager
def fixture(*, config=None, gateway=True):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        home = root / "target-owner"
        home.mkdir(mode=0o700)
        codex = home / "custom codex 中文"
        codex.mkdir(mode=0o700)
        if config is not None:
            (codex / "config.toml").write_bytes(config if isinstance(config, bytes) else config.encode())
        (codex / "auth.json").write_bytes(b'{"credential":"untouched-auth-fixture"}\n')
        gateway_path = home / "new-runtime/data/copilot-api/config.json"
        if gateway:
            gateway_path.parent.mkdir(parents=True, mode=0o700)
            gateway_path.write_text(json.dumps({
                "auth": {"apiKeys": [ACTIVE_KEY], "adminApiKey": "private-admin-fixture",
                         "sessionHistoryApiKey": "private-history-fixture"},
                "providers": {"example": {"apiKey": "keep-provider-secret", "models": {"custom": {"enabled": True}}}},
                "extraPrompts": {"custom": "Preserve even \\\"quotes\\\", unicode 中文 and \\n newlines"},
                "upstreamTransport": {"headersTimeoutMs": 123456},
            }, indent=2), encoding="utf-8")
        provider = home / "node-config/provider.env"
        kwargs = dict(owner=fixture_owner(home), codex_home=codex, copilot_api_config=gateway_path,
                      provider_env_file=provider)
        yield SimpleNamespace(root=root, home=home, codex=codex, gateway=gateway_path,
                              provider=provider, kwargs=kwargs)


class TomlMergeTests(unittest.TestCase):
    updates = {("model",): "gpt-6-astra", ("model_context_window",): 872000,
               ("model_providers", "copilot_api", "env_key"): "CODEY_MODEL_API_KEY",
               ("model_providers", "copilot_api", "supports_websockets"): False,
               ("features", "remote_compaction_v2"): True}

    def check_merge(self, text):
        before = tomllib.loads(text)
        expected = deepcopy(before)
        for key, value in self.updates.items():
            target = expected
            for part in key[:-1]:
                target = target.setdefault(part, {})
            target[key[-1]] = value
        after = toml_edit.merge(text, self.updates)
        self.assertTrue(toml_edit.same(tomllib.loads(after), expected))
        self.assertEqual(toml_edit.merge(after, self.updates), after)
        return after

    def test_comments_and_unrelated_projects_mcp_credentials_are_byte_preserved(self):
        unrelated = '''
[mcp_servers."quoted.name"]
command = "python"
args = ["secret-fixture", "--stdio"]
env = { CREDENTIAL = "not-a-real-secret" }
[projects.'C:\\work\\mine']
trust_level = "trusted"
[model_providers.other]
env_key = "OTHER_TOKEN"
'''
        text = '# owner preferences\nmodel = "old" # keep this comment\n' + unrelated
        after = self.check_merge(text)
        self.assertIn(unrelated, after)
        self.assertIn('model = "gpt-6-astra" # keep this comment', after)
        self.assertTrue(after.startswith("# owner preferences\n"))

    def test_quoted_dotted_inline_and_implicit_tables(self):
        for text in [
            'model_providers.copilot_api.env_key = "OLD"\nfeatures.keep = true\n',
            '["model_providers".\'copilot_api\']\n"env_key" = "OLD"\n[features]\nkeep = 4\n',
            '[model_providers]\ncopilot_api = { env_key = "OLD", auth = { key = "KEEP" } }\n',
            'model_providers = { copilot_api = { env_key = "OLD", extra = [1,2] }, other = { token = "KEEP" } }\n'
            'features = { keep = true, remote_compaction_v2 = false }\n',
            '[model_providers.copilot_api.auth]\ncommand = "cat"\nargs = ["/owner/key"]\n',
            '[model_providers.copilot_api.auth]\ncommand = "cat"\n[model_providers]\nother = { token = "KEEP" }\n',
            'features.remote_compaction_v2 = false\n[features.extra]\nkeep = "value"\n',
            '[[unrelated]]\nvalue = 1\n[[unrelated]]\nvalue = 2\n[unrelated.extra]\nvalue = 3\n',
        ]:
            with self.subTest(text=text):
                self.check_merge(text)

    def test_multiline_strings_arrays_and_embedded_fake_settings_are_not_touched(self):
        values = [
            "prompt = '''\n[features]\nremote_compaction_v2 = false\nmodel = \"fake\"\n'''\n",
            'prompt = """escaped \\" quotes\n[model_providers.copilot_api]\nenv_key = \'fake\'\n"""\n',
            'prompt = """four quotes at end""""\n',
            'prompt = """five quotes at end"""""\n',
            'prompt = """continued \\\n   string"""\n',
            'args = [\n"model = fake", # end-of-line\n{ key = "[features]" },\n]\n',
            "literal = 'literal \\\" backslash'\n",
        ]
        for text in values:
            with self.subTest(text=text):
                after = self.check_merge(text)
                self.assertTrue(after.startswith(text))

    def test_dates_nonfinite_floats_and_crlf_survive_inline_rewrite(self):
        text = ('model_providers = { copilot_api = { env_key = "OLD", stamp = 2026-09-10T01:02:03Z, '
                'date = 2026-09-10, time = 01:02:03, nan = nan, infinity = +inf } }\r\n')
        after = self.check_merge(text)
        self.assertNotIn("\n", after.replace("\r\n", ""))

    def test_ambiguous_or_invalid_toml_is_not_rewritten(self):
        for text in [
            'model = "one"\nmodel = "two"\n', 'model = """unclosed',
            'features = ["wrong-type"]\n', 'model_providers = "wrong-type"\n',
            '[model]\nsecret = "must-not-be-destroyed"\n', '[[model_providers.copilot_api]]\nname = "array"\n',
        ]:
            with self.subTest(text=text), self.assertRaises(SetupError):
                toml_edit.merge(text, self.updates)


class DefaultsTests(unittest.TestCase):
    def test_public_catalog_has_exact_pin_three_models_and_no_credentials(self):
        data = defaults.catalog(SKILL)
        self.assertEqual(len(data), 7969)
        self.assertEqual(hashlib.sha256(data).hexdigest(), defaults.CATALOG_SHA256)
        value = json.loads(data)
        self.assertEqual(set(value), {"models"})
        self.assertEqual(tuple(model["slug"] for model in value["models"]), defaults.MODELS)
        forbidden = {"key", "apikey", "token", "accesstoken", "refreshtoken", "password", "credential",
                     "credentials", "secret", "auth", "authorization", "githubtoken"}
        def inspect(item):
            if isinstance(item, dict):
                for key, child in item.items():
                    self.assertNotIn(re.sub("[^a-z]", "", key.lower()), forbidden)
                    inspect(child)
            elif isinstance(item, list):
                for child in item:
                    inspect(child)
        inspect(value)
        self.assertNotRegex(data.decode(), r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|"
                            r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)")

    def test_plan_is_read_only_and_reports_only_approved_values_not_credentials(self):
        with fixture(config='model = "old-model"\n') as f:
            before = tree(f.root)
            with patch.dict(os.environ, {defaults.MODEL_KEY: OLD_KEY}):
                plan = defaults.prepare(**f.kwargs)
            report = plan.report()
            self.assertEqual(tree(f.root), before)
            self.assertFalse(report["applied"])
            self.assertEqual(report["codexSettings"]["sandbox_mode"], "danger-full-access")
            self.assertEqual(report["codexSettings"]["approval_policy"], "never")
            self.assertEqual(report["gatewayConfig"], str(f.gateway))
            self.assertEqual(plan.provider_env[defaults.MODEL_KEY], ACTIVE_KEY)
            for secret in (ACTIVE_KEY, OLD_KEY, "private-admin-fixture", "private-history-fixture", "keep-provider-secret"):
                self.assertNotIn(secret, json.dumps(report))
                self.assertNotIn(secret, repr(plan))
                self.assertNotIn(secret, repr(plan.changes))

    def test_apply_merges_every_requested_value_and_preserves_auth_projects_mcp_provider_secrets(self):
        original = ('\ufeff# Preserve owner comments\r\nmodel = "old"\r\npersonality = "friendly"\r\n'
                    '[features]\r\ncustom = true\r\n'
                    '[model_providers.copilot_api]\r\nbase_url = "http://old-localhost"\r\n'
                    'auth = { command = "cat", args = ["existing-key-file"] }\r\n'
                    '[model_providers.other]\r\napi_key = "unrelated-provider-key"\r\n'
                    '[mcp_servers.example]\r\ncommand = "stdio-tool"\r\nenv = { TOKEN = "mcp-key" }\r\n'
                    '[projects."private-project"]\r\ntrust_level = "trusted"\r\n')
        with fixture(config=original.encode("utf-8")) as f:
            f.provider.parent.mkdir(mode=0o700)
            provider_original = '# Keep other credentials\nOTHER_KEY="untouched"\nCODEY_MODEL_API_KEY="old"\n'
            f.provider.write_text(provider_original)
            gateway_before = f.gateway.read_bytes()
            plan = defaults.prepare(**f.kwargs)
            report = plan.apply()
            raw = (f.codex / "config.toml").read_bytes()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf# Preserve owner comments\r\n"))
            self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))
            parsed = tomllib.loads(raw.decode("utf-8-sig"))
            before = tomllib.loads(original.lstrip("\ufeff"))
            expected = deepcopy(before)
            expected.update(defaults.CODEX_DEFAULTS, model_catalog_json=str(f.codex / "models.json"))
            expected["model_providers"]["copilot_api"].update(defaults.PROVIDER_DEFAULTS)
            expected["features"]["remote_compaction_v2"] = True
            self.assertEqual(parsed, expected)
            self.assertEqual((f.codex / "auth.json").read_bytes(), b'{"credential":"untouched-auth-fixture"}\n')
            self.assertEqual((f.codex / "models.json").read_bytes(), defaults.catalog(SKILL))
            self.assertEqual(json.loads(f.gateway.read_bytes()), {**json.loads(gateway_before), "useResponsesApiWebSocket": False})
            self.assertIn('OTHER_KEY="untouched"\n', f.provider.read_text())
            self.assertIn(json.dumps(ACTIVE_KEY), f.provider.read_text())
            self.assertNotIn('CODEY_MODEL_API_KEY="old"', f.provider.read_text())
            backup_bytes = {Path(path).read_bytes() for path in report["backups"]}
            self.assertIn(original.encode(), backup_bytes)
            self.assertIn(gateway_before, backup_bytes)
            self.assertEqual(len(report["backups"]), 3)
            if os.name != "nt":
                for item in [*report["backups"], *report["changedFiles"]]:
                    self.assertEqual(Path(item).stat().st_mode & 0o777, 0o600)

    def test_repeated_apply_preserves_all_bytes_mtimes_and_backup_count(self):
        with fixture(config='model = "old"\n') as f:
            defaults.prepare(**f.kwargs).apply()
            before = tree(f.root)
            mtimes = {path: path.stat().st_mtime_ns for path in f.root.rglob("*")}
            again = defaults.prepare(**f.kwargs)
            self.assertTrue(all(item["action"] == "unchanged" for item in again.report()["files"]))
            self.assertEqual(again.apply()["changedFiles"], [])
            self.assertEqual(again.apply()["backups"], [])
            self.assertEqual(tree(f.root), before)
            self.assertEqual({path: path.stat().st_mtime_ns for path in f.root.rglob("*")}, mtimes)

    def test_new_linux_gateway_is_single_key_and_never_imports_or_modifies_the_legacy_gateway(self):
        with fixture(gateway=False) as f:
            legacy = f.home / ".local/share/copilot-api/config.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text(json.dumps({"auth": {"apiKeys": [OLD_KEY]}, "useResponsesApiWebSocket": True}))
            before = legacy.read_bytes()
            with patch.dict(os.environ, {"COPILOT_API_HOME": str(legacy.parent), defaults.MODEL_KEY: OLD_KEY}):
                plan = defaults.prepare(**f.kwargs, new_gateway=True)
                self.assertFalse(f.gateway.exists())
                plan.apply()
            gateway = json.loads(f.gateway.read_bytes())
            self.assertFalse(gateway["useResponsesApiWebSocket"])
            self.assertEqual(len(gateway["auth"]["apiKeys"]), 1)
            key = gateway["auth"]["apiKeys"][0]
            self.assertNotEqual(key, OLD_KEY)
            self.assertEqual(len({key, gateway["auth"]["adminApiKey"], gateway["auth"]["sessionHistoryApiKey"]}), 3)
            self.assertIn(json.dumps(key), f.provider.read_text())
            self.assertEqual(legacy.read_bytes(), before)
            self.assertEqual(defaults.prepare(**f.kwargs, new_gateway=True).apply()["changedFiles"], [])

    def test_unknown_existing_gateway_is_an_explicit_blocker_even_if_legacy_or_env_paths_exist(self):
        with fixture(config='model = "old"\n') as f:
            before = tree(f.root)
            with patch.dict(os.environ, {"COPILOT_API_HOME": str(f.gateway.parent)}):
                plan = defaults.prepare(**{**f.kwargs, "copilot_api_config": None})
            self.assertTrue(plan.report()["requiredActions"])
            self.assertIsNone(plan.report()["gatewayConfig"])
            with self.assertRaisesRegex(SetupError, "--copilot-api-config"):
                plan.apply()
            self.assertEqual(tree(f.root), before)
        with fixture(gateway=False) as f:
            with self.assertRaisesRegex(SetupError, "missing"):
                defaults.prepare(**f.kwargs)

    def test_multiple_active_gateway_keys_require_explicit_selection_and_none_are_added_or_removed(self):
        with fixture() as f:
            value = json.loads(f.gateway.read_bytes())
            value["auth"]["apiKeys"].append("second-active-fixture-key")
            f.gateway.write_text(json.dumps(value))
            with self.assertRaisesRegex(SetupError, "--model-key-file"):
                defaults.prepare(**f.kwargs)
            selection = f.home / "selected.key"
            selection.write_text("second-active-fixture-key\n")
            plan = defaults.prepare(**f.kwargs, model_key_file=selection)
            plan.apply()
            self.assertEqual(json.loads(f.gateway.read_bytes())["auth"], value["auth"])
            self.assertIn('"second-active-fixture-key"', f.provider.read_text())
            selection.write_text(OLD_KEY)
            with self.assertRaisesRegex(SetupError, "not an active key"):
                defaults.prepare(**f.kwargs, model_key_file=selection)

    def test_json_merger_preserves_unknown_source_bytes_and_rejects_duplicate_keys(self):
        for text in ('{}', '{ \r\n }', '{"secret":"quoted\\\"fixture","keep":[1,true,{"x":"y"}]}',
                     '{ "keep" : 1 , "useResponsesApiWebSocket" : true, "auth":{"apiKeys":["keep"]}}',
                     '{"useResponsesApiWebSocket":false,"keep":null}'):
            with self.subTest(text=text):
                after = defaults.patch_gateway(text)
                self.assertEqual(json.loads(after), {**json.loads(text), "useResponsesApiWebSocket": False})
                self.assertEqual(defaults.patch_gateway(after), after)
                if '"keep"' in text:
                    self.assertIn(text[text.index('"keep"'):].split(",")[0].rstrip("}"), after)
        for text in ('{"auth":{"apiKeys":["one"],"apiKeys":["two"]}}', '{"useResponsesApiWebSocket":true,"useResponsesApiWebSocket":false}',
                     '{"keep":NaN}', '["not-an-object"]', "not-json", '{"useResponsesApiWebSocket":{"secret":"keep"}}'):
            with self.subTest(text=text), self.assertRaises(SetupError):
                defaults.patch_gateway(text)

    def test_provider_env_keeps_unrelated_multiline_credentials_and_refuses_duplicate_model_assignments(self):
        text = ('# Keep this comment\nMULTILINE="line1\nCODEY_MODEL_API_KEY=not-an-assignment\nline3"\n'
                "OTHER='one\ntwo'\nCODEY_MODEL_API_KEY=\"old\"\n")
        after = defaults.patch_provider_env(text, ACTIVE_KEY)
        self.assertIn('MULTILINE="line1\nCODEY_MODEL_API_KEY=not-an-assignment\nline3"\n', after)
        self.assertIn("OTHER='one\ntwo'\n", after)
        self.assertIn('CODEY_MODEL_API_KEY=' + json.dumps(ACTIVE_KEY), after)
        self.assertEqual(defaults.patch_provider_env(after, ACTIVE_KEY), after)
        for text in ('CODEY_MODEL_API_KEY=one\nCODEY_MODEL_API_KEY=two\n', 'OTHER="unterminated\n'):
            with self.assertRaises(SetupError):
                defaults.patch_provider_env(text, ACTIVE_KEY)
        for value in (ACTIVE_KEY, json.dumps(ACTIVE_KEY), "'" + ACTIVE_KEY + "'"):
            original = "# preserve original formatting\nCODEY_MODEL_API_KEY=" + value + "\n"
            self.assertEqual(defaults.patch_provider_env(original, ACTIVE_KEY), original)

    def test_unselected_profiles_are_preserved_but_active_conflicting_overrides_fail_closed(self):
        with fixture(config='[profiles.optional]\nmodel = "other-model"\n') as f:
            plan = defaults.prepare(**f.kwargs)
            plan.apply()
            self.assertEqual(tomllib.loads((f.codex / "config.toml").read_text())["profiles"],
                             {"optional": {"model": "other-model"}})
        with fixture(config='profile = "active"\n[profiles.active]\nmodel = "other-model"\n') as f:
            before = tree(f.root)
            with self.assertRaisesRegex(SetupError, "active Codex profile"):
                defaults.prepare(**f.kwargs)
            self.assertEqual(tree(f.root), before)

    def test_invalid_documents_or_catalog_fail_before_any_target_write(self):
        for content in ('model = "unterminated', 'features = ["not-a-table"]'):
            with fixture(config=content) as f:
                before = tree(f.root)
                with self.assertRaises(SetupError):
                    defaults.prepare(**f.kwargs)
                self.assertEqual(tree(f.root), before)
        with fixture() as f:
            f.gateway.write_text('{"auth":{"apiKeys":["private-line"],"apiKeys":[]}}')
            before = tree(f.root)
            with self.assertRaises(SetupError) as error:
                defaults.prepare(**f.kwargs)
            self.assertNotIn("private-line", str(error.exception))
            self.assertEqual(tree(f.root), before)
        with fixture() as f:
            fake_skill = f.home / "bad-skill"
            (fake_skill / "templates").mkdir(parents=True)
            (fake_skill / defaults.CATALOG_FILE).write_bytes(b'{"models":[]}')
            before = tree(f.root)
            with self.assertRaisesRegex(SetupError, "SHA-256"):
                defaults.prepare(fake_skill, **f.kwargs)
            self.assertEqual(tree(f.root), before)

    def test_codex_home_uses_target_home_or_explicit_target_not_the_controller_environment(self):
        with fixture() as f, patch.dict(os.environ, {"CODEX_HOME": str(f.codex)}):
            plan = defaults.prepare(**{**f.kwargs, "codex_home": None})
            self.assertEqual(plan.codex_home, f.codex)
        with fixture() as f, patch.dict(os.environ, {"CODEX_HOME": str(f.root / "controller-home")}):
            with self.assertRaisesRegex(SetupError, "outside the target"):
                defaults.prepare(**{**f.kwargs, "codex_home": None})
            self.assertEqual(defaults.prepare(**f.kwargs).codex_home, f.codex)
        with fixture() as f, patch.dict(os.environ, {"CODEX_HOME": ""}):
            self.assertEqual(defaults.prepare(**{**f.kwargs, "codex_home": None}).codex_home, f.home / ".codex")

    def test_only_approved_model_key_and_referenced_safe_header_environment_are_forwarded(self):
        value = {"model_providers": {"copilot_api": {"env_http_headers": {"X-Test": "CUSTOM_AUTH"}}}}
        with patch.dict(os.environ, {"CUSTOM_AUTH": "header-fixture", "UNRELATED_SECRET": "not-copied", defaults.MODEL_KEY: OLD_KEY}):
            result = defaults.provider_environment(value, ACTIVE_KEY)
        self.assertEqual(result, {defaults.MODEL_KEY: ACTIVE_KEY, "CUSTOM_AUTH": "header-fixture"})
        for name in ("NODE_OPTIONS", "CODEY_PORTAL_SSO_KEY", "CODEX_HOME", "HOME", "bad-name"):
            with self.subTest(name=name), self.assertRaises(SetupError):
                defaults.provider_environment({"model_providers": {"copilot_api": {"env_http_headers": {"X": name}}}}, ACTIVE_KEY)

    def test_cli_plan_and_apply_are_isolated_from_an_untrusted_cwd_and_environment(self):
        with fixture(config='model = "old"\n') as f:
            hostile = f.root / "cwd"
            hostile.mkdir()
            (hostile / "codey_node").mkdir()
            (hostile / "codey_node/__init__.py").write_text("raise RuntimeError('wrong import')")
            command = [sys.executable, "-I", "-B", str(SKILL / "scripts/codey.py"), "defaults",
                       "--owner-home", str(f.home), "--codex-home", str(f.codex),
                       "--copilot-api-config", str(f.gateway), "--provider-env-file", str(f.provider)]
            env = {**os.environ, "PYTHONPATH": str(hostile), "CODEX_HOME": str(f.root / "controller"),
                   "COPILOT_API_HOME": str(f.root / "legacy"), defaults.MODEL_KEY: OLD_KEY}
            before = tree(f.root)
            for extra in ([], ["--plan"]):
                result = subprocess.run(command + extra, cwd=hostile, env=env, text=True, capture_output=True, timeout=30)
                if os.name != "nt" and os.getuid() == 0:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("not root", result.stdout)
                    return
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                self.assertFalse(json.loads(result.stdout)["applied"])
                self.assertEqual(tree(f.root), before)
            for expected in (4, 0):
                result = subprocess.run(command + ["--apply"], cwd=hostile, env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                self.assertEqual(len(json.loads(result.stdout)["changedFiles"]), expected)
                for secret in (ACTIVE_KEY, OLD_KEY, "private-admin-fixture", "untouched-auth-fixture"):
                    self.assertNotIn(secret, result.stdout + result.stderr)
            self.assertFalse((f.root / "controller").exists())
            self.assertFalse((f.root / "legacy").exists())


class UserPermissionTests(unittest.TestCase):
    def test_a100_directory_layout_all_four_compliant_files_are_noop_without_chmod_or_acl_queries(self):
        with fixture() as f:
            home = f.home
            gateway = home / ".local/share/codey-machine/data/copilot-api/config.json"
            gateway.parent.mkdir(parents=True)
            gateway.write_bytes(f.gateway.read_bytes())
            kwargs = {**f.kwargs, "codex_home": home / ".codex", "copilot_api_config": gateway,
                      "provider_env_file": home / ".config/codey-machine/provider.env"}
            defaults.prepare(**kwargs).apply()  # Prepare compliant fixtures on the host OS.
            before = tree(home)
            actual_modes = {path: path.stat().st_mode for path in home.rglob("*")}
            modes = {home: 0o750, home / ".local": 0o700, home / ".local/share": 0o775, home / ".codex": 0o775}
            real_lstat, real_fstat = Path.lstat, os.fstat
            def metadata(info, path=None):
                fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode",
                          "st_uid", "st_gid", "st_nlink", "st_file_attributes", "st_birthtime_ns")
                result = SimpleNamespace(**{name: getattr(info, name) for name in fields if hasattr(info, name)})
                if path is None or path.is_relative_to(home):
                    result.st_uid = result.st_gid = 1000
                    result.st_mode = stat.S_IFMT(info.st_mode) | modes.get(path, 0o700 if stat.S_ISDIR(info.st_mode) else 0o600)
                result.st_ctime_ns = getattr(info, "st_birthtime_ns", info.st_ctime_ns)
                return result
            native = SimpleNamespace(**vars(os))
            native.name = "posix"
            native.getuid = native.geteuid = Mock(return_value=1000)
            native.chmod = Mock(side_effect=AssertionError("Directory permissions must not be changed"))
            native.listxattr = Mock(side_effect=AssertionError("ACLs are governed by the current user's OS permissions"))
            with ExitStack() as stack:
                stack.enter_context(patch.object(files, "os", native))
                stack.enter_context(patch.object(Path, "lstat", lambda path: metadata(real_lstat(path), path)))
                native.fstat = lambda descriptor: metadata(real_fstat(descriptor))
                create = stack.enter_context(patch.object(files, "_create", side_effect=AssertionError("No-op cannot write")))
                kwargs["owner"] = files.Owner(home, 1000)
                plan = defaults.prepare(**kwargs)
                self.assertEqual(len(plan.report()["files"]), 4)
                self.assertTrue(all(row["action"] == "unchanged" for row in plan.report()["files"]))
                report = plan.apply()
                self.assertEqual(report["changedFiles"], [])
                self.assertEqual(report["backups"], [])
                create.assert_not_called()
                modes[home / ".codex"] = 0o777
                self.assertTrue(all(row["action"] == "unchanged" for row in defaults.prepare(**kwargs).report()["files"]))
            native.chmod.assert_not_called()
            native.listxattr.assert_not_called()
            self.assertEqual(tree(home), before)
            self.assertEqual({path: path.stat().st_mode for path in home.rglob("*")}, actual_modes)


class PathAndAtomicTests(unittest.TestCase):
    def test_relative_traversal_and_overlapping_targets_are_rejected(self):
        with fixture() as f:
            for field, value in [("codex_home", "relative"), ("copilot_api_config", "config.json"),
                                 ("provider_env_file", "provider.env"), ("model_key_file", "key"),
                                 ("codex_home", f.home / "one/../escape")]:
                with self.subTest(field=field), self.assertRaises(SetupError):
                    defaults.prepare(**{**f.kwargs, field: value})
            for field, value in [("copilot_api_config", f.codex / "config.toml"),
                                 ("provider_env_file", f.codex / "models.json"),
                                 ("provider_env_file", f.gateway)]:
                with self.subTest(field=field), self.assertRaises(SetupError):
                    defaults.prepare(**{**f.kwargs, field: value})

    def test_input_only_credential_and_public_catalog_cannot_be_write_targets(self):
        with fixture() as f:
            f.provider.parent.mkdir()
            f.provider.write_text(ACTIVE_KEY)
            before = tree(f.root)
            with self.assertRaisesRegex(SetupError, "overlap"):
                defaults.prepare(**f.kwargs, model_key_file=f.provider)
            self.assertEqual(tree(f.root), before)
            with self.assertRaisesRegex(SetupError, "overlap"):
                defaults.prepare(**{**f.kwargs, "provider_env_file": None,
                                    "copilot_api_config": SKILL / defaults.CATALOG_FILE})
            self.assertEqual(defaults.catalog(SKILL), (SKILL / defaults.CATALOG_FILE).read_bytes())

    def test_hard_linked_config_or_gateway_is_rejected(self):
        with fixture(config='model = "keep"\n') as f:
            for file in (f.codex / "config.toml", f.gateway):
                link = file.with_name("hardlink-fixture")
                os.link(file, link)
                try:
                    with self.assertRaisesRegex(SetupError, "hard-linked"):
                        defaults.prepare(**f.kwargs)
                finally:
                    link.unlink()

    def test_file_and_parent_symlinks_including_dangling_links_are_rejected(self):
        with fixture() as f:
            linked = f.home / "linked"
            try:
                linked.symlink_to(f.codex, target_is_directory=True)
            except OSError:
                self.skipTest("This owner cannot create a temporary symbolic link")
            with self.assertRaisesRegex(SetupError, "linked"):
                defaults.prepare(**{**f.kwargs, "codex_home": linked})
            linked.unlink()
            linked.symlink_to(f.gateway)
            with self.assertRaisesRegex(SetupError, "linked"):
                defaults.prepare(**{**f.kwargs, "copilot_api_config": linked})
            linked.unlink()
            linked.symlink_to(f.home / "does-not-exist")
            with self.assertRaisesRegex(SetupError, "linked"):
                defaults.prepare(**{**f.kwargs, "copilot_api_config": linked})
            linked.unlink()

    def test_reparse_point_is_rejected_without_resolving_it(self):
        with fixture() as f:
            original = Path.lstat
            def lstat(path, *args, **kwargs):
                result = original(path, *args, **kwargs)
                if path == f.codex:
                    return SimpleNamespace(st_mode=result.st_mode, st_file_attributes=0x400)
                return result
            with patch.object(Path, "lstat", lstat), self.assertRaisesRegex(SetupError, "reparse"):
                defaults.prepare(**f.kwargs)

    def test_wrong_owner_is_rejected_for_existing_file_and_new_parent(self):
        with fixture() as f:
            for target in (f.gateway, f.codex):
                if os.name == "nt":
                    original = files.windows_owner
                    check = patch.object(files, "windows_owner", side_effect=lambda path: "S-1-5-21-999" if path == target else original(path))
                else:
                    original = Path.lstat
                    def lstat(path, *args, **kwargs):
                        info = original(path, *args, **kwargs)
                        return (SimpleNamespace(st_mode=info.st_mode, st_uid=os.getuid() + 1, st_nlink=info.st_nlink)
                                if path == target else info)
                    check = patch.object(Path, "lstat", lstat)
                with check, self.assertRaisesRegex(SetupError, "different owner"):
                    defaults.prepare(**f.kwargs)

    def test_owner_selection_rejects_elevation_root_and_effective_user_mismatch(self):
        if os.name == "nt":
            from codey_node.platforms.windows import owner
            with patch.object(owner, "owner_context", return_value={"sid": "test", "elevated": True}), self.assertRaises(SetupError):
                files.current_identity()
        else:
            for uid, euid in ((0, 0), (1000, 1001)):
                with patch.object(os, "getuid", return_value=uid), patch.object(os, "geteuid", return_value=euid), self.assertRaises(SetupError):
                    files.current_identity()

    def test_concurrent_edit_after_planning_is_preserved_without_any_backup_or_other_writes(self):
        with fixture(config='model = "old"\n') as f:
            plan = defaults.prepare(**f.kwargs)
            (f.codex / "config.toml").write_text('model = "owner-concurrent-edit"\n')
            before = tree(f.root)
            with self.assertRaisesRegex(SetupError, "changed since planning"):
                plan.apply()
            self.assertEqual(tree(f.root), before)

    def test_atomic_failure_restores_only_our_writes_and_keeps_private_backups(self):
        with fixture(config='model = "old"\n') as f:
            (f.codex / "models.json").write_bytes(b'{"models":["previous-catalog-fixture"]}')
            before = tree(f.root)
            plan = defaults.prepare(**f.kwargs)
            replace = files._replace
            count = 0
            def fail_second(source, destination):
                nonlocal count
                count += 1
                if count == 2:
                    raise OSError("injected atomic failure")
                replace(source, destination)
            with patch.object(files, "_replace", side_effect=fail_second), self.assertRaisesRegex(OSError, "atomic failure"):
                plan.apply()
            after = tree(f.root)
            self.assertEqual({key: value for key, value in after.items() if ".codey-defaults-" not in key}, before)
            self.assertEqual(len([name for name in after if name.endswith(".bak")]), 3)
            self.assertFalse(any(name.endswith((".next", ".restore")) for name in after))

    def test_rollback_never_discards_concurrent_owner_edits(self):
        with fixture(config='model = "old"\n') as f:
            plan = defaults.prepare(**f.kwargs)
            replace = files._replace
            def conflict(source, destination):
                if destination == f.codex / "config.toml":
                    (f.codex / "models.json").write_bytes(b"concurrent owner catalog")
                    raise OSError("injected failure after concurrent edit")
                replace(source, destination)
            with patch.object(files, "_replace", side_effect=conflict), self.assertRaises(OSError):
                plan.apply()
            self.assertEqual((f.codex / "models.json").read_bytes(), b"concurrent owner catalog")
            self.assertEqual((f.codex / "config.toml").read_text(), 'model = "old"\n')

    def test_windows_sharing_violation_retries_without_deleting_destination(self):
        if os.name != "nt":
            self.skipTest("Windows sharing violation")
        with fixture(config='model = "old"\n') as f:
            plan = defaults.prepare(**f.kwargs)
            real_replace, seen = os.replace, []
            def retry(source, destination):
                if destination == f.codex / "config.toml" and not seen:
                    seen.append(True)
                    self.assertEqual(destination.read_text(), 'model = "old"\n')
                    error = PermissionError("fixture sharing violation")
                    error.winerror = 32
                    raise error
                return real_replace(source, destination)
            with patch.object(files.os, "replace", side_effect=retry), patch.object(files.time, "sleep"):
                plan.apply()
            self.assertEqual(seen, [True])
            self.assertEqual(tomllib.loads((f.codex / "config.toml").read_text())["model"], "gpt-6-astra")


if __name__ == "__main__":
    unittest.main()
