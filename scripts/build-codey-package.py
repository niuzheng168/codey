#!/usr/bin/env python3
"""Compile and npm-pack Codey without publishing or changing any running service."""
import argparse
import json
from codey_package import build_package


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-reviewed-diff", action="store_true")
    parser.add_argument("--node-dir", help="Use this existing Node distribution for the build")
    parser.add_argument("--keep-work", action="store_true")
    args = parser.parse_args()
    print(json.dumps(build_package(
        args.output, allow_reviewed_diff=args.allow_reviewed_diff,
        node_dir=args.node_dir, keep_work=args.keep_work,
    ), indent=2))
