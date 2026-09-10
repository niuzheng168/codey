"""Owner-login launchd jobs and periodic renewal definitions."""
from pathlib import Path
import plistlib
import sys


def launch_agent(label, mode, config, runtime_path):
    agent = {
        "Label": label, "ProgramArguments": [str(Path(sys.executable).resolve()), "-I", "-B", config["worker"], "--component", mode, "--config", str(runtime_path)],
        "RunAtLoad": True, "ProcessType": "Background", "ThrottleInterval": 60, "Umask": 63,
        "WorkingDirectory": config["releaseRoot"],
        "StandardOutPath": str(Path(config["configRoot"]) / (mode + ".log")),
        "StandardErrorPath": str(Path(config["configRoot"]) / (mode + ".log")),
    }
    if mode == "renew":
        agent["RunAtLoad"] = False
        agent["StartInterval"] = 300
        agent["KeepAlive"] = {"SuccessfulExit": False}
    else:
        agent["KeepAlive"] = True
    return plistlib.dumps(agent).decode()
